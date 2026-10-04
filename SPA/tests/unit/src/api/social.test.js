import { describe, expect, test, vi } from 'vitest';

import {
	fetchFollowers,
	fetchFollowing,
	fetchProfile,
	followUser,
	normalizePerson,
	normalizeProfile,
	removeFollow,
	searchPeople,
	setProfileVisibility,
} from '../../../../src/api/social.js';
import {
	contractUsers,
	createFixtureFetch,
	FixtureBackend,
	loadContractFixtures,
} from '../../../fixtures/phase2/fixture-backend.js';

const fixtures = loadContractFixtures();
const jsonResponse = (status, body) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => {
		if (body === null || body === undefined) throw new SyntaxError('empty');
		return body;
	},
});

// Maps a contract case to the client function that issues its request, or
// null when the case belongs to notifications (SN-A10) or to raw requests the
// client can never construct (bad Content-Type, oversized body, wrong verb).
function clientCall(fixtureCase) {
	const { method, path, json } = fixtureCase.request;
	const url = new URL(path, 'http://fixture.test');
	const shape = url.pathname.replace('/api/v1/', '').replace(/\/-?\d+/gu, '/:id');
	const params = url.searchParams;
	const options = {
		q: params.get('q') ?? '',
		page: Number(params.get('page') ?? 1),
		perPage: params.get('per_page') ? Number(params.get('per_page')) : undefined,
	};
	const id = Number(
		url.pathname.match(/\/(-?\d+)\//u)?.[1] ?? url.pathname.match(/\/(-?\d+)$/u)?.[1],
	);
	const calls = {
		'GET users': (f) => searchPeople(options, f),
		'GET users/:id/profile': (f) => fetchProfile(id, f),
		'GET users/:id/followers': (f) => fetchFollowers(id, options, f),
		'GET users/:id/following': (f) => fetchFollowing(id, options, f),
		'POST follows': (f) => followUser(json?.user_id ?? 42, f),
		'DELETE follows/:id': (f) => removeFollow(id, f),
		'PATCH users/me/privacy': (f) =>
			setProfileVisibility(
				{ visibility: json?.visibility, expectedVersion: json?.expected_version },
				f,
			),
	};
	return calls[`${method} ${shape}`] ?? null;
}

function reproducible(request) {
	if (request.raw_body !== undefined || request.headers) return false;
	if (request.path === '/api/v1/follows') {
		const keys = Object.keys(request.json ?? {});
		return (
			keys.length === 1 &&
			keys[0] === 'user_id' &&
			Number.isSafeInteger(request.json.user_id) &&
			request.json.user_id > 0
		);
	}
	return true;
}

function expectedStatus(response) {
	const { status, body } = response;
	const code = body?.error?.code;
	if (status === 204 || (status >= 200 && status < 300)) return 'ok';
	if (status === 401) return 'unauthenticated';
	if (status === 404) return 'not-found';
	if (status === 409) return code === 'STALE_PROFILE' ? 'stale-profile' : 'stale-follow';
	if (status === 400 || status === 403) return 'rejected';
	return 'unavailable';
}

describe('contract fixture replay', () => {
	const replayable = fixtures.cases
		.filter((c) => c.response.status !== null && c.response.status !== undefined)
		.map((c) => [c.name, c, clientCall(c)])
		.filter(([, , call]) => call);

	test('covers every profile, list, follow and privacy case', () => {
		const skipped = fixtures.cases
			.filter((c) => !replayable.some(([name]) => name === c.name))
			.map((c) => c.request.path.split('?')[0].replace(/\/-?\d+/gu, '/:id'));
		// Notifications and request review (A10), avatar bytes (an <img> load) and
		// the lost-response case are intentionally outside the client's reads.
		expect(new Set(skipped)).toEqual(
			new Set([
				'/api/v1/follow-requests/:id',
				'/api/v1/follows',
				'/api/v1/notifications',
				'/api/v1/notifications/:id/read',
				'/api/v1/notifications/read-all',
				'/api/v1/users/:id/avatar',
				'/api/v1/users/me/follow-requests',
			]),
		);
		expect(replayable.length).toBeGreaterThanOrEqual(57);
	});

	test.each(replayable)('%s', async (_name, fixtureCase, call) => {
		const { response, request } = fixtureCase;
		const fetchRef = vi.fn(async () => jsonResponse(response.status, response.body));
		const result = await call(fetchRef);

		expect(result.status).toBe(expectedStatus(response));
		const [url, init] = fetchRef.mock.calls[0];
		expect(init.credentials).toBe('include');
		expect(url.startsWith('/api/v1/')).toBe(true);
		// Raw bodies and header overrides model hostile clients; the real client
		// never produces them, so only its response handling is checked there.
		if (!reproducible(request)) return;
		if (request.method === 'GET') {
			expect(init.method).toBe('GET');
			expect(init.headers['X-Requested-With']).toBeUndefined();
			expect(init.body).toBeUndefined();
		} else {
			expect(init.method).toBe(request.method);
			expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
			if (request.json) {
				expect(init.headers['Content-Type']).toBe('application/json');
				expect(JSON.parse(init.body)).toEqual(request.json);
			} else {
				expect(init.body).toBeUndefined();
				expect(init.headers['Content-Type']).toBeUndefined();
			}
		}
	});

	test('a lost response is unavailable, never success', async () => {
		const result = await followUser(
			42,
			vi.fn(async () => {
				throw new TypeError('response lost');
			}),
		);
		expect(result).toEqual({ status: 'unavailable' });
	});
});

describe('fixture backend fidelity to the contract', () => {
	const modelled = fixtures.cases.filter((c) => {
		const given = Object.keys(c.given).filter((key) => key !== 'notifications');
		const unsupported = given.some(
			(key) =>
				!['follows', 'removed_follow_ids', 'inactive_user_ids', 'profile_version'].includes(key),
		);
		const isNotification = c.request.path.includes('/notifications');
		const clientUnreachable =
			c.request.raw_body !== undefined || c.request.headers || c.request.method === 'PUT';
		return (
			!unsupported &&
			!isNotification &&
			!clientUnreachable &&
			c.response.status !== null &&
			c.response.status !== undefined
		);
	});

	test('models the bulk of the contract', () => {
		expect(modelled.length).toBeGreaterThanOrEqual(60);
	});

	test.each(modelled.map((c) => [c.name, c]))('%s', (_name, fixtureCase) => {
		const { given, request, response } = fixtureCase;
		const users = contractUsers().map((user) => ({
			...user,
			active: !(given.inactive_user_ids ?? []).includes(user.id),
			version: given.profile_version ?? user.version,
		}));
		const backend = new FixtureBackend({
			users,
			follows: given.follows ?? [],
			removedFollowIds: given.removed_follow_ids ?? [],
		});
		const result = backend.request(fixtureCase.viewer_id, request.method, request.path, {
			json: request.json,
		});

		expect(result.status).toBe(response.status);
		expect(result.headers['Cache-Control']).toBe('no-store');
		if (response.status === 204) expect(result.body).toBeNull();
		else if (response.body?.error) {
			expect(result.body.error.code).toBe(response.body.error.code);
			expect(result.body.error.fields).toEqual(response.body.error.fields);
		} else if (response.body) expect(result.body).toEqual(response.body);
		for (const follow of fixtureCase.expect?.follows ?? []) {
			expect(backend.follows).toContainEqual(follow);
		}
		if (fixtureCase.expect?.follows?.length === 0) expect(backend.follows).toEqual([]);
		if (fixtureCase.expect?.profile_version) {
			expect(backend.users.get(fixtureCase.viewer_id).version).toBe(
				fixtureCase.expect.profile_version,
			);
		}
	});
});

describe('response normalization', () => {
	test('name-only entries keep exactly four keys even if a response leaks more', () => {
		const leaky = {
			id: 42,
			display_name: 'Alex Example',
			access: 'teaser',
			relationship: { state: 'none', follow_id: null },
			avatar_url: '/api/v1/users/42/avatar',
			profile: { email: 'alex@example.com' },
			followers_count: 4,
		};
		const person = normalizePerson(leaky);
		expect(Object.keys(person).sort()).toEqual(['access', 'display_name', 'id', 'relationship']);
		const profile = normalizeProfile({ ...leaky });
		expect(profile).toEqual(person);
		expect(JSON.stringify(profile)).not.toContain('alex@example.com');
	});

	test('rejects malformed identities, relationships and unexpected avatar URLs', () => {
		const base = {
			id: 7,
			display_name: 'Ada',
			access: 'full',
			relationship: { state: 'none', follow_id: null },
			avatar_url: null,
		};
		expect(normalizePerson(base)).toEqual(base);
		expect(normalizePerson({ ...base, id: 0 })).toBeNull();
		expect(normalizePerson({ ...base, id: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
		expect(normalizePerson({ ...base, access: 'other' })).toBeNull();
		expect(normalizePerson({ ...base, display_name: 5 })).toBeNull();
		expect(
			normalizePerson({ ...base, relationship: { state: 'blocked', follow_id: null } }),
		).toBeNull();
		expect(
			normalizePerson({ ...base, relationship: { state: 'pending', follow_id: null } }),
		).toBeNull();
		expect(normalizePerson({ ...base, relationship: null })).toBeNull();
		expect(normalizePerson(null)).toBeNull();
		expect(
			normalizePerson({ ...base, avatar_url: 'https://evil.example/a.png' }).avatar_url,
		).toBeNull();
		expect(normalizePerson({ ...base, avatar_url: '/api/v1/users/7/avatar' }).avatar_url).toBe(
			'/api/v1/users/7/avatar',
		);
	});

	test('profiles require a visibility and only the owner carries a version', () => {
		const owner = {
			id: 7,
			display_name: 'Ada',
			access: 'full',
			relationship: { state: 'self', follow_id: null },
			profile: { visibility: 'public', version: 3, followers_count: 2, following_count: 1 },
		};
		expect(normalizeProfile(owner).profile.version).toBe(3);
		const withAvatar = {
			...owner,
			profile: { ...owner.profile, avatar_url: '/api/v1/users/7/avatar' },
		};
		expect(normalizeProfile(withAvatar).profile.avatar_url).toBe('/api/v1/users/7/avatar');
		expect(normalizeProfile(withAvatar).avatar_url).toBeUndefined();
		const foreign = {
			...owner,
			profile: { ...owner.profile, avatar_url: 'https://evil.example/a.png' },
		};
		expect(normalizeProfile(foreign).profile.avatar_url).toBeNull();
		const other = { ...owner, relationship: { state: 'none', follow_id: null } };
		expect(normalizeProfile(other).profile.version).toBeUndefined();
		expect(normalizeProfile({ ...owner, profile: { visibility: 'friends' } })).toBeNull();
		expect(normalizeProfile({ ...owner, profile: undefined })).toBeNull();
		const sparse = normalizeProfile({
			...other,
			profile: { visibility: 'private', followers_count: -1 },
		});
		expect(sparse.profile).toMatchObject({
			email: '',
			followers_count: 0,
			following_count: 0,
			nickname: null,
		});
	});

	test('malformed success bodies are unavailable rather than partially rendered', async () => {
		const bad = (data) => vi.fn(async () => jsonResponse(200, { data }));
		expect((await fetchProfile(1, bad({ id: 'x' }))).status).toBe('unavailable');
		expect((await searchPeople({}, bad('nope'))).status).toBe('unavailable');
		expect((await searchPeople({}, bad([{ id: 1 }]))).status).toBe('unavailable');
		expect((await followUser(1, bad({ id: 1 }))).status).toBe('unavailable');
		expect(
			(await setProfileVisibility({ visibility: 'public', expectedVersion: 1 }, bad({ id: 1 })))
				.status,
		).toBe('unavailable');
		expect(
			(
				await fetchProfile(
					1,
					vi.fn(async () => jsonResponse(200, null)),
				)
			).status,
		).toBe('unavailable');
		expect(
			(
				await fetchProfile(
					1,
					vi.fn(async () => jsonResponse(500, null)),
				)
			).status,
		).toBe('unavailable');
		expect(
			(
				await fetchProfile(
					1,
					vi.fn(async () => {
						throw new TypeError('offline');
					}),
				)
			).status,
		).toBe('unavailable');
	});

	test('a list without pagination metadata is unavailable, not a guessed empty page', async () => {
		const person = {
			id: 7,
			display_name: 'Ada',
			access: 'full',
			relationship: { state: 'none', follow_id: null },
			avatar_url: null,
		};
		const result = await searchPeople(
			{ page: 3 },
			vi.fn(async () => jsonResponse(200, { data: [person] })),
		);
		expect(result).toEqual({ status: 'unavailable' });
	});

	test('an owner profile without a version is unavailable', () => {
		const owner = {
			id: 7,
			display_name: 'Ada',
			access: 'full',
			relationship: { state: 'self', follow_id: null },
			profile: { visibility: 'public' },
		};
		expect(normalizeProfile(owner)).toBeNull();
		expect(
			normalizeProfile({ ...owner, profile: { visibility: 'public', version: 0 } }),
		).toBeNull();
	});
});

describe('request construction', () => {
	test('encodes search and paging as query parameters and omits defaults', async () => {
		const backend = new FixtureBackend();
		const fetchRef = createFixtureFetch(backend);
		await searchPeople({ q: '50% off & more', page: 1 }, fetchRef);
		await searchPeople({ page: 2, perPage: 5 }, fetchRef);
		await searchPeople({}, fetchRef);
		expect(fetchRef.calls.map((c) => c.url)).toEqual([
			'/api/v1/users?q=50%25+off+%26+more',
			'/api/v1/users?page=2&per_page=5',
			'/api/v1/users',
		]);
	});

	test('writes carry the CSRF header; reads never send a body', async () => {
		const backend = new FixtureBackend();
		const fetchRef = createFixtureFetch(backend);
		const followed = await followUser(42, fetchRef);
		expect(followed.follow).toMatchObject({ id: 201, state: 'pending' });
		expect(fetchRef.calls[0].headers['X-Requested-With']).toBe('XMLHttpRequest');
		expect((await removeFollow(201, fetchRef)).status).toBe('ok');
		expect((await removeFollow(201, fetchRef)).status).toBe('stale-follow');
	});
});
