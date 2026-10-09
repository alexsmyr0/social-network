import { isValidId } from './social.js';

const API = '/api/v1';
const STATUSES = new Set(['published', 'draft', 'archived']);
const AUDIENCES = new Set(['public', 'followers', 'selected']);
const REACTIONS = new Set([-1, 0, 1]);
// Only checked same-origin media routes are rendered. A remote or otherwise
// unexpected URL is dropped rather than handed to an <img>.
const MEDIA_PATH = /^\/(api\/v1\/media\/[1-9]\d*|static\/uploads\/[A-Za-z0-9._-]+)$/u;

export const AUDIENCE_VALUES = Object.freeze(['public', 'followers', 'selected']);

async function readPayload(response) {
	return response.json().catch(() => null);
}

function fieldsOf(payload) {
	const fields = payload?.error?.fields;
	return fields && typeof fields === 'object' ? { ...fields } : {};
}

// Maps a content error response to the outcomes the UI branches on. A lost or
// malformed response is "unavailable": for writes that means the outcome is
// unknown, so callers refetch instead of claiming success or replaying.
function failure(response, payload) {
	const code = payload?.error?.code;
	if (response.status === 401) return { status: 'unauthenticated' };
	if (response.status === 404) return { status: 'not-found' };
	if (response.status === 409 && code === 'STALE_CONTENT') return { status: 'stale' };
	if (response.status === 413) return { status: 'too-large' };
	if (response.status === 422 && code === 'INVALID_IMAGE') {
		return { status: 'invalid-image', fields: fieldsOf(payload) };
	}
	if ([400, 403, 405, 415].includes(response.status) && code) {
		return { status: 'rejected', code, fields: fieldsOf(payload) };
	}
	return { status: 'unavailable' };
}

async function send(path, { method = 'GET', json, form } = {}, fetchRef = globalThis.fetch) {
	const headers = { Accept: 'application/json' };
	const init = { method, headers, credentials: 'include' };
	if (method !== 'GET') headers['X-Requested-With'] = 'XMLHttpRequest';
	if (json !== undefined) {
		headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(json);
	} else if (form !== undefined) {
		// The browser sets the multipart boundary itself.
		init.body = form;
	}
	let response;
	try {
		response = await fetchRef(`${API}${path}`, init);
	} catch {
		return { status: 'unavailable' };
	}
	if (response.status === 204) return { status: 'ok', data: null, meta: null };
	const payload = await readPayload(response);
	if (!response.ok) return failure(response, payload);
	if (!payload || payload.data === undefined) return { status: 'unavailable' };
	return { status: 'ok', data: payload.data, meta: payload.meta ?? null };
}

function count(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function idList(value) {
	if (!Array.isArray(value) || !value.every(isValidId)) return null;
	return [...value];
}

export function safeMediaUrl(value) {
	return typeof value === 'string' && MEDIA_PATH.test(value) ? value : null;
}

function normalizeCategories(value) {
	if (!Array.isArray(value)) return null;
	const categories = value.map((category) =>
		category && isValidId(category.id) && typeof category.name === 'string'
			? { id: category.id, name: category.name }
			: null,
	);
	return categories.includes(null) ? null : categories;
}

// Keeps exactly the contract's Post fields. `selected_follower_ids` exists
// only on the author's own copy; any other key a response carries (follower
// identities, emails, internal names) is dropped here.
export function normalizePost(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!isValidId(value.author_id) ||
		typeof value.author !== 'string' ||
		!(value.title === null || typeof value.title === 'string') ||
		typeof value.body !== 'string' ||
		!STATUSES.has(value.status) ||
		!AUDIENCES.has(value.audience) ||
		!isValidId(value.version) ||
		typeof value.created_at !== 'string' ||
		typeof value.updated_at !== 'string' ||
		count(value.likes) === null ||
		count(value.dislikes) === null ||
		!REACTIONS.has(value.my_reaction)
	) {
		return null;
	}
	const categories = normalizeCategories(value.categories);
	if (!categories) return null;
	const post = {
		id: value.id,
		author_id: value.author_id,
		author: value.author,
		title: value.title,
		body: value.body,
		image_url: safeMediaUrl(value.image_url),
		status: value.status,
		audience: value.audience,
		version: value.version,
		categories,
		created_at: value.created_at,
		updated_at: value.updated_at,
		likes: value.likes,
		dislikes: value.dislikes,
		my_reaction: value.my_reaction,
	};
	if (value.selected_follower_ids !== undefined) {
		const selected = idList(value.selected_follower_ids);
		if (!selected) return null;
		post.selected_follower_ids = selected;
	}
	return post;
}

export function normalizeDraft(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!(value.title === null || typeof value.title === 'string') ||
		typeof value.body !== 'string' ||
		!AUDIENCES.has(value.audience) ||
		!isValidId(value.version) ||
		typeof value.updated_at !== 'string'
	) {
		return null;
	}
	const categoryIds = idList(value.category_ids);
	const selected = idList(value.selected_follower_ids);
	if (!categoryIds || !selected) return null;
	return {
		id: value.id,
		title: value.title,
		body: value.body,
		image_url: safeMediaUrl(value.image_url),
		category_ids: categoryIds,
		updated_at: value.updated_at,
		audience: value.audience,
		version: value.version,
		selected_follower_ids: selected,
	};
}

function normalizePagination(meta) {
	const page = meta?.pagination;
	const values = page && [page.page, page.per_page, page.total, page.total_pages].map(count);
	if (!values || values.includes(null)) return null;
	const [current, perPage, total, totalPages] = values;
	return { page: current, per_page: perPage, total, total_pages: totalPages };
}

function query(entries) {
	const params = new URLSearchParams();
	for (const [key, value] of entries) {
		if (value !== undefined && value !== null) params.set(key, String(value));
	}
	const text = params.toString();
	return text ? `?${text}` : '';
}

function postList(result) {
	if (result.status !== 'ok') return result;
	if (!Array.isArray(result.data)) return { status: 'unavailable' };
	const posts = result.data.map(normalizePost);
	const pagination = normalizePagination(result.meta);
	if (posts.includes(null) || !pagination) return { status: 'unavailable' };
	return { status: 'ok', posts, pagination };
}

function postResult(result) {
	if (result.status !== 'ok') return result;
	const post = normalizePost(result.data);
	return post ? { status: 'ok', post } : { status: 'unavailable' };
}

// Default values are omitted so the request matches the contract's canonical
// form: `feed=all` and page 1 are implied.
export async function fetchFeed(
	{ feed = 'all', categoryId = null, page = 1, perPage } = {},
	fetchRef,
) {
	const path = `/posts${query([
		['page', page > 1 ? page : null],
		['per_page', perPage],
		['feed', feed === 'following' ? 'following' : null],
		['category_id', categoryId],
	])}`;
	return postList(await send(path, {}, fetchRef));
}

export async function fetchMyPosts({ status = 'all', page = 1, perPage } = {}, fetchRef) {
	const path = `/posts/mine${query([
		['page', page > 1 ? page : null],
		['per_page', perPage],
		['status', status === 'all' ? null : status],
	])}`;
	return postList(await send(path, {}, fetchRef));
}

export async function fetchPost(postId, fetchRef) {
	return postResult(await send(`/posts/${postId}`, {}, fetchRef));
}

export async function fetchLatestDraft(fetchRef) {
	const result = await send('/posts/draft', {}, fetchRef);
	if (result.status !== 'ok') return result;
	if (result.data === null) return { status: 'ok', draft: null };
	const draft = normalizeDraft(result.data);
	return draft ? { status: 'ok', draft } : { status: 'unavailable' };
}

export async function fetchCategories(fetchRef) {
	const result = await send('/categories', {}, fetchRef);
	if (result.status !== 'ok') return result;
	const categories = normalizeCategories(result.data);
	return categories ? { status: 'ok', categories } : { status: 'unavailable' };
}

// Field names follow the contract; `undefined` means "not supplied", which on
// an edit preserves the stored value. A File in `image` switches to multipart.
function wireFields(fields) {
	const wire = {};
	if (fields.expectedVersion !== undefined) wire.expected_version = fields.expectedVersion;
	if (fields.title !== undefined) wire.title = fields.title;
	if (fields.body !== undefined) wire.body = fields.body;
	if (fields.categoryIds !== undefined) wire.category_ids = [...fields.categoryIds];
	if (fields.removeImage) wire.remove_image = true;
	if (fields.audience !== undefined) wire.audience = fields.audience;
	if (fields.selectedFollowerIds !== undefined) {
		wire.selected_follower_ids = [...fields.selectedFollowerIds];
	}
	if (fields.status !== undefined) wire.status = fields.status;
	return wire;
}

// Multipart scalars occur once; arrays repeat the field, and a single empty
// value clears the array. A null title is sent as empty text, which the
// server normalizes to null.
function multipart(wire, image) {
	const form = new FormData();
	for (const [key, value] of Object.entries(wire)) {
		if (Array.isArray(value)) {
			if (value.length === 0) form.append(key, '');
			for (const id of value) form.append(key, String(id));
		} else {
			form.append(key, value === null ? '' : String(value));
		}
	}
	form.append('image', image);
	return form;
}

function body(fields) {
	const wire = wireFields(fields);
	return fields.image instanceof Blob ? { form: multipart(wire, fields.image) } : { json: wire };
}

export async function createPost(fields, fetchRef) {
	return postResult(await send('/posts', { method: 'POST', ...body(fields) }, fetchRef));
}

export async function updatePost(postId, fields, fetchRef) {
	return postResult(await send(`/posts/${postId}`, { method: 'PATCH', ...body(fields) }, fetchRef));
}

export async function deletePost(postId, expectedVersion, fetchRef) {
	const path = `/posts/${postId}${query([['expected_version', expectedVersion]])}`;
	const result = await send(path, { method: 'DELETE' }, fetchRef);
	return result.status === 'ok' ? { status: 'ok' } : result;
}

// Always creates a new draft; it never saves onto an existing one.
export async function createDraft(fields, fetchRef) {
	const result = await send('/posts/draft', { method: 'POST', ...body(fields) }, fetchRef);
	if (result.status !== 'ok') return result;
	const { id, version } = result.data ?? {};
	return isValidId(id) && isValidId(version)
		? { status: 'ok', draft: { id, version } }
		: { status: 'unavailable' };
}

// 204 carries no new version; callers reload the draft to obtain it.
export async function updateDraft(postId, fields, fetchRef) {
	const result = await send(`/posts/draft/${postId}`, { method: 'PUT', ...body(fields) }, fetchRef);
	return result.status === 'ok' ? { status: 'ok' } : result;
}

export async function deleteDraft(postId, expectedVersion, fetchRef) {
	const path = `/posts/draft/${postId}${query([['expected_version', expectedVersion]])}`;
	const result = await send(path, { method: 'DELETE' }, fetchRef);
	return result.status === 'ok' ? { status: 'ok' } : result;
}

// Discussions use the same transport, error mapping and checked media policy.
export function normalizeComment(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!isValidId(value.post_id) ||
		!isValidId(value.user_id) ||
		typeof value.username !== 'string' ||
		typeof value.body !== 'string' ||
		!(value.parent_comment_id === null || isValidId(value.parent_comment_id)) ||
		!isValidId(value.version) ||
		typeof value.created_at !== 'string' ||
		typeof value.updated_at !== 'string' ||
		count(value.likes) === null ||
		count(value.dislikes) === null ||
		!REACTIONS.has(value.my_reaction)
	)
		return null;
	return Object.fromEntries(
		[
			'id',
			'post_id',
			'user_id',
			'username',
			'parent_comment_id',
			'body',
			'version',
			'created_at',
			'updated_at',
			'likes',
			'dislikes',
			'my_reaction',
		]
			.map((key) => [key, value[key]])
			.concat([['image_url', safeMediaUrl(value.image_url)]]),
	);
}
function commentResult(result) {
	if (result.status !== 'ok') return result;
	const comment = normalizeComment(result.data);
	return comment ? { status: 'ok', comment } : { status: 'unavailable' };
}
function listQuery({ page = 1, perPage } = {}) {
	return query([
		['page', page > 1 ? page : null],
		['per_page', perPage],
	]);
}
function commentList(result) {
	if (result.status !== 'ok') return result;
	const comments = Array.isArray(result.data) ? result.data.map(normalizeComment) : null;
	const pagination = normalizePagination(result.meta);
	return comments && !comments.includes(null) && pagination
		? { status: 'ok', comments, pagination }
		: { status: 'unavailable' };
}
export async function fetchComments(id, options = {}, fetchRef) {
	return commentList(await send(`/posts/${id}/comments${listQuery(options)}`, {}, fetchRef));
}
export async function fetchComment(id, fetchRef) {
	return commentResult(await send(`/comments/${id}`, {}, fetchRef));
}
function commentBody(fields) {
	const wire = {};
	if (fields.body !== undefined) wire.body = fields.body;
	if (fields.parentCommentId !== undefined) wire.parent_comment_id = fields.parentCommentId;
	if (fields.expectedVersion !== undefined) wire.expected_version = fields.expectedVersion;
	if (fields.removeImage) wire.remove_image = true;
	if (fields.image instanceof Blob) {
		if (wire.parent_comment_id === null) delete wire.parent_comment_id;
		return { form: multipart(wire, fields.image) };
	}
	return { json: wire };
}
export async function createComment(id, fields, fetchRef) {
	return commentResult(
		await send(`/posts/${id}/comments`, { method: 'POST', ...commentBody(fields) }, fetchRef),
	);
}
export async function updateComment(id, fields, fetchRef) {
	return commentResult(
		await send(`/comments/${id}`, { method: 'PATCH', ...commentBody(fields) }, fetchRef),
	);
}
export async function deleteComment(id, version, fetchRef) {
	const result = await send(
		`/comments/${id}${query([['expected_version', version]])}`,
		{ method: 'DELETE' },
		fetchRef,
	);
	return result.status === 'ok' ? { status: 'ok' } : result;
}
export async function reactToContent(kind, id, reaction, fetchRef) {
	if (!['posts', 'comments'].includes(kind) || !['like', 'dislike'].includes(reaction))
		return { status: 'rejected' };
	const result = await send(`/${kind}/${id}/${reaction}`, { method: 'POST' }, fetchRef);
	if (result.status !== 'ok') return result;
	const data = result.data;
	const key = kind === 'posts' ? 'post_id' : 'comment_id';
	return data?.[key] === id &&
		REACTIONS.has(data.reaction) &&
		count(data.likes_count) !== null &&
		count(data.dislikes_count) !== null
		? {
				status: 'ok',
				reaction: data.reaction,
				likes: data.likes_count,
				dislikes: data.dislikes_count,
			}
		: { status: 'unavailable' };
}
export async function fetchNavigation(id, { feed = 'all', categoryId = null } = {}, fetchRef) {
	const result = await send(
		`/posts/${id}/nav${query([
			['category_id', categoryId],
			['feed', feed === 'following' ? feed : null],
		])}`,
		{},
		fetchRef,
	);
	if (result.status !== 'ok') return result;
	const data = result.data;
	const nullableId = (value) => value === null || isValidId(value);
	return data && ['category_id', 'prev_id', 'next_id'].every((key) => nullableId(data[key]))
		? {
				status: 'ok',
				navigation: { category_id: data.category_id, prev_id: data.prev_id, next_id: data.next_id },
			}
		: { status: 'unavailable' };
}
export async function fetchProfilePosts(id, options = {}, fetchRef) {
	return postList(await send(`/users/${id}/posts${listQuery(options)}`, {}, fetchRef));
}
export async function fetchProfileComments(id, options = {}, fetchRef) {
	return commentList(await send(`/users/${id}/comments${listQuery(options)}`, {}, fetchRef));
}
function activityComment(value) {
	const comment = normalizeComment(value);
	const post = value?.post;
	const categories = normalizeCategories(post?.categories);
	if (
		!comment ||
		!post ||
		!isValidId(post.id) ||
		post.id !== comment.post_id ||
		!isValidId(post.author_id) ||
		typeof post.author !== 'string' ||
		!(post.title === null || typeof post.title === 'string') ||
		!categories ||
		count(post.likes) === null ||
		count(post.dislikes) === null ||
		!REACTIONS.has(post.my_reaction)
	)
		return null;
	return {
		...comment,
		post: {
			id: post.id,
			author_id: post.author_id,
			author: post.author,
			title: post.title,
			image_url: safeMediaUrl(post.image_url),
			categories,
			likes: post.likes,
			dislikes: post.dislikes,
			my_reaction: post.my_reaction,
		},
	};
}
export async function fetchActivity({ status = 'all', ...options } = {}, fetchRef) {
	const params = new URLSearchParams(listQuery(options).slice(1));
	if (status !== 'all') params.set('status', status);
	const result = await send(`/users/activity${params.size ? `?${params}` : ''}`, {}, fetchRef);
	if (result.status !== 'ok') return result;
	const activity = {};
	for (const key of ['created_posts', 'liked_posts', 'disliked_posts', 'comments']) {
		const section = result.data?.[key];
		const items = Array.isArray(section?.items)
			? section.items.map(key === 'comments' ? activityComment : normalizePost)
			: null;
		const pagination = normalizePagination({ pagination: section?.pagination });
		if (!items || items.includes(null) || !pagination) return { status: 'unavailable' };
		activity[key] = { items, pagination };
	}
	return { status: 'ok', activity };
}
