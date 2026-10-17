// The A18 interaction and browser tests run against EventBackend. This proves
// that stand-in follows the approved SN-B20 pack before any UI result relies on
// it: every event-owned HTTP case (routes, permissions, validation, paging and
// event notices), journey step and event race replays with exact statuses,
// bodies, resulting state and signal recipients.
import { describe, expect, test } from 'vitest';

import { EventBackend, loadEventFixtures } from '../../../../fixtures/phase5/event-backend.js';

const pack = loadEventFixtures();
const EVENT_ROUTE = /^\/api\/v1\/(groups\/\d+\/events|notifications)/u;
const eventCases = pack.http_cases.filter((c) => EVENT_ROUTE.test(c.request.path));

function send(backend, request) {
	return backend.request(request.actor, request.method, request.path, {
		json: request.json,
		headers: { 'X-Requested-With': request.xhr === false ? undefined : 'XMLHttpRequest' },
	});
}

function expectResponse(result, expected) {
	expect(result.status).toBe(expected.status);
	expect(result.headers['Cache-Control']).toBe('no-store');
	if (expected.allow) expect(result.headers.Allow).toBe(expected.allow);
	if (expected.body === null) {
		expect(result.body).toBeNull();
		return;
	}
	expect(result.body).toEqual(expected.body);
}

describe('SN-A18 test model conforms to the approved events pack', () => {
	test('covers every event-owned HTTP case', () => {
		expect(eventCases).toHaveLength(85);
	});

	test.each(eventCases.map((c) => [c.id, c]))('%s', (_id, c) => {
		const backend = EventBackend.fromPack(pack, c.given);
		const before = JSON.stringify(backend.snapshot());
		const result = send(backend, c.request);
		expectResponse(result, c.expect);
		expect(backend.signals).toEqual(c.expect.signals);
		if (c.expect.unchanged) expect(JSON.stringify(backend.snapshot())).toBe(before);
		expect(backend.observable(c.request.actor)).toMatchObject(c.expect.state);
	});
});

// Applies a journey/race action to the model and projects the result into the
// pack's compact outcome (`status`, `id`, counts, `code`, …).
function act(backend, action) {
	backend.signals = [];
	switch (action.op) {
		case 'restart':
			return { status: 204 };
		case 'remove':
			backend.removeMember(action.group, action.user);
			return { status: 204 };
		case 'admit': {
			const membership = backend.admit(action.group, action.user, []);
			return { status: 201, membership_id: membership.id };
		}
		case 'notice_unread': {
			const unread = backend.visibleNotices(backend.user(action.actor)).filter((n) => !n.is_read);
			return { status: 200, unread_count: unread.length };
		}
		case 'notice_read_all': {
			for (const notice of backend.visibleNotices(backend.user(action.actor)))
				notice.is_read = true;
			return { status: 204 };
		}
		default:
			return eventAction(backend, action);
	}
}

function eventAction(backend, action) {
	const { op, actor, target } = action;
	const base = `/api/v1/groups/${target}/events`;
	let result;
	if (op === 'event_create')
		result = backend.request(actor, 'POST', base, {
			json: {
				membership_id: action.membership_id,
				title: action.title,
				description: action.description,
				starts_at: action.starts_at,
			},
		});
	else if (op === 'respond')
		result = backend.request(actor, 'PUT', `${base}/${action.event_id}/response`, {
			json: {
				membership_id: action.membership_id,
				choice: action.choice,
				expected_version: action.expected_version,
			},
		});
	else if (op === 'event_detail')
		result = backend.request(actor, 'GET', `${base}/${action.event_id}`, {});
	else throw new Error(`Unmodeled action ${op}`);
	const outcome = { status: result.status };
	if (result.status >= 400) return { ...outcome, code: result.body.error.code };
	const data = result.body.data;
	outcome.id = data.id;
	Object.assign(outcome, data.counts);
	if (data.viewer_response) outcome.version = data.viewer_response.version;
	if (op === 'event_create')
		outcome.notice_recipients =
			backend.observable(actor)[`notice_recipients_${data.id}`] ??
			[...backend.eventNotices.values()]
				.filter((notice) => notice.event_id === data.id)
				.map((notice) => notice.recipient_id)
				.sort((a, b) => a - b);
	return outcome;
}

const EVENT_OPS = new Set([
	'event_create',
	'respond',
	'event_detail',
	'remove',
	'admit',
	'notice_unread',
	'notice_read_all',
	'restart',
]);
const journeys = pack.sequences.filter((s) =>
	s.steps.every((step) => EVENT_OPS.has(step.action.op)),
);
const races = pack.races.filter((race) => race.actions.every((a) => EVENT_OPS.has(a.op)));

describe('SN-A18 test model follows the approved event journeys and races', () => {
	test('covers the event journeys and races', () => {
		expect(journeys.map((j) => j.id)).toEqual(['events-notices', 'event-response-version']);
		expect(races.map((r) => r.id)).toEqual([
			'remove-response',
			'concurrent-response',
			'remove-event-create',
		]);
	});

	test.each(journeys.map((j) => [j.id, j]))('journey %s', (_id, journey) => {
		const backend = EventBackend.fromPack(pack);
		for (const step of journey.steps) {
			const outcome = act(backend, step.action);
			expect(outcome).toMatchObject(step.expect);
		}
	});

	test.each(
		races.flatMap((race) =>
			race.orders.map((order) => [race.id, order.order.join(','), race, order]),
		),
	)('race %s in order %s', (_id, _label, race, order) => {
		const backend = EventBackend.fromPack(pack);
		order.order.forEach((index, position) => {
			expect(act(backend, race.actions[index]).status).toBe(order.statuses[position]);
		});
	});
});
