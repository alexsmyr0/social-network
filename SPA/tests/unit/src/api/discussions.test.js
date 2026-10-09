// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import * as api from '../../../../src/api/content.js';
import {
	loadContentFixtures,
	pngBytes,
	readForm,
} from '../../../fixtures/phase3/content-backend.js';

const cases = loadContentFixtures().cases.filter((c) =>
	/^\/api\/v1\/(comments\/|posts\/\d+\/(comments|nav|like|dislike)|users\/(activity|\d+\/(posts|comments)))/u.test(
		c.request.path,
	),
);
function fields(request) {
	const wire = request.body ?? request.fields ?? {};
	const names = {
		body: 'body',
		expected_version: 'expectedVersion',
		parent_comment_id: 'parentCommentId',
		remove_image: 'removeImage',
	};
	const result = {};
	for (const [key, value] of Object.entries(wire))
		result[names[key]] =
			['expected_version', 'parent_comment_id'].includes(key) && value !== null
				? Number(value)
				: value;
	if (request.files?.image)
		result.image = new File([pngBytes()], 'avatar.png', { type: 'image/png' });
	return result;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dispatch approved fixtures across distinct client routes
function call(request, fetchRef) {
	const url = new URL(request.path, 'http://test');
	const params = url.searchParams;
	const options = {
		page: Number(params.get('page') ?? 1),
		perPage: params.has('per_page') ? Number(params.get('per_page')) : undefined,
	};
	const path = url.pathname.replace('/api/v1', '');
	if (path === '/users/activity')
		return api.fetchActivity({ ...options, status: params.get('status') ?? 'all' }, fetchRef);
	const profile = path.match(/^\/users\/(\d+)\/(posts|comments)$/u);
	if (profile)
		return (profile[2] === 'posts' ? api.fetchProfilePosts : api.fetchProfileComments)(
			Number(profile[1]),
			options,
			fetchRef,
		);
	const reaction = path.match(/^\/(posts|comments)\/(\d+)\/(like|dislike)$/u);
	if (reaction) return api.reactToContent(reaction[1], Number(reaction[2]), reaction[3], fetchRef);
	const nav = path.match(/^\/posts\/(\d+)\/nav$/u);
	if (nav)
		return api.fetchNavigation(
			Number(nav[1]),
			{
				categoryId: params.has('category_id') ? Number(params.get('category_id')) : null,
				feed: params.get('feed') ?? 'all',
			},
			fetchRef,
		);
	const thread = path.match(/^\/posts\/(\d+)\/comments$/u);
	if (thread)
		return request.method === 'GET'
			? api.fetchComments(Number(thread[1]), options, fetchRef)
			: api.createComment(Number(thread[1]), fields(request), fetchRef);
	const id = Number(path.split('/').at(-1));
	if (request.method === 'DELETE')
		return api.deleteComment(id, Number(params.get('expected_version')), fetchRef);
	if (request.method === 'PATCH') return api.updateComment(id, fields(request), fetchRef);
	return api.fetchComment(id, fetchRef);
}
const statuses = {
	204: 'ok',
	400: 'rejected',
	401: 'unauthenticated',
	404: 'not-found',
	409: 'stale',
};
describe('SN-A13 approved contract replay', () => {
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verify request and each approved response schema
	test.each(cases.map((c) => [c.name, c]))('%s', async (_name, c) => {
		const fetchRef = vi.fn(async () => ({
			ok: c.response.status < 400,
			status: c.response.status,
			json: async () => structuredClone(c.response.body),
		}));
		const result = await call(c.request, fetchRef);
		expect(result.status).toBe(statuses[c.response.status] ?? 'ok');
		const [path, init] = fetchRef.mock.calls[0];
		expect(path).toBe(c.request.path);
		expect(init.method).toBe(c.request.method);
		expect(init.credentials).toBe('include');
		if (init.method !== 'GET') expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
		if (c.request.body) expect(JSON.parse(init.body)).toEqual(c.request.body);
		if (c.request.fields)
			expect((await readForm(init.body)).fields).toEqual(
				Object.fromEntries(Object.entries(c.request.fields).map(([k, v]) => [k, [v]])),
			);
		if (c.response.status !== 200 && c.response.status !== 201) return;
		const data = c.response.body.data;
		if (result.comment) expect(result.comment).toEqual(data);
		if (result.comments) {
			expect(result.comments).toEqual(data);
			expect(result.pagination).toEqual(c.response.body.meta.pagination);
		}
		if (result.posts) {
			expect(result.posts).toEqual(data);
			expect(result.pagination).toEqual(c.response.body.meta.pagination);
		}
		if (result.activity) expect(result.activity).toEqual(data);
		if (result.navigation) expect(result.navigation).toEqual(data);
		if (result.reaction !== undefined)
			expect(result).toEqual({
				status: 'ok',
				reaction: data.reaction,
				likes: data.likes_count,
				dislikes: data.dislikes_count,
			});
	});
	test('comment normalizer drops private fields and unsafe images and rejects malformed records', () => {
		const comment = loadContentFixtures().state.comments['201'];
		expect(
			api.normalizeComment({
				...comment,
				email: 'secret',
				avatar_url: '/secret',
				image_url: 'https://external.test/x',
			}),
		).toEqual({ ...comment, image_url: null });
		for (const patch of [
			{ parent_comment_id: 0 },
			{ version: 0 },
			{ my_reaction: 4 },
			{ username: null },
			{ likes: -1 },
		])
			expect(api.normalizeComment({ ...comment, ...patch })).toBeNull();
	});
	test('image-only top-level multipart omits nullable parent rather than sending an invalid decimal', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: false,
			status: 404,
			json: async () => ({ error: { code: 'NOT_FOUND' } }),
		}));
		await api.createComment(
			101,
			{
				body: '',
				parentCommentId: null,
				image: new File([pngBytes()], 'avatar.png', { type: 'image/png' }),
			},
			fetchRef,
		);
		const form = fetchRef.mock.calls[0][1].body;
		expect(form.has('parent_comment_id')).toBe(false);
		expect(form.get('body')).toBe('');
	});
	test.each([500, 503])('outage %s is distinct from denial', async (status) => {
		expect(
			(
				await api.fetchComments(101, {}, async () => ({
					ok: false,
					status,
					json: async () => ({ error: { code: 'INTERNAL_SERVER_ERROR' } }),
				}))
			).status,
		).toBe('unavailable');
	});
	test('corrupt activity and navigation fail closed', async () => {
		const fetchRef = (data) => async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data }),
		});
		const activity = await api.fetchActivity(
			{},
			fetchRef({ created_posts: { items: [], pagination: {} } }),
		);
		const nav = await api.fetchNavigation(
			101,
			{},
			fetchRef({ category_id: null, prev_id: -1, next_id: null }),
		);
		expect(activity.status).toBe('unavailable');
		expect(nav.status).toBe('unavailable');
	});
});
