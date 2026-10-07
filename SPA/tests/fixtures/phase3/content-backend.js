// Stateful stand-in for the SN-B14 content contract, used only by tests. It
// extends the Phase 2 model with audience-aware posts, drafts, versions,
// selection grants bound to exact follow identities and parent-checked media,
// so UI tests exercise real transitions rather than one canned success. It is
// never imported by `SPA/src` (a policy test enforces that).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FixtureBackend, makeUser } from '../phase2/fixture-backend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE_PATH = path.join(ROOT, 'docs/social-network/fixtures/phase-3-contract.json');
const MAX_ID = Number.MAX_SAFE_INTEGER;
const NO_STORE = { 'Cache-Control': 'no-store' };
const IMAGE_MAX = 5 * 1024 * 1024;
const STATUSES = ['published', 'draft'];
const AUDIENCES = ['public', 'followers', 'selected'];
const PNG = readFileSync(path.join(ROOT, 'SPA/tests/fixtures/a07/avatar.png'));

export const CLOCK = '2026-10-06T12:00:00Z';

export function loadContentFixtures() {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

export function pngBytes() {
	return new Uint8Array(PNG);
}

function reply(status, body = null, headers = {}) {
	return { status, headers: { ...NO_STORE, ...headers }, body };
}

function failure(status, code, fields) {
	const error = { code, message: 'Fixture error; clients branch on code' };
	if (code === 'STALE_CONTENT') error.message = 'Content changed; refresh and retry';
	if (fields) error.fields = fields;
	return reply(status, { error });
}

const invalid = (field, code) => failure(400, 'VALIDATION_ERROR', { [field]: code });
const badRequest = () => failure(400, 'BAD_REQUEST');

function parseId(text) {
	if (typeof text !== 'string' || !/^[1-9]\d*$/u.test(text)) return null;
	const id = Number(text);
	return id <= MAX_ID ? id : null;
}

function matchContent(pathname) {
	const patterns = [
		['feed', /^\/api\/v1\/posts$/u],
		['mine', /^\/api\/v1\/posts\/mine$/u],
		['draft', /^\/api\/v1\/posts\/draft$/u],
		['draftById', /^\/api\/v1\/posts\/draft\/([^/]+)$/u],
		['post', /^\/api\/v1\/posts\/([^/]+)$/u],
		['categories', /^\/api\/v1\/categories$/u],
		['media', /^\/api\/v1\/media\/([^/]+)$/u],
	];
	for (const [name, pattern] of patterns) {
		const match = pattern.exec(pathname);
		if (match) return { name, param: match[1] };
	}
	return null;
}

const ALLOWED = {
	feed: ['GET', 'POST'],
	mine: ['GET'],
	draft: ['GET', 'POST'],
	draftById: ['PUT', 'DELETE'],
	post: ['GET', 'PATCH', 'DELETE'],
	categories: ['GET'],
	media: ['GET'],
};

function normalizeText(value) {
	return value.replace(/\r\n/gu, '\n').trim();
}

function textCheck(value, field, max) {
	const text = normalizeText(value);
	if ([...text].length > max) return { error: 'TOO_LONG' };
	const checked = field === 'title' ? text : text.replace(/[\n\t]/gu, '');
	if (/\p{Cc}/u.test(checked)) return { error: 'INVALID_TEXT' };
	return { text };
}

function imageKind(file) {
	const bytes = file.bytes;
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		return 'image/png';
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8') return 'image/gif';
	return null;
}

const ARRAY_FIELDS = ['category_ids', 'selected_follower_ids'];
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
	if (key === 'expected_version') return parseId(value) ?? Number.NaN;
	if (!BOOLEAN_FIELDS.includes(key)) return value;
	if (value !== 'true' && value !== 'false') return undefined;
	return value === 'true';
}

// Multipart form → the same field map a JSON body produces.
function formFields(form) {
	const fields = {};
	for (const [key, values] of Object.entries(form.fields)) {
		const value = formValue(key, values);
		if (value === undefined) return null;
		fields[key] = value;
	}
	return fields;
}

function allowedKeys({ edit, draft }) {
	const keys = ['title', 'body', 'category_ids', 'image_url', 'remove_image', 'audience'];
	keys.push('selected_follower_ids');
	if (edit) keys.push('expected_version');
	if (!draft) keys.push('status');
	if (draft && !edit) keys.push('manual');
	return keys;
}

function bodyFields(payload) {
	if (payload.form) {
		const fields = formFields(payload.form);
		return fields ? { fields, image: payload.form.image ?? null } : null;
	}
	const fields = payload.json ?? {};
	if (typeof fields !== 'object' || Array.isArray(fields)) return null;
	return { fields, image: null };
}

// Structural checks that precede field validation, as in the contract.
function structureProblem({ fields, image }, { edit, draft }) {
	const keys = allowedKeys({ edit, draft });
	if (Object.keys(fields).some((key) => !keys.includes(key))) return badRequest();
	const version = fields.expected_version;
	if (edit && !(Number.isSafeInteger(version) && version > 0)) return badRequest();
	if (edit && Object.keys(fields).length === 1 && !image) return badRequest();
	if (fields.body === null) return badRequest();
	const removal = fields.remove_image === true || fields.image_url === null;
	if (image && (removal || typeof fields.image_url === 'string')) return badRequest();
	if (image && image.size > IMAGE_MAX) return failure(413, 'PAYLOAD_TOO_LARGE');
	return null;
}

function idsProblem(value, max) {
	if (value === undefined) return null;
	if (!Array.isArray(value)) return 'INVALID_IDS';
	if (value.length > max) return 'TOO_MANY';
	if (!value.every((id) => Number.isSafeInteger(id) && id > 0)) return 'INVALID_IDS';
	if (new Set(value).size !== value.length) return 'INVALID_IDS';
	return null;
}

function validateText(next, fields) {
	for (const [field, max] of [
		['title', 200],
		['body', 10000],
	]) {
		if (fields[field] === null && field === 'title') next.title = null;
		if (fields[field] === undefined || fields[field] === null) continue;
		const checked = textCheck(String(fields[field]), field, max);
		if (checked.error) return invalid(field, checked.error);
		next[field] = field === 'title' && checked.text === '' ? null : checked.text;
	}
	return null;
}

function validateEnums(fields) {
	if (fields.audience !== undefined && !AUDIENCES.includes(fields.audience)) {
		return invalid('audience', 'INVALID_AUDIENCE');
	}
	if (fields.status !== undefined && !STATUSES.includes(fields.status)) {
		return invalid('status', 'INVALID_STATUS');
	}
	if (fields.selected_follower_ids === null) return invalid('selected_follower_ids', 'INVALID_IDS');
	const problem = idsProblem(fields.selected_follower_ids, 500);
	return problem ? invalid('selected_follower_ids', problem) : null;
}

export class ContentBackend extends FixtureBackend {
	constructor({
		users,
		follows,
		posts,
		categories,
		media,
		comments,
		notifications = [],
		clock = CLOCK,
	} = {}) {
		const state = loadContentFixtures().state;
		const people = (users ?? Object.values(state.users)).map((user) =>
			makeUser(user.id, {
				display_name: user.display_name,
				visibility: user.visibility,
				active: user.is_active ?? user.active ?? true,
				...user,
			}),
		);
		const relationships = (follows ?? Object.values(state.follows)).map((follow) => ({
			created_at: clock,
			accepted_at: follow.state === 'accepted' ? clock : null,
			...follow,
		}));
		super({ users: people, follows: relationships, notifications });
		this.clock = clock;
		this.categories = new Map(
			(categories ?? Object.values(state.categories)).map((category) => [
				category.id,
				{ ...category },
			]),
		);
		this.posts = new Map(
			(posts ?? Object.values(state.posts)).map((post) => [post.id, structuredClone(post)]),
		);
		this.media = new Map(
			(media ?? Object.values(state.media)).map((item) => [item.id, { ...item }]),
		);
		this.comments = new Map(
			(comments ?? Object.values(state.comments)).map((item) => [item.id, { ...item }]),
		);
		this.nextPostId = Math.max(101, ...this.posts.keys()) + 1;
		this.nextMediaId = Math.max(402, ...this.media.keys()) + 1;
		this.signals = [];
		this.faults = [];
	}

	// Test helper: a post owned by `authorId` with contract defaults.
	addPost(overrides = {}) {
		const id = overrides.id ?? this.nextPostId++;
		const author = this.users.get(overrides.author_id ?? 42);
		const post = {
			id,
			author_id: author.id,
			author: author.display_name,
			title: null,
			body: `Post ${id}`,
			image_url: null,
			status: 'published',
			audience: 'public',
			version: 1,
			categories: [],
			created_at: this.clock,
			updated_at: this.clock,
			likes: 0,
			dislikes: 0,
			my_reaction: 0,
			selected_follow_ids: [],
			...overrides,
		};
		this.posts.set(id, post);
		this.nextPostId = Math.max(this.nextPostId, id + 1);
		return post;
	}

	acceptedFollow(followerId, followedId) {
		const follow = this.follows.find(
			(item) =>
				item.follower_id === followerId &&
				item.followed_id === followedId &&
				item.state === 'accepted',
		);
		return follow && this.user(followerId) ? follow : null;
	}

	canRead(viewerId, post) {
		const author = this.user(post.author_id);
		if (!author) return false;
		if (viewerId === author.id) return true;
		if (post.status !== 'published') return false;
		const follow = this.acceptedFollow(viewerId, author.id);
		if (author.visibility === 'private' && !follow) return false;
		if (post.audience === 'public') return true;
		if (post.audience === 'followers') return Boolean(follow);
		return Boolean(follow && post.selected_follow_ids.includes(follow.id));
	}

	selectedAccounts(post) {
		return post.selected_follow_ids
			.map((id) => this.follows.find((follow) => follow.id === id)?.follower_id)
			.filter(Boolean)
			.sort((a, b) => a - b);
	}

	wire(viewerId, post) {
		const { selected_follow_ids: _grants, ...shape } = post;
		const result = structuredClone(shape);
		if (viewerId === post.author_id) result.selected_follower_ids = this.selectedAccounts(post);
		return result;
	}

	draftShape(post) {
		return {
			id: post.id,
			title: post.title,
			body: post.body,
			image_url: post.image_url,
			category_ids: post.categories.map((category) => category.id),
			updated_at: post.updated_at,
			audience: post.audience,
			version: post.version,
			selected_follower_ids: this.selectedAccounts(post),
		};
	}

	request(viewerId, method, url, { json, form, headers = {} } = {}) {
		const target = new URL(url, 'http://fixture.test');
		const route = matchContent(target.pathname);
		if (!route) return super.request(viewerId, method, url, { json });
		this.log.push({ viewerId, method, path: `${target.pathname}${target.search}`, json, form });
		if (!ALLOWED[route.name].includes(method)) {
			return reply(
				405,
				{ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
				{
					Allow: ALLOWED[route.name].join(', '),
				},
			);
		}
		if (method !== 'GET' && headers['X-Requested-With'] !== 'XMLHttpRequest') {
			return failure(403, 'CSRF_CHECK_FAILED');
		}
		if (viewerId === null) return failure(401, 'UNAUTHORIZED');
		const viewer = this.user(viewerId);
		if (!viewer) return failure(401, 'UNAUTHORIZED');
		const fault = this.faults.findIndex(
			(item) => item.method === method && item.path.test(target.pathname),
		);
		if (fault >= 0) {
			const [item] = this.faults.splice(fault, 1);
			if (!item.commit) return failure(500, 'INTERNAL_SERVER_ERROR');
			this.dispatchContent(viewer, route, target, method, { json, form });
			return failure(500, 'INTERNAL_SERVER_ERROR');
		}
		return this.dispatchContent(viewer, route, target, method, { json, form });
	}

	dispatchContent(viewer, route, target, method, payload) {
		const params = target.searchParams;
		if (route.name === 'categories') {
			if ([...params.keys()].length) return badRequest();
			return reply(200, { data: [...this.categories.values()].map((item) => ({ ...item })) });
		}
		if (route.name === 'media') return this.readMedia(viewer, route.param);
		if (route.name === 'feed' && method === 'GET') return this.feed(viewer, params, false);
		if (route.name === 'mine') return this.feed(viewer, params, true);
		if (route.name === 'draft' && method === 'GET') return this.latestDraft(viewer, params);
		if (route.name === 'feed') return this.write(viewer, null, payload, { draft: false });
		if (route.name === 'draft') return this.write(viewer, null, payload, { draft: true });
		const id = parseId(route.param);
		if (!id) return badRequest();
		const draft = route.name === 'draftById';
		if (method === 'GET') return this.detail(viewer, id);
		if (method === 'DELETE') return this.remove(viewer, id, params, draft);
		return this.write(viewer, id, payload, { draft });
	}

	strictQuery(params, allowed) {
		const keys = [...params.keys()];
		if (keys.some((key) => !allowed.includes(key))) return null;
		if (new Set(keys).size !== keys.length) return null;
		return Object.fromEntries(params.entries());
	}

	feed(viewer, params, mine) {
		const allowed = mine
			? ['page', 'per_page', 'status']
			: ['page', 'per_page', 'feed', 'category_id'];
		const values = this.strictQuery(params, allowed);
		if (!values) return badRequest();
		const feed = values.feed ?? 'all';
		const status = values.status ?? 'all';
		if (!['all', 'following'].includes(feed) || !['all', 'published', 'draft'].includes(status)) {
			return badRequest();
		}
		let category = null;
		if (values.category_id !== undefined) {
			category = parseId(values.category_id);
			if (!category) return badRequest();
		}
		const items = [...this.posts.values()]
			.filter((post) => {
				if (mine) {
					return post.author_id === viewer.id && (status === 'all' || post.status === status);
				}
				if (post.status !== 'published' || !this.canRead(viewer.id, post)) return false;
				if (category && !post.categories.some((item) => item.id === category)) return false;
				if (feed === 'following') {
					return post.author_id !== viewer.id && this.acceptedFollow(viewer.id, post.author_id);
				}
				return true;
			})
			.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
		const paged = this.page(items, params);
		if (!paged) return badRequest();
		return reply(200, {
			data: paged.items.map((post) => this.wire(viewer.id, post)),
			meta: { pagination: paged.pagination },
		});
	}

	latestDraft(viewer, params) {
		if ([...params.keys()].length) return badRequest();
		const [latest] = [...this.posts.values()]
			.filter((post) => post.author_id === viewer.id && post.status === 'draft')
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
		return reply(200, { data: latest ? this.draftShape(latest) : null });
	}

	detail(viewer, id) {
		const post = this.posts.get(id);
		if (!post || !this.canRead(viewer.id, post)) return failure(404, 'NOT_FOUND');
		return reply(200, { data: this.wire(viewer.id, post) });
	}

	readMedia(viewer, rawId) {
		const id = parseId(rawId);
		const item = id && this.media.get(id);
		const post = item && this.posts.get(item.post_id);
		if (!post || item.state !== 'ready' || !this.canRead(viewer.id, post)) {
			return failure(404, 'NOT_FOUND');
		}
		return {
			status: 200,
			headers: { ...NO_STORE, 'Content-Type': 'image/png' },
			body: null,
			bytes: PNG,
		};
	}

	owned(viewer, id, draft) {
		const post = this.posts.get(id);
		if (!post || post.author_id !== viewer.id || !this.user(post.author_id)) return null;
		if (draft && post.status !== 'draft') return null;
		return post;
	}

	remove(viewer, id, params, draft) {
		const values = this.strictQuery(params, ['expected_version']);
		const version = values && parseId(values.expected_version ?? '');
		if (!version) return badRequest();
		const post = this.owned(viewer, id, draft);
		if (!post) return failure(404, 'NOT_FOUND');
		if (post.version !== version) return failure(409, 'STALE_CONTENT');
		this.posts.delete(id);
		for (const [key, item] of this.media) if (item.post_id === id) this.media.delete(key);
		for (const [key, item] of this.comments) if (item.post_id === id) this.comments.delete(key);
		this.signal();
		return reply(204);
	}

	signal() {
		this.signals.push({ type: 'social.invalidate' });
	}

	// Parses a create/edit body. Returns { fields, image } or { reply }.
	parse(payload, options) {
		const body = bodyFields(payload);
		if (!body) return { reply: badRequest() };
		const problem = structureProblem(body, options);
		return problem ? { reply: problem } : body;
	}

	validateCategories(next, fields) {
		const problem = idsProblem(fields.category_ids, 50);
		if (problem) return invalid('category_ids', problem);
		if (!fields.category_ids) return null;
		if (!fields.category_ids.every((id) => this.categories.has(id))) {
			return invalid('category_ids', 'INVALID_CATEGORY');
		}
		next.categories = [...fields.category_ids]
			.sort((a, b) => a - b)
			.map((id) => ({ id, name: this.categories.get(id).name }));
		return null;
	}

	// Grants bind to the exact accepted follow identity of each account.
	validateAudience(viewer, current, next, fields) {
		const audience = fields.audience ?? current.audience;
		const supplied = fields.selected_follower_ids;
		next.audience = audience;
		if (audience !== 'selected') {
			next.selected_follow_ids = [];
			return supplied?.length ? invalid('selected_follower_ids', 'INVALID_SELECTION') : null;
		}
		// Switching to Selected requires an explicit selection.
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

	validateImage(current, next, fields, image) {
		if (typeof fields.image_url === 'string' && fields.image_url !== current.image_url) {
			return failure(404, 'NOT_FOUND');
		}
		if (fields.remove_image === true || fields.image_url === null) next.image_url = null;
		if (!image) return null;
		if (!imageKind(image)) return failure(422, 'INVALID_IMAGE', { image: 'INVALID_IMAGE' });
		next.image_url = 'pending-upload';
		return null;
	}

	// As in B15: recipients are required when a post becomes published;
	// content is required on publication and on visible text/image edits.
	validatePublication(current, next, fields, image, isNew) {
		const publishing = next.status === 'published' && (isNew || current.status !== 'published');
		if (publishing && next.audience === 'selected' && next.selected_follow_ids.length === 0) {
			return invalid('selected_follower_ids', 'INVALID_SELECTION');
		}
		const edited =
			fields.body !== undefined ||
			Boolean(image) ||
			fields.remove_image === true ||
			fields.image_url === null;
		const empty = next.body === '' && !next.image_url;
		if (next.status !== 'draft' && empty && (publishing || edited)) {
			return invalid('body', 'CONTENT_REQUIRED');
		}
		return null;
	}

	// Returns { reply } on failure or { next } with the resulting post state.
	validate(viewer, current, fields, image, { draft, isNew = false }) {
		const next = structuredClone(current);
		const steps = [
			() => validateText(next, fields),
			() => this.validateCategories(next, fields),
			() => validateEnums(fields),
			() => this.validateAudience(viewer, current, next, fields),
			() => {
				if (fields.status !== undefined) next.status = fields.status;
				return this.validateImage(current, next, fields, image);
			},
			() => this.validatePublication(current, next, fields, image, isNew),
		];
		for (const step of steps) {
			const reply = step();
			if (reply) return { reply };
		}
		if (draft) next.status = current.status;
		return { next };
	}

	attach(post, image, previousUrl) {
		if (post.image_url !== 'pending-upload') {
			if (previousUrl && post.image_url !== previousUrl) this.detachMedia(previousUrl);
			return;
		}
		const id = this.nextMediaId++;
		this.media.set(id, { id, post_id: post.id, state: 'ready', mime: imageKind(image) });
		post.image_url = `/api/v1/media/${id}`;
		if (previousUrl) this.detachMedia(previousUrl);
	}

	detachMedia(url) {
		const id = Number(url.split('/').pop());
		this.media.delete(id);
	}

	write(viewer, id, payload, { draft }) {
		const parsed = this.parse(payload, { edit: id !== null, draft });
		if (parsed.reply) return parsed.reply;
		const { fields, image } = parsed;
		if (id === null) return this.create(viewer, fields, image, { draft });
		const current = this.owned(viewer, id, draft);
		if (!current) return failure(404, 'NOT_FOUND');
		if (current.version !== fields.expected_version) return failure(409, 'STALE_CONTENT');
		const checked = this.validate(viewer, current, fields, image, { draft });
		if (checked.reply) return checked.reply;
		const next = checked.next;
		const changed =
			JSON.stringify({ ...next, image: Boolean(image) }) !==
			JSON.stringify({ ...current, image: false });
		if (changed) {
			next.version = current.version + 1;
			next.updated_at = this.clock;
			this.attach(next, image, current.image_url);
			this.posts.set(id, next);
			this.signal();
		}
		return draft ? reply(204) : reply(200, { data: this.wire(viewer.id, next) });
	}

	create(viewer, fields, image, { draft }) {
		const base = {
			id: this.nextPostId,
			author_id: viewer.id,
			author: viewer.display_name,
			title: null,
			body: '',
			image_url: null,
			status: draft ? 'draft' : 'published',
			audience: 'public',
			version: 1,
			categories: [],
			created_at: this.clock,
			updated_at: this.clock,
			likes: 0,
			dislikes: 0,
			my_reaction: 0,
			selected_follow_ids: [],
		};
		const checked = this.validate(
			viewer,
			base,
			{ ...fields, status: draft ? 'draft' : fields.status },
			image,
			{ draft: false, isNew: true },
		);
		if (checked.reply) return checked.reply;
		const post = checked.next;
		this.nextPostId += 1;
		this.attach(post, image, null);
		this.posts.set(post.id, post);
		this.signal();
		if (draft) return reply(200, { data: { id: post.id, version: post.version } });
		return reply(201, { data: this.wire(viewer.id, post) });
	}

	// Unfollowing prunes the exact grant and advances each affected post's
	// version once, so a stale owner form cannot restore it. A later refollow
	// gets a new identity that no post has selected.
	removeFollow(viewer, rawId) {
		const id = parseId(rawId);
		const follow = id && this.follows.find((item) => item.id === id);
		if (follow && follow.follower_id === viewer.id) {
			for (const post of this.posts.values()) {
				if (!post.selected_follow_ids.includes(id)) continue;
				post.selected_follow_ids = post.selected_follow_ids.filter((grant) => grant !== id);
				post.version += 1;
			}
		}
		return super.removeFollow(viewer, rawId);
	}
}

async function readForm(data) {
	const fields = {};
	let image = null;
	for (const [key, value] of data.entries()) {
		if (typeof value === 'string') {
			fields[key] ??= [];
			fields[key].push(value);
		} else {
			image = {
				name: value.name,
				type: value.type,
				size: value.size,
				bytes: new Uint8Array(await value.arrayBuffer()),
			};
		}
	}
	return { fields, image };
}

// fetch-compatible adapter for unit tests. `before(entry)` may await or throw
// (lost request); `after(entry, result)` may throw after the backend has
// committed (lost response).
export function createContentFetch(backend, { viewer = () => 42, before, after } = {}) {
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

export { readForm };
