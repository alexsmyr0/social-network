// Test-only stateful discussion model; real access enforcement is verified in A14.
import { ContentBackend, pngBytes } from './content-backend.js';

const ok = (data, meta) => ({
	status: 200,
	headers: { 'Cache-Control': 'no-store' },
	body: { data, ...(meta ? { meta } : {}) },
});
const fail = (status, code, fields) => ({
	status,
	headers: { 'Cache-Control': 'no-store' },
	body: { error: { code, message: 'Fixture error', ...(fields ? { fields } : {}) } },
});
const sorted = (items) =>
	items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
export class DiscussionBackend extends ContentBackend {
	constructor(options) {
		super(options);
		this.reactions = new Map();
		this.nextCommentId = Math.max(201, ...this.comments.keys()) + 1;
	}
	reaction(viewer, kind, id) {
		return this.reactions.get(`${viewer}:${kind}:${id}`) ?? 0;
	}
	reactionFields(viewer, kind, id) {
		const entries = [...this.reactions].filter(([key]) => key.endsWith(`:${kind}:${id}`));
		return {
			my_reaction: this.reaction(viewer, kind, id),
			likes: entries.filter(([, v]) => v === 1).length,
			dislikes: entries.filter(([, v]) => v === -1).length,
		};
	}
	wire(viewer, post) {
		return { ...super.wire(viewer, post), ...this.reactionFields(viewer, 'posts', post.id) };
	}
	commentWire(viewer, item) {
		return { ...structuredClone(item), ...this.reactionFields(viewer, 'comments', item.id) };
	}
	readableComments(viewer) {
		return [...this.comments.values()].filter(
			(item) =>
				this.user(item.user_id) &&
				this.posts.has(item.post_id) &&
				this.canRead(viewer, this.posts.get(item.post_id)),
		);
	}
	list(items, params, wire) {
		const paged = this.page(items, params);
		return paged
			? ok(paged.items.map(wire), { pagination: paged.pagination })
			: fail(400, 'BAD_REQUEST');
	}
	request(viewerId, method, url, payload = {}) {
		const target = new URL(url, 'http://fixture.test');
		const path = target.pathname.replace('/api/v1', '');
		const thread = path.match(/^\/posts\/(\d+)\/comments$/u);
		const comment = path.match(/^\/comments\/(\d+)$/u);
		const reaction = path.match(/^\/(posts|comments)\/(\d+)\/(like|dislike)$/u);
		const profile = path.match(/^\/users\/(\d+)\/(posts|comments)$/u);
		const nav = path.match(/^\/posts\/(\d+)\/nav$/u);
		const activity = path === '/users/activity';
		if (!thread && !comment && !reaction && !profile && !nav && !activity)
			return super.request(viewerId, method, url, payload);
		this.log.push({ viewerId, method, path: target.pathname + target.search, ...payload });
		const viewer = this.user(viewerId);
		if (!viewer) return fail(401, 'UNAUTHORIZED');
		if (method !== 'GET' && payload.headers?.['X-Requested-With'] !== 'XMLHttpRequest')
			return fail(403, 'CSRF_CHECK_FAILED');
		const fault = this.faults.findIndex(
			(item) => item.method === method && item.path.test(target.pathname),
		);
		if (fault >= 0) {
			const item = this.faults[fault];
			if (!item.repeat) this.faults.splice(fault, 1);
			if (!item.commit) return fail(500, 'INTERNAL_SERVER_ERROR');
			const result = this.dispatchDiscussion(viewer, method, target, payload, {
				thread,
				comment,
				reaction,
				profile,
				nav,
				activity,
			});
			return result.status < 400 ? fail(500, 'INTERNAL_SERVER_ERROR') : result;
		}
		return this.dispatchDiscussion(viewer, method, target, payload, {
			thread,
			comment,
			reaction,
			profile,
			nav,
			activity,
		});
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only route dispatcher
	dispatchDiscussion(
		viewer,
		method,
		target,
		payload,
		{ thread, comment, reaction, profile, nav, activity },
	) {
		const params = target.searchParams;
		if (profile) return this.readProfileActivity(viewer, profile, params);
		if (activity) return this.readActivity(viewer, params);
		let item = null;
		let post = null;
		if (comment || reaction?.[1] === 'comments') {
			item = this.comments.get(Number(comment?.[1] ?? reaction[2]));
			post = item && this.posts.get(item.post_id);
		} else post = this.posts.get(Number(thread?.[1] ?? nav?.[1] ?? reaction?.[2]));
		if (!post || !this.canRead(viewer.id, post) || (item && !this.user(item.user_id)))
			return fail(404, 'NOT_FOUND');
		if (nav) return this.readNavigation(viewer, post, params);
		if (reaction) return this.writeReaction(viewer, reaction);
		if (method === 'GET') {
			if (comment) return ok(this.commentWire(viewer.id, item));
			const items = this.readableComments(viewer.id)
				.filter((entry) => entry.post_id === post.id)
				.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
			return this.list(items, params, (entry) => this.commentWire(viewer.id, entry));
		}
		return this.writeComment(viewer, method, post, item, params, payload);
	}
	readProfileActivity(viewer, profile, params) {
		const subject = this.user(Number(profile[1]));
		if (
			!subject ||
			(subject.id !== viewer.id &&
				subject.visibility === 'private' &&
				!this.acceptedFollow(viewer.id, subject.id))
		)
			return fail(404, 'NOT_FOUND');
		const posts = sorted(
			[...this.posts.values()].filter(
				(post) =>
					post.author_id === subject.id &&
					post.status === 'published' &&
					this.canRead(viewer.id, post),
			),
		);
		const comments = sorted(
			this.readableComments(viewer.id).filter(
				(item) =>
					item.user_id === subject.id && this.posts.get(item.post_id).status === 'published',
			),
		);
		return this.list(profile[2] === 'posts' ? posts : comments, params, (item) =>
			profile[2] === 'posts' ? this.wire(viewer.id, item) : this.commentWire(viewer.id, item),
		);
	}
	readActivity(viewer, params) {
		const posts = sorted([...this.posts.values()].filter((post) => this.canRead(viewer.id, post)));
		const created = posts.filter(
			(post) =>
				post.author_id === viewer.id &&
				(!params.has('status') || post.status === params.get('status')),
		);
		const comments = sorted(
			this.readableComments(viewer.id).filter((item) => item.user_id === viewer.id),
		);
		const section = (items, wire) => {
			const paged = this.page(items, params);
			return { items: paged.items.map(wire), pagination: paged.pagination };
		};
		return ok({
			created_posts: section(created, (item) => this.wire(viewer.id, item)),
			liked_posts: section(
				posts.filter((post) => this.reaction(viewer.id, 'posts', post.id) === 1),
				(item) => this.wire(viewer.id, item),
			),
			disliked_posts: section(
				posts.filter((post) => this.reaction(viewer.id, 'posts', post.id) === -1),
				(item) => this.wire(viewer.id, item),
			),
			comments: section(comments, (item) => {
				const post = this.wire(viewer.id, this.posts.get(item.post_id));
				const keys = [
					'id',
					'author_id',
					'author',
					'title',
					'image_url',
					'categories',
					'likes',
					'dislikes',
					'my_reaction',
				];
				return {
					...this.commentWire(viewer.id, item),
					post: Object.fromEntries(keys.map((key) => [key, post[key]])),
				};
			}),
		});
	}
	readNavigation(viewer, post, params) {
		const filtered = sorted(
			[...this.posts.values()].filter(
				(entry) =>
					entry.status === 'published' &&
					this.canRead(viewer.id, entry) &&
					(!params.has('category_id') ||
						entry.categories.some((c) => c.id === Number(params.get('category_id')))) &&
					(params.get('feed') !== 'following' ||
						(entry.author_id !== viewer.id && this.acceptedFollow(viewer.id, entry.author_id))),
			),
		);
		const i = filtered.findIndex((entry) => entry.id === post.id);
		return i < 0
			? fail(404, 'NOT_FOUND')
			: ok({
					category_id: params.has('category_id') ? Number(params.get('category_id')) : null,
					prev_id: filtered[i + 1]?.id ?? null,
					next_id: filtered[i - 1]?.id ?? null,
				});
	}
	writeReaction(viewer, reaction) {
		const kind = reaction[1],
			id = Number(reaction[2]),
			desired = reaction[3] === 'like' ? 1 : -1;
		const current = this.reaction(viewer.id, kind, id);
		this.reactions.set(`${viewer.id}:${kind}:${id}`, current === desired ? 0 : desired);
		this.signal();
		const fields = this.reactionFields(viewer.id, kind, id);
		return ok({
			[kind === 'posts' ? 'post_id' : 'comment_id']: id,
			reaction: fields.my_reaction,
			likes_count: fields.likes,
			dislikes_count: fields.dislikes,
		});
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only contract validation and commit model
	writeComment(viewer, method, post, item, params, payload) {
		if (item && item.user_id !== viewer.id) return fail(404, 'NOT_FOUND');
		const fields =
			payload.json ??
			Object.fromEntries(
				Object.entries(payload.form?.fields ?? {}).map(([key, values]) => [key, values[0]]),
			);
		if (item && Number(fields.expected_version ?? params.get('expected_version')) !== item.version)
			return fail(409, 'STALE_CONTENT');
		if (method === 'DELETE') {
			this.removeCommentTree(item.id);
			this.signal();
			return { status: 204, headers: { 'Cache-Control': 'no-store' }, body: null };
		}
		const parent =
			fields.parent_comment_id == null || fields.parent_comment_id === ''
				? null
				: Number(fields.parent_comment_id);
		if (
			!item &&
			parent !== null &&
			(!this.comments.has(parent) || this.comments.get(parent).post_id !== post.id)
		)
			return fail(404, 'NOT_FOUND');
		const body =
			fields.body === undefined
				? (item?.body ?? '')
				: String(fields.body).replace(/\r\n/gu, '\n').trim();
		const file = payload.form?.image;
		if (file && !['image/png', 'image/jpeg', 'image/gif'].includes(file.type))
			return fail(422, 'INVALID_IMAGE', { image: 'INVALID_IMAGE' });
		if (file?.size > 5 * 1024 * 1024) return fail(413, 'PAYLOAD_TOO_LARGE');
		let image =
			fields.remove_image === true || fields.remove_image === 'true'
				? null
				: (item?.image_url ?? null);
		if (file) {
			const id = this.nextMediaId++;
			this.media.set(id, { id, post_id: post.id, state: 'ready', mime: file.type });
			image = `/api/v1/media/${id}`;
		}
		if (!body && !image) return fail(400, 'VALIDATION_ERROR', { body: 'CONTENT_REQUIRED' });
		const next = {
			id: item?.id ?? this.nextCommentId++,
			post_id: post.id,
			user_id: viewer.id,
			username: viewer.display_name,
			parent_comment_id: item?.parent_comment_id ?? parent,
			body,
			image_url: image,
			version: item ? item.version + 1 : 1,
			created_at: item?.created_at ?? this.clock,
			updated_at: this.clock,
			likes: 0,
			dislikes: 0,
			my_reaction: 0,
		};
		this.comments.set(next.id, next);
		this.signal();
		return { ...ok(this.commentWire(viewer.id, next)), status: item ? 200 : 201 };
	}
	removeCommentTree(id) {
		for (const item of [...this.comments.values()])
			if (item.parent_comment_id === id) this.removeCommentTree(item.id);
		this.comments.delete(id);
	}
	visibleNotices(viewer) {
		return super
			.visibleNotices(viewer)
			.filter(
				(notice) =>
					notice.type === 'follow_request' ||
					(this.canRead(viewer.id, this.posts.get(notice.target.post_id)) &&
						(notice.target.kind !== 'comment' || this.comments.has(notice.target.comment_id))),
			);
	}
	readMedia(viewer, id) {
		const media = this.media.get(Number(id));
		const comment = media?.comment_id ? this.comments.get(media.comment_id) : null;
		if (!comment) return super.readMedia(viewer, id);
		const post = this.posts.get(comment.post_id);
		if (!post || !this.user(comment.user_id) || !this.canRead(viewer.id, post))
			return fail(404, 'NOT_FOUND');
		return {
			status: 200,
			headers: { 'Cache-Control': 'no-store', 'Content-Type': 'image/png' },
			body: null,
			bytes: pngBytes(),
		};
	}
}
export { pngBytes };
