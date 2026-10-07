// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import * as api from '../../../../src/api/content.js';
import {
	loadContentFixtures,
	pngBytes,
	readForm,
} from '../../../fixtures/phase3/content-backend.js';

const fixtures = loadContentFixtures();
// SN-A12 consumes the feed/detail/mine/draft/category-metadata reads and the
// post/draft mutations. Discussions, reactions, activity, navigation, media
// bytes and category projections belong to SN-A13.
const A12_ROUTE = /^\/api\/v1\/(posts(\/mine|\/draft(\/\d+)?|\/\d+)?|categories)(\?|$)/u;
const cases = fixtures.cases.filter((item) => A12_ROUTE.test(item.request.path));

const WIRE_TO_CLIENT = {
	expected_version: 'expectedVersion',
	title: 'title',
	body: 'body',
	category_ids: 'categoryIds',
	audience: 'audience',
	selected_follower_ids: 'selectedFollowerIds',
	status: 'status',
};

// Client fields that would reproduce a JSON body, or null when the body is
// something the client never sends (unknown keys, null body, false flags).
function clientFields(body) {
	const fields = {};
	for (const [key, value] of Object.entries(body)) {
		if (key === 'remove_image' && value === true) fields.removeImage = true;
		else if (WIRE_TO_CLIENT[key] && (value !== null || key === 'title')) {
			fields[WIRE_TO_CLIENT[key]] = value;
		} else return null;
	}
	return fields;
}

function fixtureFile(spec) {
	if (typeof spec === 'string') return new File([pngBytes()], 'avatar.png', { type: 'image/png' });
	if (spec.literal) return new File([spec.literal], spec.filename, { type: spec.mime });
	return new File([new Uint8Array(spec.count).fill(spec.repeat_byte)], spec.filename, {
		type: spec.mime,
	});
}

function multipartFields(request) {
	const fields = {};
	for (const [key, value] of Object.entries(request.fields ?? {})) {
		if (key === 'category_ids' || key === 'selected_follower_ids') {
			const ids = (Array.isArray(value) ? value : [value]).filter((item) => item !== '');
			fields[WIRE_TO_CLIENT[key]] = ids.map(Number);
		} else if (key === 'expected_version') fields.expectedVersion = Number(value);
		else fields[WIRE_TO_CLIENT[key] ?? key] = value;
	}
	if (request.files?.image) fields.image = fixtureFile(request.files.image);
	return fields;
}

function feedInvocation(url) {
	const params = Object.fromEntries(url.searchParams);
	const repeated = [...url.searchParams.keys()].length !== Object.keys(params).length;
	const known = Object.keys(params).every((key) =>
		['page', 'feed', 'category_id', 'per_page'].includes(key),
	);
	const options = {
		page: params.page ? Number(params.page) : 1,
		perPage: params.per_page ? Number(params.per_page) : undefined,
		feed: params.feed ?? 'all',
		categoryId: params.category_id ? Number(params.category_id) : null,
	};
	const canonical =
		known &&
		!repeated &&
		options.page >= 1 &&
		['all', 'following'].includes(options.feed) &&
		!(options.perPage > 50);
	return { call: (f) => api.fetchFeed(canonical ? options : {}, f), exact: canonical };
}

// Reads keyed by "METHOD route"; `:id` is the trailing decimal segment.
const READS = {
	'GET /api/v1/posts/mine': (url) => (f) =>
		api.fetchMyPosts({ status: url.searchParams.get('status') ?? 'all' }, f),
	'GET /api/v1/posts/draft': () => (f) => api.fetchLatestDraft(f),
	'GET /api/v1/posts/:id': (_url, id) => (f) => api.fetchPost(id, f),
	'GET /api/v1/categories': () => (f) => api.fetchCategories(f),
	'DELETE /api/v1/posts/:id': (url, id) => (f) =>
		api.deletePost(id, Number(url.searchParams.get('expected_version')), f),
	'DELETE /api/v1/posts/draft/:id': (url, id) => (f) =>
		api.deleteDraft(id, Number(url.searchParams.get('expected_version')), f),
};

const WRITES = {
	'POST /api/v1/posts': () => api.createPost,
	'POST /api/v1/posts/draft': () => api.createDraft,
	'PATCH /api/v1/posts/:id': (id) => (values, f) => api.updatePost(id, values, f),
	'PUT /api/v1/posts/draft/:id': (id) => (values, f) => api.updateDraft(id, values, f),
};

// The client call a case exercises, and whether the client can reproduce its
// exact request. Structural/transport cases still check response handling.
function invocation(item) {
	const { method, path, body, encoding, headers } = item.request;
	const url = new URL(path, 'http://fixture.test');
	const id = Number(url.pathname.split('/').at(-1));
	const key = `${method} ${url.pathname.replace(/\/\d+$/u, '/:id')}`;
	if (key === 'GET /api/v1/posts') return feedInvocation(url);
	if (READS[key]) return { call: READS[key](url, id), exact: true };
	if (WRITES[key]) {
		const raw = encoding === 'raw_json' || item.request.raw_body !== undefined || headers;
		const fields =
			encoding === 'multipart' ? multipartFields(item.request) : clientFields(body ?? {});
		const send = WRITES[key](id);
		return { call: (f) => send(fields ?? {}, f), exact: !raw && !!fields };
	}
	if (key === 'PUT /api/v1/posts/:id') {
		// No client function issues PUT on a post; check 405 handling only.
		return { call: (f) => api.updatePost(id, { body: 'x', expectedVersion: 1 }, f), exact: false };
	}
	throw new Error(`No client mapping for ${method} ${path}`);
}

function respondWith(item) {
	const calls = [];
	async function fetchRef(url, init = {}) {
		calls.push({ url, init });
		const { status, body } = item.response;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => {
				if (body === undefined || body === null) throw new SyntaxError('empty body');
				return structuredClone(body);
			},
		};
	}
	fetchRef.calls = calls;
	return fetchRef;
}

function expectedOutcome(response) {
	const { status, body } = response;
	const error = body?.error;
	if (status === 204 || (status >= 200 && status < 300)) return 'ok';
	if (status === 401) return 'unauthenticated';
	if (status === 404) return 'not-found';
	if (status === 409) return 'stale';
	if (status === 413) return 'too-large';
	if (status === 422) return 'invalid-image';
	if ([400, 403, 405, 415].includes(status) && error?.code) return 'rejected';
	return 'unavailable';
}

function payloadOf(result) {
	if (result.post) return result.post;
	if (result.posts) return result.posts;
	if ('draft' in result) return result.draft;
	if (result.categories) return result.categories;
	return undefined;
}

describe('SN-B14 content fixtures through the SN-A12 client', () => {
	test('covers every A12-owned approved HTTP case', () => {
		expect(cases.length).toBeGreaterThanOrEqual(120);
		const routes = new Set(
			cases.map(
				(item) =>
					`${item.request.method} ${item.request.path.split('?')[0].replace(/\d+/gu, ':id')}`,
			),
		);
		for (const route of [
			'GET /api/v:id/posts',
			'GET /api/v:id/posts/:id',
			'GET /api/v:id/posts/mine',
			'GET /api/v:id/posts/draft',
			'GET /api/v:id/categories',
			'POST /api/v:id/posts',
			'PATCH /api/v:id/posts/:id',
			'DELETE /api/v:id/posts/:id',
			'POST /api/v:id/posts/draft',
			'PUT /api/v:id/posts/draft/:id',
			'DELETE /api/v:id/posts/draft/:id',
		]) {
			expect(routes).toContain(route);
		}
	});

	test('reproduces the exact request of every case a client can send', () => {
		const exact = cases.filter((item) => invocation(item).exact).map((item) => item.name);
		// The other 17 are structural/transport probes (duplicate keys, wrong
		// origin or method, unknown fields, null values) the client never sends.
		expect(cases).toHaveLength(146);
		expect(exact).toHaveLength(129);
		for (const name of ['create-image-only', 'image-replacement', 'draft-partial-update']) {
			expect(exact).toContain(name);
		}
	});

	test.each(cases.map((item) => [item.name, item]))('%s', async (_name, item) => {
		const { call, exact } = invocation(item);
		const fetchRef = respondWith(item);
		const result = await call(fetchRef);
		expect(fetchRef.calls).toHaveLength(1);
		const [{ url, init }] = fetchRef.calls;
		expect(init.credentials).toBe('include');
		if (init.method !== 'GET') expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
		if (exact) await expectRequest(item.request, url, init);
		expectOutcome(item, result, url);
	});
});

async function expectRequest(request, url, init) {
	expect(init.method).toBe(request.method);
	expect(url).toBe(request.path);
	if (request.encoding === 'multipart') {
		expect(init.headers['Content-Type']).toBeUndefined();
		const form = await readForm(init.body);
		const expected = Object.fromEntries(
			Object.entries(request.fields ?? {}).map(([key, value]) => [
				key,
				Array.isArray(value) ? value : [String(value)],
			]),
		);
		expect(form.fields).toEqual(expected);
		expect(Boolean(form.image)).toBe(Boolean(request.files?.image));
	} else if (request.body !== undefined) {
		expect(init.headers['Content-Type']).toBe('application/json');
		expect(JSON.parse(init.body)).toEqual(request.body);
	} else {
		expect(init.body).toBeUndefined();
	}
}

function expectOutcome(item, result, url) {
	const outcome = expectedOutcome(item.response);
	expect(result.status).toBe(outcome);
	if (outcome === 'rejected') {
		expect(result.code).toBe(item.response.body.error.code);
		expect(result.fields).toEqual(item.response.body.error.fields ?? {});
	}
	if (outcome === 'invalid-image') expect(result.fields).toEqual({ image: 'INVALID_IMAGE' });
	// Error bodies never leak content: no version, selection or title.
	if (outcome !== 'ok') expect(payloadOf(result)).toBeUndefined();
	if (outcome !== 'ok' || item.response.status === 204) return;
	const data = item.response.body.data;
	if (url.endsWith('/categories')) {
		expect(result.categories).toEqual(data.map(({ id, name }) => ({ id, name })));
	} else if (url.includes('/posts/draft')) {
		expect(result.draft).toEqual(data);
	} else if (Array.isArray(data)) {
		expect(result.posts).toEqual(data);
		expect(result.pagination).toEqual(item.response.body.meta.pagination);
	} else {
		expect(result.post).toEqual(data);
		// Only the author's copy carries recipients; selected viewers never do.
		expect('selected_follower_ids' in result.post).toBe(item.viewer_id === data.author_id);
	}
}

describe('content client normalization and transport', () => {
	const post = structuredClone(fixtures.state.posts['101']);
	delete post.selected_follow_ids;

	function stub(status, body) {
		const calls = [];
		const fetchRef = async (url, init) => {
			calls.push({ url, init });
			return { ok: status < 300, status, json: async () => structuredClone(body) };
		};
		fetchRef.calls = calls;
		return fetchRef;
	}

	test('drops undeclared keys and refuses unchecked media URLs', async () => {
		const leaky = {
			...post,
			email: 'alex@example.com',
			follower_ids: [7],
			image_url: 'https://evil.example/x.png',
		};
		const result = await api.fetchPost(101, stub(200, { data: leaky }));
		expect(result.post).not.toHaveProperty('email');
		expect(result.post).not.toHaveProperty('follower_ids');
		expect(result.post.image_url).toBeNull();
		expect(api.safeMediaUrl('/static/uploads/legacy.png')).toBe('/static/uploads/legacy.png');
		expect(api.safeMediaUrl('/static/uploads/../users/me')).toBeNull();
		expect(api.safeMediaUrl('//evil.example/a.png')).toBeNull();
	});

	test('treats malformed or partial bodies as unavailable, never as content', async () => {
		expect(
			(await api.fetchPost(101, stub(200, { data: { ...post, audience: 'friends' } }))).status,
		).toBe('unavailable');
		expect(
			(await api.fetchPost(101, stub(200, { data: { ...post, selected_follower_ids: [0] } })))
				.status,
		).toBe('unavailable');
		expect((await api.fetchFeed({}, stub(200, { data: [post] }))).status).toBe('unavailable');
		expect((await api.fetchFeed({}, stub(500, { error: { code: 'X' } }))).status).toBe(
			'unavailable',
		);
		expect((await api.createDraft({}, stub(200, { data: { id: 1 } }))).status).toBe('unavailable');
		expect((await api.updatePost(1, {}, stub(409, { error: { code: 'OTHER' } }))).status).toBe(
			'unavailable',
		);
		const lost = async () => {
			throw new TypeError('network');
		};
		expect((await api.createPost({ body: 'x' }, lost)).status).toBe('unavailable');
	});

	test('encodes multipart edits with repeated arrays, empty clears and text titles', async () => {
		const fetchRef = stub(200, { data: post });
		const image = new File([pngBytes()], 'a.png', { type: 'image/png' });
		await api.updatePost(
			101,
			{
				expectedVersion: 3,
				title: null,
				body: 'Hi',
				categoryIds: [],
				audience: 'selected',
				selectedFollowerIds: [7, 8],
				image,
			},
			fetchRef,
		);
		const form = await readForm(fetchRef.calls[0].init.body);
		expect(form.fields).toEqual({
			expected_version: ['3'],
			title: [''],
			body: ['Hi'],
			category_ids: [''],
			audience: ['selected'],
			selected_follower_ids: ['7', '8'],
		});
		expect(form.image.type).toBe('image/png');
	});

	test('omits default feed and page values and keeps filters together', async () => {
		const fetchRef = stub(200, {
			data: [],
			meta: { pagination: { page: 2, per_page: 20, total: 0, total_pages: 0 } },
		});
		await api.fetchFeed({ feed: 'following', categoryId: 3, page: 2 }, fetchRef);
		await api.fetchFeed({}, fetchRef);
		await api.fetchMyPosts({ status: 'draft' }, fetchRef);
		expect(fetchRef.calls.map((call) => call.url)).toEqual([
			'/api/v1/posts?page=2&feed=following&category_id=3',
			'/api/v1/posts',
			'/api/v1/posts/mine?status=draft',
		]);
		expect(fetchRef.calls[0].init.headers['X-Requested-With']).toBeUndefined();
	});
});
