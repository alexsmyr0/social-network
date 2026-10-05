import { describe, expect, test, vi } from 'vitest';

import {
	decideFollowRequest,
	fetchFollowRequests,
	fetchNotifications,
	markAllNotificationsRead,
	markNotificationRead,
	normalizeNotice,
} from '../../../../src/api/social.js';
import {
	createFixtureFetch,
	FixtureBackend,
	loadContractFixtures,
} from '../../../fixtures/phase2/fixture-backend.js';

const fixtures = loadContractFixtures();
const cases = fixtures.cases.filter((c) =>
	/\/notifications|\/follow-requests/u.test(c.request.path),
);
function invoke(c, fetchRef) {
	const { method, path, json } = c.request;
	const url = new URL(path, 'http://fixture.test');
	const options = {
		page: Number(url.searchParams.get('page') || 1),
		perPage: Number(url.searchParams.get('per_page') || 20),
	};
	if (method === 'GET')
		return path.includes('/notifications')
			? fetchNotifications(options, fetchRef)
			: fetchFollowRequests(options, fetchRef);
	if (path.endsWith('/read-all')) return markAllNotificationsRead(fetchRef);
	const id = Number(path.match(/\/(\d+)(?:\/read)?$/u)?.[1]);
	return path.endsWith('/read')
		? markNotificationRead(id, fetchRef)
		: decideFollowRequest(id, json?.decision, fetchRef);
}
function outcome(status) {
	if (status < 300) return 'ok';
	return (
		{
			400: 'rejected',
			401: 'unauthenticated',
			403: 'rejected',
			404: 'not-found',
			409: 'stale-follow',
		}[status] || 'unavailable'
	);
}

describe('A10 approved HTTP fixture handoff', () => {
	test('covers all notification and incoming request interfaces', () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});
	test.each(cases.map((c) => [c.name, c]))('%s', async (_name, c) => {
		const fetchRef = vi.fn(async () => ({
			ok: c.response.status < 300,
			status: c.response.status,
			json: async () => c.response.body,
		}));
		const result = await invoke(c, fetchRef);
		expect(result.status).toBe(outcome(c.response.status));
		const [url, init] = fetchRef.mock.calls[0];
		expect(url.split('?')[0]).toBe(c.request.path.split('?')[0]);
		expect(init.method).toBe(c.request.method);
		expect(init.credentials).toBe('include');
		if (init.method === 'PATCH') expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
		if (c.request.json) expect(JSON.parse(init.body)).toEqual(c.request.json);
		else expect(init.body).toBeUndefined();
		if (c.response.body?.data?.notifications)
			expect(result.notifications).toEqual(c.response.body.data.notifications);
		if (c.response.body?.data && Array.isArray(c.response.body.data))
			expect(result.requests).toEqual(c.response.body.data);
	});
});

test('stateful notices retain history and never let an old request decide a retry', async () => {
	const backend = new FixtureBackend();
	backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	const fetchRef = createFixtureFetch(backend, { viewer: () => 42 });
	expect((await fetchNotifications({}, fetchRef)).unreadCount).toBe(1);
	await markNotificationRead(501, fetchRef);
	expect(backend.follows[0].state).toBe('pending');
	backend.request(7, 'DELETE', '/api/v1/follows/201');
	backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	expect((await decideFollowRequest(201, 'accept', fetchRef)).status).toBe('stale-follow');
	expect(backend.follows[0].id).toBe(202);
	expect(backend.follows[0].state).toBe('pending');
	await decideFollowRequest(202, 'decline', fetchRef);
	const notices = await fetchNotifications({}, fetchRef);
	expect(notices.notifications.map((n) => n.target.state)).toEqual(['declined', 'cancelled']);
	expect(notices.unreadCount).toBe(0);
});

test('normalization drops private fields, internal identity, resolved actions and unsafe avatar URLs', () => {
	const notice = structuredClone(
		cases.find((c) => c.name === 'notice-private-requester-name-only').response.body.data
			.notifications[0],
	);
	notice.actor.email = 'secret';
	notice.actor.avatar_url = 'https://secret.example/avatar';
	notice.recipient_id = 42;
	notice.target.state = 'cancelled';
	const normalized = normalizeNotice(notice);
	expect(Object.keys(normalized.actor).sort()).toEqual([
		'access',
		'display_name',
		'id',
		'relationship',
	]);
	expect(normalized.recipient_id).toBeUndefined();
	expect(normalized.actions).toEqual([]);
});

test('malformed success and transport failures are unavailable', async () => {
	const bad = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({ data: { notifications: [null], unread_count: 1 } }),
	}));
	expect((await fetchNotifications({}, bad)).status).toBe('unavailable');
	expect((await fetchFollowRequests({}, bad)).status).toBe('unavailable');
	const lost = vi.fn(async () => {
		throw new Error('lost');
	});
	expect((await markAllNotificationsRead(lost)).status).toBe('unavailable');
});
