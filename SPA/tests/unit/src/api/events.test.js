// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import * as api from '../../../../src/api/events.js';
import {
	fetchNotifications,
	markAllNotificationsRead,
	markNotificationRead,
} from '../../../../src/api/social.js';
import { loadEventFixtures } from '../../../fixtures/phase5/event-backend.js';

const pack = loadEventFixtures();
const EVENT_ROUTE = /^\/api\/v1\/(groups\/\d+\/events|notifications)/u;
// Every event route plus every event-notice case the client reads.
const cases = pack.http_cases.filter((c) => EVENT_ROUTE.test(c.request.path));

// Server-side rejections the client cannot produce (repeated query keys, an
// unsupported verb). They still replay through the nearest client function so
// their outcome mapping is checked, but the request is not expected to match.
const SERVER_ONLY = new Set(['event-page-page=1&page=2', 'method-/groups/10/events/901']);

function options(params) {
	return {
		page: params.has('page') ? Number(params.get('page')) : 1,
		perPage: params.has('per_page') ? Number(params.get('per_page')) : undefined,
	};
}

function call(request, fetchRef) {
	const url = new URL(request.path, 'http://test');
	const params = url.searchParams;
	const path = url.pathname.replace('/api/v1', '');
	const body = request.json ?? {};
	if (path === '/notifications') return fetchNotifications(options(params), fetchRef);
	if (path === '/notifications/read-all') return markAllNotificationsRead(fetchRef);
	const read = path.match(/^\/notifications\/(\d+)\/read$/u);
	if (read) return markNotificationRead(Number(read[1]), fetchRef);
	const [, , group, , event, suffix] = path.split('/');
	const groupId = Number(group);
	if (event === undefined) {
		return request.method === 'GET'
			? api.fetchEvents(groupId, options(params), fetchRef)
			: api.createEvent(
					groupId,
					{
						membershipId: body.membership_id,
						title: body.title,
						description: body.description,
						startsAt: body.starts_at,
					},
					fetchRef,
				);
	}
	if (suffix === 'responses')
		return api.fetchEventResponses(groupId, Number(event), options(params), fetchRef);
	if (suffix === 'response')
		return api.respondToEvent(
			groupId,
			Number(event),
			{
				membershipId: body.membership_id,
				choice: body.choice,
				expectedVersion: body.expected_version,
			},
			fetchRef,
		);
	return api.fetchEvent(groupId, Number(event), fetchRef);
}

const CONFLICTS = {
	STALE_EVENT_RESPONSE: 'stale-response',
	STALE_MEMBERSHIP: 'stale-membership',
};
function expectedStatus(expected) {
	if (expected.status < 300) return 'ok';
	if (expected.status === 401) return 'unauthenticated';
	if (expected.status === 404) return 'not-found';
	if (expected.status === 409) return CONFLICTS[expected.body.error.code];
	return 'rejected';
}

function respond(expected) {
	return vi.fn(async () => ({
		ok: expected.status < 400,
		status: expected.status,
		json: async () => {
			if (expected.body === null || expected.body === undefined) throw new SyntaxError('empty');
			return structuredClone(expected.body);
		},
	}));
}

describe('SN-A18 approved contract replay', () => {
	test('covers every event-owned case and the pack paths it sends', () => {
		expect(cases).toHaveLength(85);
		expect(cases.filter((c) => SERVER_ONLY.has(c.id))).toHaveLength(2);
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verify request and each approved response schema
	test.each(cases.map((c) => [c.id, c]))('%s', async (_id, c) => {
		const fetchRef = respond(c.expect);
		const result = await call(c.request, fetchRef);
		expect(result.status).toBe(expectedStatus(c.expect));
		expect(fetchRef).toHaveBeenCalledTimes(1);
		const [path, init] = fetchRef.mock.calls[0];
		expect(init.credentials).toBe('include');
		if (!SERVER_ONLY.has(c.id)) {
			expect(path).toBe(c.request.path);
			expect(init.method).toBe(c.request.method);
			if (init.method !== 'GET') expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
			if (c.request.json) expect(JSON.parse(init.body)).toEqual(c.request.json);
			else expect(init.body).toBeUndefined();
		}
		if (c.expect.status !== 200 && c.expect.status !== 201) {
			if (c.expect.status === 400 && c.expect.body.error.code === 'VALIDATION_ERROR')
				expect(result.fields).toEqual(c.expect.body.error.fields);
			return;
		}
		const { data, meta } = c.expect.body;
		for (const key of ['events', 'responses']) {
			if (!result[key]) continue;
			expect(result[key]).toEqual(data);
			expect(result.pagination).toEqual(meta.pagination);
		}
		if (result.event) expect(result.event).toEqual(data);
		if (result.notifications) {
			expect(result.notifications).toEqual(data.notifications);
			expect(result.unreadCount).toBe(data.unread_count);
		}
	});
});

function okResponse(data, meta) {
	return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data, meta }) }));
}
const caseBody = (id) => structuredClone(pack.http_cases.find((c) => c.id === id).expect.body);

describe('event client redaction and failure handling', () => {
	test('creators and responders are a name and an ID only', async () => {
		const detail = caseBody('group-member-event_detail').data;
		detail.creator.avatar_url = '/api/v1/users/8/avatar';
		detail.creator.email = 'author@example.com';
		const event = (await api.fetchEvent(10, 901, okResponse(detail))).event;
		expect(event.creator).toEqual({ id: 8, display_name: 'Author' });
		const answers = caseBody('group-member-event_responses');
		answers.data[0].user.avatar_url = '/api/v1/users/1/avatar';
		answers.data[0].user.access = 'full';
		answers.data[0].profile = { email: 'secret' };
		const result = await api.fetchEventResponses(
			10,
			901,
			{},
			okResponse(answers.data, answers.meta),
		);
		expect(Object.keys(result.responses[0]).sort()).toEqual(['choice', 'user', 'version']);
		expect(result.responses[0].user).toEqual({ id: 1, display_name: 'Alex' });
	});

	test('malformed success bodies, missing pagination and foreign groups are unavailable', async () => {
		const list = caseBody('group-member-event_list');
		expect((await api.fetchEvents(10, {}, okResponse(list.data))).status).toBe('unavailable');
		for (const mutate of [
			(event) => {
				event.options = ['going', 'not_going', 'maybe'];
			},
			(event) => {
				event.options = ['not_going', 'going'];
			},
			(event) => {
				event.starts_at = 'someday';
			},
			(event) => {
				event.counts.going = -1;
			},
			(event) => {
				event.viewer_response = { choice: 'maybe', version: 1 };
			},
			(event) => {
				event.viewer_response = { choice: 'going', version: 0 };
			},
			(event) => {
				event.creator = null;
			},
			(event) => {
				event.title = null;
			},
		]) {
			const broken = structuredClone(list.data);
			mutate(broken[0]);
			expect((await api.fetchEvents(10, {}, okResponse(broken, list.meta))).status).toBe(
				'unavailable',
			);
		}
		// An event of another group is never shown under this route.
		expect((await api.fetchEvents(11, {}, okResponse(list.data, list.meta))).status).toBe(
			'unavailable',
		);
		expect((await api.fetchEvent(11, 901, okResponse(list.data[0]))).status).toBe('unavailable');
	});

	test('lost and unconfirmed responses are unavailable and never replayed by the client', async () => {
		const lost = vi.fn(async () => {
			throw new Error('connection lost');
		});
		for (const write of [
			() =>
				api.createEvent(
					10,
					{ membershipId: 101, title: 'a', description: 'b', startsAt: '2026-10-16T18:00:00Z' },
					lost,
				),
			() =>
				api.respondToEvent(
					10,
					901,
					{ membershipId: 101, choice: 'going', expectedVersion: 0 },
					lost,
				),
		])
			expect((await write()).status).toBe('unavailable');
		expect(lost).toHaveBeenCalledTimes(2);
		const server = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }));
		expect((await api.fetchEvent(10, 901, server)).status).toBe('unavailable');
		const created = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }));
		expect(
			(
				await api.createEvent(
					10,
					{ membershipId: 101, title: 'a', description: 'b', startsAt: 'c' },
					created,
				)
			).status,
		).toBe('unavailable');
	});

	test('event notices keep only the event ID and public group metadata, and never carry actions', async () => {
		const body = caseBody('notice-list-member');
		const notice = body.data.notifications[0];
		notice.target.title = 'Secret title';
		notice.target.excerpt = 'secret';
		notice.target.group.description = 'members-only detail';
		notice.actions = ['accept'];
		const result = await fetchNotifications({}, okResponse(body.data, body.meta));
		expect(result.notifications[0].target).toEqual({
			kind: 'group_event',
			event_id: 901,
			group: { id: 10, title: 'Chess' },
		});
		expect(result.notifications[0].actions).toEqual([]);
		notice.target.event_id = 0;
		expect((await fetchNotifications({}, okResponse(body.data, body.meta))).status).toBe(
			'unavailable',
		);
	});
});
