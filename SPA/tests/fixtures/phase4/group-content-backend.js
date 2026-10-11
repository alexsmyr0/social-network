// Stateful stand-in for the SN-B17 group-content extension, used only by tests.
// It extends the group model (membership generations, invitations, requests and
// their notices) with posts, drafts, comments, reactions, media and the content
// notices that depend on them, all decided by ONE predicate: a group post is
// readable by its current members only, a personal post follows the Phase 3
// audience rules, and the two are never OR-ed. Records use the pack's state
// format, so every approved case replays against it; `group-content-model.test.js`
// proves that before any UI result relies on it. It is never imported by
// `SPA/src` (a policy test enforces that).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readForm } from '../phase3/content-backend.js';
import { CLOCK, GroupBackend, loadGroupFixtures, mergeState } from './group-backend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PNG = readFileSync(path.join(ROOT, 'SPA/tests/fixtures/a07/avatar.png'));
const MAX_ID = Number.MAX_SAFE_INTEGER;
const NO_STORE = { 'Cache-Control': 'no-store' };
const IMAGE_MAX = 5 * 1024 * 1024;
const CONTENT_NOTICES = new Set([
	'post_like',
	'post_dislike',
	'comment',
	'comment_like',
	'comment_dislike',
]);

export { CLOCK, readForm };

export function pngBytes() {
	return new Uint8Array(PNG);
}

function reply(status, body = null, headers = {}) {
	return { status, headers: { ...NO_STORE, ...headers }, body };
}

function failure(status, code, fields, message) {
	const error = { code, message: message ?? 'Fixture error; clients branch on code' };
	if (code === 'NOT_FOUND') error.message = 'Not found';
	if (code === 'BAD_REQUEST') error.message = 'Bad request';
	if (code === 'VALIDATION_ERROR') error.message = 'Check the highlighted fields';
	if (code === 'STALE_CONTENT') error.message = 'Content changed; refresh and retry';
	if (fields) error.fields = fields;
	return reply(status, { error });
}

const notFound = () => failure(404, 'NOT_FOUND');
const badRequest = () => failure(400, 'BAD_REQUEST');
const invalid = (field, code) => failure(400, 'VALIDATION_ERROR', { [field]: code });

function parseId(text) {
	if (typeof text !== 'string' || !/^[1-9]\d*$/u.test(text)) return null;
	const id = Number(text);
	return id <= MAX_ID ? id : null;
}

const ROUTES = [
	['feed', /^\/api\/v1\/posts$/u, ['GET', 'POST']],
	['mine', /^\/api\/v1\/posts\/mine$/u, ['GET']],
	['liked', /^\/api\/v1\/posts\/(liked|disliked)$/u, ['GET']],
	['draft', /^\/api\/v1\/posts\/draft$/u, ['GET', 'POST']],
	['draftById', /^\/api\/v1\/posts\/draft\/([^/]+)$/u, ['PUT', 'DELETE']],
	['thread', /^\/api\/v1\/posts\/([^/]+)\/comments$/u, ['GET', 'POST']],
	['nav', /^\/api\/v1\/posts\/([^/]+)\/nav$/u, ['GET']],
	['postReaction', /^\/api\/v1\/posts\/([^/]+)\/(like|dislike)$/u, ['POST']],
	['post', /^\/api\/v1\/posts\/([^/]+)$/u, ['GET', 'PATCH', 'DELETE']],
	['commentReaction', /^\/api\/v1\/comments\/([^/]+)\/(like|dislike)$/u, ['POST']],
	['comment', /^\/api\/v1\/comments\/([^/]+)$/u, ['GET', 'PATCH', 'DELETE']],
	['categories', /^\/api\/v1\/categories$/u, ['GET']],
	['categoryView', /^\/api\/v1\/categories\/view$/u, ['GET']],
	['media', /^\/api\/v1\/media\/([^/]+)$/u, ['GET']],
	['legacyMedia', /^\/api\/v1\/static\/uploads\/.+$/u, ['GET']],
	['activity', /^\/api\/v1\/users\/activity$/u, ['GET']],
	['profileContent', /^\/api\/v1\/users\/([^/]+)\/(posts|comments)$/u, ['GET']],
];

function matchContent(pathname) {
	for (const [name, pattern, methods] of ROUTES) {
		const match = pattern.exec(pathname);
		if (match) return { name, params: match.slice(1), methods };
	}
	return null;
}

function normalizeText(value) {
	return value.replace(/\r\n/gu, '\n').trim();
}

function textProblem(value, field, max) {
	const text = normalizeText(value);
	if ([...text].length > max) return { error: 'TOO_LONG' };
	const checked = field === 'title' ? text : text.replace(/[\n\t]/gu, '');
	return /\p{Cc}/u.test(checked) ? { error: 'INVALID_TEXT' } : { text };
}

function imageKind(file) {
	const bytes = file.bytes;
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return 'image/png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8') return 'image/gif';
	return null;
}

const ARRAY_FIELDS = ['category_ids', 'selected_follower_ids'];
const NUMBER_FIELDS = ['expected_version', 'group_id', 'parent_comment_id'];
const BOOLEAN_FIELDS = ['remove_image', 'manual'];

// One multipart field → its JSON-equivalent value, or undefined when the
// structure is invalid. Arrays repeat; a single empty value clears an array.
function formValue(key, values) {
	if (ARRAY_FIELDS.includes(key)) {
		if (values.length === 1 && values[0] === '') return [];
		if (values.includes('')) return undefined;
		return values.map((value) => parseId(value) ?? Number.NaN);
	}
	if (values.length !== 1) return undefined;
	const [value] = values;
	if (NUMBER_FIELDS.includes(key)) {
		if (value === '' && key === 'parent_comment_id') return null;
		return parseId(value) ?? Number.NaN;
	}
	if (!BOOLEAN_FIELDS.includes(key)) return value;
	if (value !== 'true' && value !== 'false') return undefined;
	return value === 'true';
}

function bodyFields(payload) {
	if (payload.form) {
		const fields = {};
		for (const [key, values] of Object.entries(payload.form.fields)) {
			const value = formValue(key, values);
			if (value === undefined) return null;
			fields[key] = value;
		}
		return { fields, image: payload.form.image ?? null };
	}
	const fields = payload.json ?? {};
	if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null;
	return { fields, image: null };
}

const sortNewest = (items) =>
	[...items].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);

export class GroupContentBackend extends GroupBackend {
	constructor({ state = loadGroupFixtures().state, given } = {}) {
		super({ state, given });
		const merged = mergeState(state, given);
		this.categories = new Map(
			Object.values(merged.categories ?? {}).map((item) => [item.id, { ...item }]),
		);
		this.posts = new Map(
			Object.values(merged.posts ?? {}).map((post) => [
				post.id,
				{ group_id: null, selected_follow_ids: [], ...structuredClone(post) },
			]),
		);
		this.comments = new Map(
			Object.values(merged.comments ?? {}).map((item) => [item.id, { ...item }]),
		);
		this.media = new Map(Object.values(merged.media ?? {}).map((item) => [item.id, { ...item }]));
		this.reactions = new Map(
			Object.values(merged.reactions ?? {}).map((item) => [item.id, { ...item }]),
		);
		this.contentNotices = new Map(
			Object.values(merged.notifications ?? {})
				.filter((notice) => CONTENT_NOTICES.has(notice.type))
				.map((notice) => [notice.id, { ...notice }]),
		);
		for (const [table, map] of [
			['posts', this.posts],
			['comments', this.comments],
			['media', this.media],
			['reactions', this.reactions],
		]) {
			this.nextIds[table] ??= Math.max(0, ...map.keys()) + 1;
		}
	}

	// Snapshot in the pack's state format, for expected-state assertions.
	snapshot() {
		const table = (map) => Object.fromEntries([...map].map(([id, value]) => [id, { ...value }]));
		const groups = super.snapshot();
		return {
			...groups,
			notifications: { ...groups.notifications, ...table(this.contentNotices) },
			posts: Object.fromEntries([...this.posts].map(([id, post]) => [id, structuredClone(post)])),
			comments: table(this.comments),
			media: table(this.media),
			reactions: table(this.reactions),
		};
	}

	// --- the one access predicate -----------------------------------------

	acceptedFollow(followerId, followedId) {
		const follow = this.follows.find(
			(item) =>
				item.follower_id === followerId &&
				item.followed_id === followedId &&
				item.state === 'accepted',
		);
		return follow && this.user(followerId) ? follow : null;
	}

	// Group posts: current membership, published or the author's own draft.
	// Personal posts: the Phase 3 profile and audience rules. Never OR-ed.
	canRead(viewerId, post) {
		const viewer = this.user(viewerId);
		const author = this.user(post.author_id);
		if (!viewer || !author) return false;
		if (post.group_id !== null) {
			if (!this.groups.has(post.group_id) || !this.membershipOf(post.group_id, viewerId))
				return false;
			return post.status === 'published' || viewerId === author.id;
		}
		if (viewerId === author.id) return true;
		if (post.status !== 'published') return false;
		const follow = this.acceptedFollow(viewerId, author.id);
		if (author.visibility === 'private' && !follow) return false;
		if (post.audience === 'public') return true;
		if (post.audience === 'followers') return Boolean(follow);
		return Boolean(follow && post.selected_follow_ids.includes(follow.id));
	}

	readablePost(viewerId, id) {
		const post = this.posts.get(id);
		return post && this.canRead(viewerId, post) ? post : null;
	}

	readableComment(viewerId, id) {
		const comment = this.comments.get(id);
		const post = comment && this.readablePost(viewerId, comment.post_id);
		return post && this.user(comment.user_id) ? { comment, post } : null;
	}

	// --- wire shapes ---------------------------------------------------------

	reactionOf(viewerId, key, id) {
		return [...this.reactions.values()].find(
			(item) => item.user_id === viewerId && item[key] === id,
		);
	}

	reactionFields(viewerId, key, id) {
		const all = [...this.reactions.values()].filter((item) => item[key] === id);
		return {
			likes: all.filter((item) => item.value === 1).length,
			dislikes: all.filter((item) => item.value === -1).length,
			my_reaction: this.reactionOf(viewerId, key, id)?.value ?? 0,
		};
	}

	selectedAccounts(post) {
		return post.selected_follow_ids
			.map((id) => this.follows.find((follow) => follow.id === id)?.follower_id)
			.filter(Boolean)
			.sort((a, b) => a - b);
	}

	groupRef(post) {
		const group = post.group_id === null ? null : this.groups.get(post.group_id);
		return group ? { id: group.id, title: group.title } : null;
	}

	postWire(viewerId, post) {
		const wire = {
			id: post.id,
			author_id: post.author_id,
			author: this.users.get(post.author_id).display_name,
			title: post.title,
			body: post.body,
			image_url: post.image_url,
			status: post.status,
			audience: post.audience,
			version: post.version,
			categories: post.categories.map((id) => ({ id, name: this.categories.get(id).name })),
			created_at: post.created_at,
			updated_at: post.updated_at,
			...this.reactionFields(viewerId, 'post_id', post.id),
			group: this.groupRef(post),
		};
		if (post.group_id === null && viewerId === post.author_id)
			wire.selected_follower_ids = this.selectedAccounts(post);
		return wire;
	}

	draftWire(post) {
		return {
			id: post.id,
			title: post.title,
			body: post.body,
			image_url: post.image_url,
			category_ids: [...post.categories],
			updated_at: post.updated_at,
			audience: post.audience,
			version: post.version,
			selected_follower_ids: post.group_id === null ? this.selectedAccounts(post) : [],
			group: this.groupRef(post),
		};
	}

	commentWire(viewerId, comment) {
		return {
			id: comment.id,
			post_id: comment.post_id,
			user_id: comment.user_id,
			username: this.users.get(comment.user_id).display_name,
			parent_comment_id: comment.parent_comment_id,
			body: comment.body,
			image_url: comment.image_url,
			version: comment.version,
			created_at: comment.created_at,
			updated_at: comment.updated_at,
			...this.reactionFields(viewerId, 'comment_id', comment.id),
		};
	}

	postProjection(viewerId, post, { always = false } = {}) {
		const wire = this.postWire(viewerId, post);
		const projection = {
			id: wire.id,
			author_id: wire.author_id,
			author: wire.author,
			title: wire.title,
			image_url: wire.image_url,
			categories: wire.categories,
			likes: wire.likes,
			dislikes: wire.dislikes,
			my_reaction: wire.my_reaction,
		};
		if (post.group_id !== null) projection.group = wire.group;
		return always || post.group_id !== null ? projection : null;
	}

	// --- notices -------------------------------------------------------------

	visibleNotices(viewer) {
		const content = [...this.contentNotices.values()].filter((notice) => {
			if (notice.recipient_id !== viewer.id || !this.user(notice.actor_id)) return false;
			if (notice.comment_id !== null)
				return Boolean(this.readableComment(viewer.id, notice.comment_id));
			return Boolean(this.readablePost(viewer.id, notice.post_id));
		});
		return [...super.visibleNotices(viewer), ...content].sort(
			(a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
		);
	}

	projectNotice(viewer, notice) {
		if (!CONTENT_NOTICES.has(notice.type)) return super.projectNotice(viewer, notice);
		const comment = notice.comment_id === null ? null : this.comments.get(notice.comment_id);
		const post = this.posts.get(comment ? comment.post_id : notice.post_id);
		const target = comment
			? {
					kind: 'comment',
					post_id: post.id,
					comment_id: comment.id,
					title: post.title,
					excerpt: [...comment.body].slice(0, 20).join(''),
				}
			: { kind: 'post', post_id: post.id, title: post.title };
		return {
			id: notice.id,
			type: notice.type,
			created_at: notice.created_at,
			is_read: notice.is_read,
			actor: this.entry(viewer.id, this.user(notice.actor_id)),
			target,
			actions: [],
		};
	}

	// A notice is inserted only for a recipient who could read the target now.
	notify(type, recipientId, actorId, { postId = null, commentId = null }) {
		if (recipientId === actorId || !this.user(recipientId)) return false;
		const post = this.posts.get(postId ?? this.comments.get(commentId)?.post_id);
		if (!post || !this.canRead(recipientId, post)) return false;
		const duplicate = [...this.contentNotices.values()].some(
			(notice) =>
				notice.recipient_id === recipientId &&
				notice.actor_id === actorId &&
				notice.type === type &&
				notice.post_id === postId &&
				notice.comment_id === commentId,
		);
		if (duplicate) return false;
		const id = this.allocate('notifications');
		this.contentNotices.set(id, {
			id,
			recipient_id: recipientId,
			actor_id: actorId,
			type,
			post_id: postId,
			comment_id: commentId,
			group_id: null,
			entry_id: null,
			state: null,
			is_read: false,
			created_at: CLOCK,
		});
		return true;
	}

	// Content changes keep the existing all-authenticated fanout; a real new
	// notice also signals only its recipient.
	contentSignal(recipients = []) {
		this.signal('social.invalidate', 'all_authenticated');
		for (const id of recipients) this.signal('notification.new', [id]);
	}

	// --- dispatch ------------------------------------------------------------

	request(viewerId, method, url, payload = {}) {
		const target = new URL(url, 'http://fixture.test');
		const route = matchContent(target.pathname);
		if (!route) return super.request(viewerId, method, url, payload);
		this.log.push({
			viewerId,
			method,
			path: `${target.pathname}${target.search}`,
			json: payload.json,
			form: payload.form,
		});
		if (!route.methods.includes(method))
			return reply(
				405,
				{ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
				{ Allow: route.methods.join(', ') },
			);
		if (
			method !== 'GET' &&
			payload.headers &&
			payload.headers['X-Requested-With'] !== 'XMLHttpRequest'
		)
			return failure(403, 'CSRF_CHECK_FAILED');
		const viewer = viewerId === null ? null : this.user(viewerId);
		if (!viewer) return failure(401, 'UNAUTHORIZED');
		const fault = this.faults.findIndex(
			(item) => item.method === method && item.path.test(target.pathname),
		);
		if (fault >= 0) {
			const item = this.faults[fault];
			if (!item.repeat) this.faults.splice(fault, 1);
			if (!item.commit) return failure(500, 'INTERNAL_SERVER_ERROR');
			const result = this.dispatchContent(viewer, method, route, target, payload);
			return result.status < 400 ? failure(500, 'INTERNAL_SERVER_ERROR') : result;
		}
		return this.dispatchContent(viewer, method, route, target, payload);
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only route dispatcher
	dispatchContent(viewer, method, route, target, payload) {
		const params = target.searchParams;
		const [first, second] = route.params;
		switch (route.name) {
			case 'feed':
				return method === 'GET'
					? this.feed(viewer, params)
					: this.writePost(viewer, null, payload, { draft: false });
			case 'mine':
				return this.mine(viewer, params);
			case 'liked':
				return this.reacted(viewer, params, first === 'liked' ? 1 : -1);
			case 'draft':
				return method === 'GET'
					? this.latestDraft(viewer, params)
					: this.writePost(viewer, null, payload, { draft: true });
			case 'draftById':
				return method === 'PUT'
					? this.writePost(viewer, parseId(first), payload, { draft: true })
					: this.removePost(viewer, parseId(first), params, true);
			case 'post':
				if (method === 'GET') return this.detail(viewer, parseId(first));
				return method === 'PATCH'
					? this.writePost(viewer, parseId(first), payload, { draft: false })
					: this.removePost(viewer, parseId(first), params, false);
			case 'thread':
				return method === 'GET'
					? this.thread(viewer, parseId(first), params)
					: this.writeComment(viewer, parseId(first), null, payload);
			case 'nav':
				return this.navigation(viewer, parseId(first), params);
			case 'postReaction':
				return this.react(viewer, 'post_id', parseId(first), second);
			case 'commentReaction':
				return this.react(viewer, 'comment_id', parseId(first), second);
			case 'comment':
				if (method === 'GET') return this.commentDetail(viewer, parseId(first));
				return method === 'PATCH'
					? this.writeComment(viewer, null, parseId(first), payload)
					: this.removeComment(viewer, parseId(first), params);
			case 'categories':
				return params.size
					? badRequest()
					: reply(200, {
							data: [...this.categories.values()].map(({ id, name }) => ({ id, name })),
						});
			case 'categoryView':
				return this.categoryView(viewer);
			case 'media':
				return this.readMedia(viewer, first);
			case 'legacyMedia':
				return notFound();
			case 'activity':
				return this.activity(viewer, params);
			default:
				return this.profileContent(viewer, parseId(first), second, params);
		}
	}

	pagedReply(items, params, wire) {
		const paged = this.page(items, params);
		if (!paged) return badRequest();
		return reply(200, { data: paged.items.map(wire), meta: { pagination: paged.pagination } });
	}

	// --- reads ---------------------------------------------------------------

	groupScope(viewer, rawGroupId) {
		if (rawGroupId === null) return { groupId: null };
		const groupId = parseId(rawGroupId);
		if (!groupId) return { error: badRequest() };
		if (!this.groups.has(groupId) || !this.membershipOf(groupId, viewer.id))
			return { error: notFound() };
		return { groupId };
	}

	feed(viewer, params) {
		if (!this.strictParams(params, ['page', 'per_page', 'feed', 'category_id', 'group_id']))
			return badRequest();
		const feed = params.get('feed') ?? 'all';
		if (!['all', 'following'].includes(feed)) return badRequest();
		let category = null;
		if (params.has('category_id')) {
			category = parseId(params.get('category_id'));
			if (!category) return badRequest();
		}
		const scope = this.groupScope(viewer, params.get('group_id'));
		if (scope.error) return scope.error;
		const items = sortNewest(
			[...this.posts.values()].filter(
				(post) =>
					post.status === 'published' &&
					this.canRead(viewer.id, post) &&
					(scope.groupId === null || post.group_id === scope.groupId) &&
					(!category || post.categories.includes(category)) &&
					(feed !== 'following' ||
						(post.author_id !== viewer.id && this.acceptedFollow(viewer.id, post.author_id))),
			),
		);
		return this.pagedReply(items, params, (post) => this.postWire(viewer.id, post));
	}

	mine(viewer, params) {
		if (!this.strictParams(params, ['page', 'per_page', 'status'])) return badRequest();
		const status = params.get('status') ?? 'all';
		if (!['all', 'published', 'draft'].includes(status)) return badRequest();
		const items = sortNewest(
			[...this.posts.values()].filter(
				(post) =>
					post.author_id === viewer.id &&
					(status === 'all' || post.status === status) &&
					this.canRead(viewer.id, post),
			),
		);
		return this.pagedReply(items, params, (post) => this.postWire(viewer.id, post));
	}

	reacted(viewer, params, value) {
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		const items = sortNewest(
			[...this.posts.values()].filter(
				(post) =>
					post.status === 'published' &&
					this.canRead(viewer.id, post) &&
					this.reactionOf(viewer.id, 'post_id', post.id)?.value === value,
			),
		);
		return this.pagedReply(items, params, (post) => this.postWire(viewer.id, post));
	}

	latestDraft(viewer, params) {
		if (!this.strictParams(params, ['group_id'])) return badRequest();
		const scope = this.groupScope(viewer, params.get('group_id'));
		if (scope.error) return scope.error;
		const [latest] = [...this.posts.values()]
			.filter(
				(post) =>
					post.author_id === viewer.id &&
					post.status === 'draft' &&
					post.group_id === scope.groupId &&
					this.canRead(viewer.id, post),
			)
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
		return reply(200, { data: latest ? this.draftWire(latest) : null });
	}

	detail(viewer, id) {
		const post = id && this.readablePost(viewer.id, id);
		return post ? reply(200, { data: this.postWire(viewer.id, post) }) : notFound();
	}

	thread(viewer, id, params) {
		const post = id && this.readablePost(viewer.id, id);
		if (!post) return notFound();
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		const items = [...this.comments.values()]
			.filter((comment) => comment.post_id === post.id && this.user(comment.user_id))
			.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
		return this.pagedReply(items, params, (comment) => this.commentWire(viewer.id, comment));
	}

	commentDetail(viewer, id) {
		const found = id && this.readableComment(viewer.id, id);
		return found ? reply(200, { data: this.commentWire(viewer.id, found.comment) }) : notFound();
	}

	navigation(viewer, id, params) {
		const post = id && this.readablePost(viewer.id, id);
		if (!post) return notFound();
		if (!this.strictParams(params, ['feed', 'category_id', 'group_id'])) return badRequest();
		const feed = params.get('feed') ?? 'all';
		if (!['all', 'following'].includes(feed)) return badRequest();
		let category = null;
		if (params.has('category_id')) {
			category = parseId(params.get('category_id'));
			if (!category) return badRequest();
		}
		const scope = this.groupScope(viewer, params.get('group_id'));
		if (scope.error) return scope.error;
		const scoped = sortNewest(
			[...this.posts.values()].filter(
				(entry) =>
					entry.status === 'published' &&
					this.canRead(viewer.id, entry) &&
					(scope.groupId === null || entry.group_id === scope.groupId) &&
					(!category || entry.categories.includes(category)) &&
					(feed !== 'following' ||
						(entry.author_id !== viewer.id && this.acceptedFollow(viewer.id, entry.author_id))),
			),
		);
		const index = scoped.findIndex((entry) => entry.id === post.id);
		if (index < 0) return notFound();
		return reply(200, {
			data: {
				category_id: category,
				prev_id: scoped[index + 1]?.id ?? null,
				next_id: scoped[index - 1]?.id ?? null,
			},
		});
	}

	categoryView(viewer) {
		return reply(200, {
			data: [...this.categories.values()].map((category) => ({
				id: category.id,
				name: category.name,
				posts: sortNewest(
					[...this.posts.values()].filter(
						(post) =>
							post.status === 'published' &&
							post.categories.includes(category.id) &&
							this.canRead(viewer.id, post),
					),
				).map((post) => this.postWire(viewer.id, post)),
			})),
		});
	}

	readMedia(viewer, rawId) {
		const id = parseId(rawId);
		const item = id && this.media.get(id);
		if (!item || item.state !== 'ready') return notFound();
		const owner = item.comment_id
			? this.readableComment(viewer.id, item.comment_id)?.post
			: this.readablePost(viewer.id, item.post_id);
		if (!owner) return notFound();
		return {
			status: 200,
			headers: {
				...NO_STORE,
				'Content-Type': 'image/png',
				'X-Content-Type-Options': 'nosniff',
			},
			body: null,
			bytes: PNG,
		};
	}

	profileContent(viewer, id, kind, params) {
		const subject = id && this.user(id);
		if (!subject || !this.canView(viewer.id, subject)) return notFound();
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		if (kind === 'posts') {
			const items = sortNewest(
				[...this.posts.values()].filter(
					(post) =>
						post.author_id === subject.id &&
						post.status === 'published' &&
						this.canRead(viewer.id, post),
				),
			);
			return this.pagedReply(items, params, (post) => this.postWire(viewer.id, post));
		}
		const items = sortNewest(
			[...this.comments.values()].filter((comment) => {
				const found = this.readableComment(viewer.id, comment.id);
				return comment.user_id === subject.id && found?.post.status === 'published';
			}),
		);
		return this.pagedReply(items, params, (comment) => {
			const parent = this.posts.get(comment.post_id);
			const projection = this.postProjection(viewer.id, parent);
			return projection
				? { ...this.commentWire(viewer.id, comment), post: projection }
				: this.commentWire(viewer.id, comment);
		});
	}

	activity(viewer, params) {
		if (!this.strictParams(params, ['page', 'per_page', 'status'])) return badRequest();
		const status = params.get('status');
		if (status && !['published', 'draft'].includes(status)) return badRequest();
		const posts = sortNewest(
			[...this.posts.values()].filter((post) => this.canRead(viewer.id, post)),
		);
		const section = (items, wire) => {
			const paged = this.page(items, params);
			return { items: paged.items.map(wire), pagination: paged.pagination };
		};
		const wirePost = (post) => this.postWire(viewer.id, post);
		const reacted = (value) =>
			posts.filter(
				(post) =>
					post.status === 'published' &&
					this.reactionOf(viewer.id, 'post_id', post.id)?.value === value,
			);
		const comments = sortNewest(
			[...this.comments.values()].filter(
				(comment) => comment.user_id === viewer.id && this.readableComment(viewer.id, comment.id),
			),
		);
		return reply(200, {
			data: {
				created_posts: section(
					posts.filter(
						(post) => post.author_id === viewer.id && (!status || post.status === status),
					),
					wirePost,
				),
				liked_posts: section(reacted(1), wirePost),
				disliked_posts: section(reacted(-1), wirePost),
				comments: section(comments, (comment) => ({
					...this.commentWire(viewer.id, comment),
					post: this.postProjection(viewer.id, this.posts.get(comment.post_id), { always: true }),
				})),
			},
		});
	}

	// --- writes ---------------------------------------------------------------

	parseBody(payload, { edit, draft }) {
		const body = bodyFields(payload);
		if (!body) return { error: badRequest() };
		const allowed = [
			'title',
			'body',
			'category_ids',
			'remove_image',
			'audience',
			'selected_follower_ids',
			'group_id',
		];
		if (edit) allowed.push('expected_version');
		if (!draft) allowed.push('status');
		if (draft && !edit) allowed.push('manual');
		if (Object.keys(body.fields).some((key) => !allowed.includes(key)))
			return { error: badRequest() };
		if (
			edit &&
			!(Number.isSafeInteger(body.fields.expected_version) && body.fields.expected_version > 0)
		)
			return { error: badRequest() };
		if (body.fields.body === null) return { error: badRequest() };
		if (body.image?.size > IMAGE_MAX) return { error: failure(413, 'PAYLOAD_TOO_LARGE') };
		return body;
	}

	groupIdProblem(fields, edit) {
		if (fields.group_id === undefined) return null;
		if (edit) return invalid('group_id', 'IMMUTABLE');
		if (typeof fields.group_id !== 'number') return badRequest();
		if (!Number.isSafeInteger(fields.group_id) || fields.group_id <= 0)
			return invalid('group_id', 'INVALID_ID');
		return null;
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only contract validation and commit model
	validatePost(viewer, current, fields, image, { isNew }) {
		const next = structuredClone(current);
		for (const [field, max] of [
			['title', 200],
			['body', 10000],
		]) {
			if (fields[field] === null && field === 'title') next.title = null;
			if (fields[field] === undefined || fields[field] === null) continue;
			const checked = textProblem(String(fields[field]), field, max);
			if (checked.error) return { error: invalid(field, checked.error) };
			next[field] = field === 'title' && checked.text === '' ? null : checked.text;
		}
		if (fields.category_ids !== undefined) {
			const ids = fields.category_ids;
			if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0))
				return { error: invalid('category_ids', 'INVALID_IDS') };
			if (ids.length > 50) return { error: invalid('category_ids', 'TOO_MANY') };
			if (!ids.every((id) => this.categories.has(id)))
				return { error: invalid('category_ids', 'INVALID_CATEGORY') };
			next.categories = [...new Set(ids)].sort((a, b) => a - b);
		}
		if (fields.status !== undefined) {
			if (!['published', 'draft'].includes(fields.status))
				return { error: invalid('status', 'INVALID_STATUS') };
			next.status = fields.status;
		}
		if (current.group_id === null) {
			const audienceProblem = this.personalAudience(viewer, current, next, fields);
			if (audienceProblem) return { error: audienceProblem };
		}
		if (fields.remove_image === true) next.image_url = null;
		if (image) {
			if (!imageKind(image))
				return { error: failure(422, 'INVALID_IMAGE', { image: 'INVALID_IMAGE' }) };
			next.image_url = 'pending-upload';
		}
		const publishing = next.status === 'published' && (isNew || current.status !== 'published');
		const edited = fields.body !== undefined || Boolean(image) || fields.remove_image === true;
		if (next.status !== 'draft' && next.body === '' && !next.image_url && (publishing || edited))
			return { error: invalid('body', 'CONTENT_REQUIRED') };
		return { next };
	}

	personalAudience(viewer, current, next, fields) {
		const audience = fields.audience ?? current.audience;
		if (!['public', 'followers', 'selected'].includes(audience))
			return invalid('audience', 'INVALID_AUDIENCE');
		next.audience = audience;
		if (audience !== 'selected') {
			next.selected_follow_ids = [];
			return null;
		}
		const supplied = fields.selected_follower_ids;
		if (!supplied) {
			return current.audience === 'selected'
				? null
				: invalid('selected_follower_ids', 'INVALID_SELECTION');
		}
		const grants = supplied.map((id) => this.acceptedFollow(id, viewer.id)?.id ?? null);
		if (grants.includes(null)) return invalid('selected_follower_ids', 'INVALID_SELECTION');
		next.selected_follow_ids = grants.sort((a, b) => a - b);
		return null;
	}

	attachImage(post, previousUrl) {
		if (post.image_url === 'pending-upload') {
			const id = this.allocate('media');
			this.media.set(id, { id, post_id: post.id, state: 'ready' });
			post.image_url = `/api/v1/media/${id}`;
		}
		if (previousUrl && previousUrl !== post.image_url) {
			const old = Number(previousUrl.split('/').pop());
			this.media.delete(old);
		}
	}

	writePost(viewer, id, payload, { draft }) {
		const edit = id !== null;
		if (edit && !id) return badRequest();
		const parsed = this.parseBody(payload, { edit, draft });
		if (parsed.error) return parsed.error;
		const { fields, image } = parsed;
		const groupProblem = this.groupIdProblem(fields, edit);
		if (groupProblem) return groupProblem;
		return edit
			? this.editPost(viewer, id, fields, image, draft)
			: this.createPost(viewer, fields, image, draft);
	}

	createPost(viewer, fields, image, draft) {
		let group = null;
		if (fields.group_id !== undefined) {
			group = this.groups.get(fields.group_id);
			if (!group || !this.membershipOf(group.id, viewer.id)) return notFound();
			if (fields.audience !== undefined) return invalid('audience', 'GROUP_SCOPE');
			if (fields.selected_follower_ids !== undefined)
				return invalid('selected_follower_ids', 'GROUP_SCOPE');
		}
		const base = {
			id: this.nextIds.posts,
			author_id: viewer.id,
			group_id: group ? group.id : null,
			title: null,
			body: '',
			image_url: null,
			status: draft ? 'draft' : 'published',
			audience: group ? 'group' : 'public',
			version: 1,
			categories: [],
			created_at: CLOCK,
			updated_at: CLOCK,
			selected_follow_ids: [],
		};
		const checked = this.validatePost(
			viewer,
			base,
			{ ...fields, status: draft ? 'draft' : fields.status },
			image,
			{ isNew: true },
		);
		if (checked.error) return checked.error;
		const post = checked.next;
		this.allocate('posts');
		this.attachImage(post, null);
		this.posts.set(post.id, post);
		this.contentSignal();
		return draft
			? reply(200, { data: { id: post.id, version: post.version } })
			: reply(201, { data: this.postWire(viewer.id, post) });
	}

	editPost(viewer, id, fields, image, draft) {
		const current = this.posts.get(id);
		if (
			!current ||
			current.author_id !== viewer.id ||
			!this.canRead(viewer.id, current) ||
			(draft && current.status !== 'draft')
		)
			return notFound();
		if (current.group_id !== null) {
			if (fields.audience !== undefined) return invalid('audience', 'GROUP_SCOPE');
			if (fields.selected_follower_ids !== undefined)
				return invalid('selected_follower_ids', 'GROUP_SCOPE');
		}
		if (current.version !== fields.expected_version) return failure(409, 'STALE_CONTENT');
		const checked = this.validatePost(viewer, current, fields, image, { isNew: false });
		if (checked.error) return checked.error;
		const next = checked.next;
		if (draft) next.status = current.status;
		const changed =
			Boolean(image) || JSON.stringify({ ...next }) !== JSON.stringify({ ...current });
		if (changed) {
			next.version = current.version + 1;
			next.updated_at = CLOCK;
			this.attachImage(next, current.image_url);
			this.posts.set(id, next);
			this.contentSignal();
		}
		return draft ? reply(204) : reply(200, { data: this.postWire(viewer.id, next) });
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only contract validation and commit model
	removePost(viewer, id, params, draft) {
		if (!this.strictParams(params, ['expected_version'])) return badRequest();
		const version = parseId(params.get('expected_version') ?? '');
		if (!id || !version) return badRequest();
		const post = this.posts.get(id);
		if (
			!post ||
			post.author_id !== viewer.id ||
			!this.canRead(viewer.id, post) ||
			(draft && post.status !== 'draft')
		)
			return notFound();
		if (post.version !== version) return failure(409, 'STALE_CONTENT');
		this.posts.delete(id);
		for (const [key, item] of this.media) if (item.post_id === id) this.media.delete(key);
		for (const comment of [...this.comments.values()])
			if (comment.post_id === id) this.dropComment(comment.id);
		for (const [key, item] of this.reactions) if (item.post_id === id) this.reactions.delete(key);
		this.contentSignal();
		return reply(204);
	}

	writeComment(viewer, postId, commentId, payload) {
		const edit = commentId !== null;
		const parsed = bodyFields(payload);
		if (!parsed) return badRequest();
		const { fields, image } = parsed;
		const allowed = ['body', 'parent_comment_id', 'remove_image'];
		if (edit) allowed.push('expected_version');
		if (Object.keys(fields).some((key) => !allowed.includes(key))) return badRequest();
		if (edit) return this.editComment(viewer, commentId, fields, image);
		const post = postId && this.readablePost(viewer.id, postId);
		if (!post) return notFound();
		const parentId = fields.parent_comment_id ?? null;
		if (parentId !== null && this.comments.get(parentId)?.post_id !== post.id) return notFound();
		const checked = this.commentContent(null, fields, image);
		if (checked.error) return checked.error;
		const comment = {
			id: this.allocate('comments'),
			post_id: post.id,
			user_id: viewer.id,
			parent_comment_id: parentId,
			body: checked.body,
			image_url: null,
			version: 1,
			created_at: CLOCK,
			updated_at: CLOCK,
		};
		this.attachCommentImage(comment, image, null);
		this.comments.set(comment.id, comment);
		const notified = this.notify('comment', post.author_id, viewer.id, { postId: post.id });
		this.contentSignal(notified ? [post.author_id] : []);
		return reply(201, { data: this.commentWire(viewer.id, comment) });
	}

	commentContent(current, fields, image) {
		let body = current?.body ?? '';
		if (fields.body !== undefined) {
			const checked = textProblem(String(fields.body), 'body', 10000);
			if (checked.error) return { error: invalid('body', checked.error) };
			body = checked.text;
		}
		if (image && !imageKind(image))
			return { error: failure(422, 'INVALID_IMAGE', { image: 'INVALID_IMAGE' }) };
		const keepsImage = image || (current?.image_url && fields.remove_image !== true);
		if (body === '' && !keepsImage) return { error: invalid('body', 'CONTENT_REQUIRED') };
		return { body };
	}

	attachCommentImage(comment, image, previousUrl) {
		if (image) {
			const id = this.allocate('media');
			this.media.set(id, { id, comment_id: comment.id, state: 'ready' });
			comment.image_url = `/api/v1/media/${id}`;
		}
		if (previousUrl && previousUrl !== comment.image_url)
			this.media.delete(Number(previousUrl.split('/').pop()));
	}

	editComment(viewer, id, fields, image) {
		const found = id && this.readableComment(viewer.id, id);
		if (!found || found.comment.user_id !== viewer.id) return notFound();
		const current = found.comment;
		if (!(Number.isSafeInteger(fields.expected_version) && fields.expected_version > 0))
			return badRequest();
		if (current.version !== fields.expected_version) return failure(409, 'STALE_CONTENT');
		const checked = this.commentContent(current, fields, image);
		if (checked.error) return checked.error;
		const next = { ...current, body: checked.body };
		if (fields.remove_image === true && !image) next.image_url = null;
		this.attachCommentImage(next, image, current.image_url);
		next.version = current.version + 1;
		next.updated_at = CLOCK;
		this.comments.set(id, next);
		this.contentSignal();
		return reply(200, { data: this.commentWire(viewer.id, next) });
	}

	dropComment(id) {
		for (const child of [...this.comments.values()])
			if (child.parent_comment_id === id) this.dropComment(child.id);
		this.comments.delete(id);
		for (const [key, item] of this.media) if (item.comment_id === id) this.media.delete(key);
		for (const [key, item] of this.reactions)
			if (item.comment_id === id) this.reactions.delete(key);
		for (const [key, item] of this.contentNotices)
			if (item.comment_id === id) this.contentNotices.delete(key);
	}

	removeComment(viewer, id, params) {
		if (!this.strictParams(params, ['expected_version'])) return badRequest();
		const version = parseId(params.get('expected_version') ?? '');
		if (!id || !version) return badRequest();
		const found = this.readableComment(viewer.id, id);
		if (!found || found.comment.user_id !== viewer.id) return notFound();
		if (found.comment.version !== version) return failure(409, 'STALE_CONTENT');
		this.dropComment(id);
		this.contentSignal();
		return reply(204);
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only contract validation and commit model
	react(viewer, key, id, kind) {
		const post = key === 'post_id' ? id && this.readablePost(viewer.id, id) : null;
		const found = key === 'comment_id' ? id && this.readableComment(viewer.id, id) : null;
		const target = post || found?.comment;
		if (!target) return notFound();
		const value = kind === 'like' ? 1 : -1;
		const existing = this.reactionOf(viewer.id, key, id);
		let notified = false;
		if (existing && existing.value === value) this.reactions.delete(existing.id);
		else if (existing) existing.value = value;
		else {
			const record = { id: this.allocate('reactions'), user_id: viewer.id, [key]: id, value };
			this.reactions.set(record.id, record);
		}
		const now = this.reactionOf(viewer.id, key, id)?.value ?? 0;
		if (now !== 0) {
			const owner = key === 'post_id' ? target.author_id : target.user_id;
			const type = `${key === 'post_id' ? 'post' : 'comment'}_${now === 1 ? 'like' : 'dislike'}`;
			notified = this.notify(
				type,
				owner,
				viewer.id,
				key === 'post_id' ? { postId: id } : { commentId: id },
			);
			this.contentSignal(notified ? [owner] : []);
		} else this.contentSignal();
		const fields = this.reactionFields(viewer.id, key, id);
		return reply(200, {
			data: {
				[key]: id,
				reaction: fields.my_reaction,
				likes_count: fields.likes,
				dislikes_count: fields.dislikes,
			},
		});
	}
}

// fetch-compatible adapter with session switching, held/failed responses, a
// record of every call and multipart support, matching the earlier helpers.
export function createGroupContentFetch(backend, { viewer = () => 42, before, after } = {}) {
	const calls = [];
	async function fetchRef(url, init = {}) {
		const method = init.method ?? 'GET';
		const headers = init.headers ?? {};
		let json;
		let form;
		if (typeof init.body === 'string') json = JSON.parse(init.body);
		else if (init.body instanceof FormData) form = await readForm(init.body);
		const entry = { url, method, json, form, headers };
		calls.push(entry);
		if (before) await before(entry);
		const result = backend.request(viewer(), method, url, { json, form, headers });
		if (after) await after(entry, result);
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			headers: result.headers,
			json: async () => {
				if (result.body === null) throw new SyntaxError('empty body');
				return JSON.parse(JSON.stringify(result.body));
			},
		};
	}
	fetchRef.calls = calls;
	return fetchRef;
}
