// @vitest-environment jsdom
// SN-A16: the content client against the approved SN-B17 group-content cases.
// Every case the client can express replays through the real functions with its
// exact request and normalized result; the rest are server-only rejections
// (malformed IDs, wrong scalar types, edits that move a post between groups)
// whose outcome mapping is still checked.
import { describe, expect, test, vi } from 'vitest';

import * as api from '../../../../src/api/content.js';
import {
	fetchNotifications,
	markAllNotificationsRead,
	markNotificationRead,
} from '../../../../src/api/social.js';
import { loadGroupFixtures } from '../../../fixtures/phase4/group-backend.js';
import { readForm } from '../../../fixtures/phase4/group-content-backend.js';

const pack = loadGroupFixtures();
const GROUP_ROUTE =
	/^\/api\/v1\/(groups|group-invitations\/|group-join-requests\/|group-memberships\/|users\/me\/group-invitations)/u;
const GROUP_NOTICE_CASES = new Set([
	'notices-invitee-pending',
	'notices-creator-pending-request',
	'notices-invitee-resolved-states',
	'notices-creator-resolved-states',
	'notice-read-one-keeps-actions',
	'notice-read-all-keeps-pending-request',
	'notice-foreign-read',
]);
const contentOwned = pack.cases.filter(
	(c) => !(GROUP_ROUTE.test(c.request.path) || GROUP_NOTICE_CASES.has(c.name)),
);
// Image bytes are loaded by <img> from checked same-origin URLs, and the
// liked/category-view lists have no screen that calls them (activity uses
// /users/activity), so no client function exists for these routes.
const NO_CLIENT_ROUTE =
	/^\/api\/v1\/(media\/|static\/uploads\/|posts\/(liked|disliked)$|categories\/view$)/u;
const cases = contentOwned.filter((c) => !NO_CLIENT_ROUTE.test(c.request.path));

// Requests the client cannot produce: a non-decimal group_id, a string where
// a number is required, an ID of zero, and any edit carrying group_id.
const SERVER_ONLY = new Set([
	'group-feed-bad-group-id',
	'post-create-group-id-zero',
	'post-create-group-id-string',
	'post-edit-group-id-immutable',
	'post-edit-personal-to-group-immutable',
]);

const NAMES = {
	title: 'title',
	body: 'body',
	category_ids: 'categoryIds',
	audience: 'audience',
	selected_follower_ids: 'selectedFollowerIds',
	status: 'status',
	group_id: 'groupId',
	expected_version: 'expectedVersion',
	parent_comment_id: 'parentCommentId',
	remove_image: 'removeImage',
};

function fields(body = {}) {
	const result = {};
	for (const [key, value] of Object.entries(body)) result[NAMES[key]] = value;
	return result;
}

function listOptions(params) {
	return {
		page: params.has('page') ? Number(params.get('page')) : 1,
		perPage: params.has('per_page') ? Number(params.get('per_page')) : undefined,
	};
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dispatch approved fixtures across distinct client routes
function call(request, fetchRef) {
	const url = new URL(request.path, 'http://test');
	const params = url.searchParams;
	const path = url.pathname.replace('/api/v1', '');
	const id = Number(path.split('/').at(-1));
	const group = params.has('group_id') ? Number(params.get('group_id')) : null;
	const category = params.has('category_id') ? Number(params.get('category_id')) : null;
	if (path === '/notifications') return fetchNotifications(listOptions(params), fetchRef);
	if (path === '/notifications/read-all') return markAllNotificationsRead(fetchRef);
	const read = path.match(/^\/notifications\/(\d+)\/read$/u);
	if (read) return markNotificationRead(Number(read[1]), fetchRef);
	if (path === '/users/activity')
		return api.fetchActivity(
			{ ...listOptions(params), status: params.get('status') ?? 'all' },
			fetchRef,
		);
	if (path === '/posts/mine')
		return api.fetchMyPosts({ status: params.get('status') ?? 'all' }, fetchRef);
	if (path === '/posts/draft') {
		return request.method === 'GET'
			? api.fetchLatestDraft({ groupId: group }, fetchRef)
			: api.createDraft(fields(request.body), fetchRef);
	}
	if (path === '/posts') {
		if (request.method === 'POST') return api.createPost(fields(request.body), fetchRef);
		return api.fetchFeed(
			{
				...listOptions(params),
				feed: params.get('feed') ?? 'all',
				categoryId: category,
				groupId: group,
			},
			fetchRef,
		);
	}
	const profile = path.match(/^\/users\/(\d+)\/(posts|comments)$/u);
	if (profile)
		return (profile[2] === 'posts' ? api.fetchProfilePosts : api.fetchProfileComments)(
			Number(profile[1]),
			listOptions(params),
			fetchRef,
		);
	const reaction = path.match(/^\/(posts|comments)\/(\d+)\/(like|dislike)$/u);
	if (reaction) return api.reactToContent(reaction[1], Number(reaction[2]), reaction[3], fetchRef);
	const nav = path.match(/^\/posts\/(\d+)\/nav$/u);
	if (nav)
		return api.fetchNavigation(
			Number(nav[1]),
			{ categoryId: category, feed: params.get('feed') ?? 'all', groupId: group },
			fetchRef,
		);
	const thread = path.match(/^\/posts\/(\d+)\/comments$/u);
	if (thread)
		return request.method === 'GET'
			? api.fetchComments(Number(thread[1]), listOptions(params), fetchRef)
			: api.createComment(Number(thread[1]), fields(request.body), fetchRef);
	if (/^\/comments\/\d+$/u.test(path)) {
		if (request.method === 'DELETE')
			return api.deleteComment(id, Number(params.get('expected_version')), fetchRef);
		return request.method === 'PATCH'
			? api.updateComment(id, fields(request.body), fetchRef)
			: api.fetchComment(id, fetchRef);
	}
	if (/^\/posts\/\d+$/u.test(path)) {
		if (request.method === 'DELETE')
			return api.deletePost(id, Number(params.get('expected_version')), fetchRef);
		return request.method === 'PATCH'
			? api.updatePost(id, fields(request.body), fetchRef)
			: api.fetchPost(id, fetchRef);
	}
	throw new Error(`No client mapping for ${request.method} ${request.path}`);
}

function expectedStatus(response) {
	const code = response.body?.error?.code;
	if (response.status < 300) return 'ok';
	if (response.status === 401) return 'unauthenticated';
	if (response.status === 404) return 'not-found';
	if (response.status === 409 && code === 'STALE_CONTENT') return 'stale';
	if (response.status === 413) return 'too-large';
	if (response.status === 422) return 'invalid-image';
	return 'rejected';
}

// Personal content has no `group` key once normalized (Phase 3 shapes are
// unchanged); the approved wire carries `group: null`.
function withoutNullGroup(value) {
	if (Array.isArray(value)) return value.map(withoutNullGroup);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key, item]) => !(key === 'group' && item === null))
			.map(([key, item]) => [key, withoutNullGroup(item)]),
	);
}

function respond(c) {
	return vi.fn(async () => ({
		ok: c.response.status < 400,
		status: c.response.status,
		json: async () => {
			if (c.response.body === null || c.response.body === undefined) throw new SyntaxError('empty');
			return structuredClone(c.response.body);
		},
	}));
}

describe('SN-A16 approved group-content contract replay', () => {
	test('covers every client-expressible content case', () => {
		expect(contentOwned).toHaveLength(184);
		expect(cases).toHaveLength(146);
		expect(cases.filter((c) => SERVER_ONLY.has(c.name))).toHaveLength(SERVER_ONLY.size);
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verify request and each approved response schema
	test.each(cases.map((c) => [c.name, c]))('%s', async (_name, c) => {
		const fetchRef = respond(c);
		const result = await call(c.request, fetchRef);
		expect(result.status).toBe(expectedStatus(c.response));
		expect(fetchRef).toHaveBeenCalledTimes(1);
		const [path, init] = fetchRef.mock.calls[0];
		expect(init.credentials).toBe('include');
		if (!SERVER_ONLY.has(c.name)) {
			// Same route and the same query set, in the client's own order.
			const [expectedPath, expectedQuery] = c.request.path.split('?');
			const [actualPath, actualQuery] = path.split('?');
			expect(actualPath).toBe(expectedPath);
			expect(Object.fromEntries(new URLSearchParams(actualQuery))).toEqual(
				Object.fromEntries(new URLSearchParams(expectedQuery)),
			);
			expect(init.method).toBe(c.request.method);
			if (init.method !== 'GET') expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
			if (c.request.body) expect(JSON.parse(init.body)).toEqual(c.request.body);
			else expect(init.body).toBeUndefined();
		}
		if (c.response.status !== 200 && c.response.status !== 201) return;
		const { data, meta } = c.response.body;
		const expected = withoutNullGroup(data);
		for (const key of ['posts', 'comments']) {
			if (!result[key]) continue;
			expect(result[key]).toEqual(expected);
			expect(result.pagination).toEqual(meta.pagination);
		}
		for (const key of ['post', 'comment', 'activity', 'navigation'])
			if (result[key]) expect(result[key]).toEqual(expected);
		if (result.draft !== undefined) {
			if (data === null) expect(result.draft).toBeNull();
			else if (result.draft.title !== undefined) expect(result.draft).toEqual(expected);
			else expect(result.draft).toEqual({ id: data.id, version: data.version });
		}
		if (result.notifications) {
			expect(result.notifications).toEqual(data.notifications);
			expect(result.unreadCount).toBe(data.unread_count);
		}
		if (result.reaction !== undefined) {
			expect(result).toEqual({
				status: 'ok',
				reaction: data.reaction,
				likes: data.likes_count,
				dislikes: data.dislikes_count,
			});
		}
	});
});

function okResponse(data, meta) {
	return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data, meta }) }));
}
const caseBody = (name) => structuredClone(pack.cases.find((c) => c.name === name).response.body);
const groupPost = () => caseBody('matrix-member-111-detail').data;

describe('group-aware content normalization', () => {
	test('a group post keeps its scope and never carries recipients', () => {
		const post = { ...groupPost(), selected_follower_ids: [8, 9], email: 'secret@example.com' };
		const normalized = api.normalizePost(post);
		expect(normalized.group).toEqual({ id: 301, title: 'Chess Club' });
		expect(normalized.audience).toBe('group');
		expect(normalized.selected_follower_ids).toBeUndefined();
		expect(Object.keys(normalized)).not.toContain('email');
	});

	test('personal posts carry no group key, and the author keeps their recipients', () => {
		const personal = caseBody('personal-followers-post-readable-by-follower').data;
		expect('group' in api.normalizePost(personal)).toBe(false);
		const own = api.normalizePost({ ...personal, selected_follower_ids: [10] });
		expect(own.selected_follower_ids).toEqual([10]);
	});

	test('an audience that contradicts the group scope is a malformed response', () => {
		const group = groupPost();
		expect(api.normalizePost({ ...group, audience: 'public' })).toBeNull();
		expect(api.normalizePost({ ...group, group: null })).toBeNull();
		expect(api.normalizePost({ ...group, group: { id: 0, title: 'x' } })).toBeNull();
		expect(api.normalizePost({ ...group, group: { id: 301 } })).toBeNull();
		expect(api.normalizePost({ ...group, group: 'Chess Club' })).toBeNull();
		const personal = caseBody('personal-followers-post-readable-by-follower').data;
		expect(api.normalizePost({ ...personal, audience: 'group' })).toBeNull();
		expect(api.normalizePost({ ...personal, group: { id: 301, title: 'Chess Club' } })).toBeNull();
	});

	test('a group draft keeps its scope and has no recipients', () => {
		const draft = { ...caseBody('draft-latest-group-member').data, selected_follower_ids: [10] };
		const normalized = api.normalizeDraft(draft);
		expect(normalized.group).toEqual({ id: 301, title: 'Chess Club' });
		expect(normalized.selected_follower_ids).toEqual([]);
		expect(api.normalizeDraft({ ...draft, audience: 'public' })).toBeNull();
	});

	test('a comment activity parent carries its group only for a group post', async () => {
		const body = caseBody('profile-comments-departed-visible-to-member');
		const result = await api.fetchProfileComments(11, {}, okResponse(body.data, body.meta));
		expect(result.comments[0].post.group).toEqual({ id: 301, title: 'Chess Club' });
		const personal = structuredClone(body.data);
		delete personal[0].post.group;
		const plain = await api.fetchProfileComments(11, {}, okResponse(personal, body.meta));
		expect('group' in plain.comments[0].post).toBe(false);
		personal[0].post.group = { id: 301 };
		const broken = await api.fetchProfileComments(11, {}, okResponse(personal, body.meta));
		expect(broken.status).toBe('unavailable');
	});
});

describe('group scope on requests', () => {
	const sent = (fetchRef) => fetchRef.mock.calls[0];

	test('reads add group_id only when a group is named', async () => {
		const empty = okResponse([], {
			pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
		});
		await api.fetchFeed({ groupId: 301, feed: 'following', categoryId: 1, page: 2 }, empty);
		expect(sent(empty)[0]).toBe('/api/v1/posts?page=2&feed=following&category_id=1&group_id=301');
		const home = okResponse([], {
			pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
		});
		await api.fetchFeed({}, home);
		expect(sent(home)[0]).toBe('/api/v1/posts');
		const nav = okResponse({ category_id: null, prev_id: null, next_id: 111 });
		await api.fetchNavigation(112, { groupId: 301 }, nav);
		expect(sent(nav)[0]).toBe('/api/v1/posts/112/nav?group_id=301');
		const draft = okResponse(null);
		await api.fetchLatestDraft({ groupId: 301 }, draft);
		expect(sent(draft)[0]).toBe('/api/v1/posts/draft?group_id=301');
		const personal = okResponse(null);
		await api.fetchLatestDraft({}, personal);
		expect(sent(personal)[0]).toBe('/api/v1/posts/draft');
	});

	test('a new group post or draft sends group_id and no audience; multipart uses a decimal', async () => {
		const created = okResponse(groupPost());
		await api.createPost({ body: 'Hi', groupId: 301 }, created);
		expect(JSON.parse(sent(created)[1].body)).toEqual({ body: 'Hi', group_id: 301 });
		const withImage = okResponse({ id: 122, version: 1 });
		await api.createDraft(
			{
				body: 'x',
				groupId: 301,
				image: new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' }),
			},
			withImage,
		);
		const form = await readForm(sent(withImage)[1].body);
		expect(form.fields.group_id).toEqual(['301']);
		expect(form.fields.audience).toBeUndefined();
	});

	test('edits can never carry group_id, so a post cannot be moved between groups', async () => {
		const updated = okResponse(groupPost());
		await api.updatePost(111, { expectedVersion: 1, body: 'Edited', groupId: 302 }, updated);
		expect(JSON.parse(sent(updated)[1].body)).toEqual({ expected_version: 1, body: 'Edited' });
		const saved = vi.fn(async () => ({ ok: true, status: 204, json: async () => null }));
		await api.updateDraft(113, { expectedVersion: 1, body: 'x', groupId: 302 }, saved);
		expect(JSON.parse(sent(saved)[1].body)).toEqual({ expected_version: 1, body: 'x' });
	});

	test('membership-loss answers are not-found, and field errors name their code', async () => {
		const gone = vi.fn(async () => ({
			ok: false,
			status: 404,
			json: async () => caseBody('post-create-in-group-outsider'),
		}));
		expect((await api.createPost({ body: 'x', groupId: 301 }, gone)).status).toBe('not-found');
		const scope = vi.fn(async () => ({
			ok: false,
			status: 400,
			json: async () => caseBody('post-create-group-with-audience'),
		}));
		const result = await api.createPost({ body: 'x', groupId: 301, audience: 'followers' }, scope);
		expect(result).toEqual({
			status: 'rejected',
			code: 'VALIDATION_ERROR',
			fields: { audience: 'GROUP_SCOPE' },
		});
	});
});
