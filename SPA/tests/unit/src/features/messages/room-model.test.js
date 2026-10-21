// The A20 interaction and browser tests run against ChatBackend's group rooms.
// This proves that stand-in follows the approved SN-B20 pack before any UI
// result relies on it: every group-room HTTP case, the role matrix's room
// cells, the removal/readmission sequence, the removal-versus-send race in
// both orders and the room write-time delivery cases replay with exact
// statuses, bodies, resulting state and signals.
import { describe, expect, test } from 'vitest';

import { ChatBackend, loadChatFixtures } from '../../../../fixtures/phase5/chat-backend.js';

const pack = loadChatFixtures();
const ROOM_PATH = /^\/api\/v1\/(group-chats|groups\/\d+\/messages)/u;
const roomCases = pack.http_cases.filter((c) => ROOM_PATH.test(c.request.path));

function send(backend, request) {
	return backend.request(request.actor, request.method, request.path, {
		json: request.json,
		headers: { 'X-Requested-With': request.xhr === false ? undefined : 'XMLHttpRequest' },
		origin: request.origin,
		contentType: request.content_type,
		bodyBytes: request.body_bytes,
		rawJson: request.raw_json,
	});
}

describe('SN-A20 test model conforms to the approved group-room pack', () => {
	test('covers every group-room HTTP case', () => {
		expect(roomCases).toHaveLength(40);
	});

	test.each(roomCases.map((c) => [c.id, c]))('%s', (_id, c) => {
		const backend = ChatBackend.fromPack(pack, c.given);
		const before = JSON.stringify(backend.snapshot());
		const result = send(backend, c.request);
		expect(result.status).toBe(c.expect.status);
		expect(result.headers['Cache-Control']).toBe('no-store');
		if (c.expect.allow) expect(result.headers.Allow).toBe(c.expect.allow);
		if (c.expect.body === null) expect(result.body).toBeNull();
		else expect(result.body).toEqual(c.expect.body);
		expect(backend.signals).toEqual(c.expect.signals);
		if (c.expect.unchanged) expect(JSON.stringify(backend.snapshot())).toBe(before);
		expect(backend.observable(c.request.actor)).toMatchObject(c.expect.state);
	});
});

describe('SN-A20 role matrix room cells', () => {
	const cells = pack.group_matrix.filter((cell) => cell.surface.startsWith('room_'));

	test('has the 8 roles × 3 room surfaces', () => {
		expect(cells).toHaveLength(24);
	});

	test.each(
		cells.map((cell) => [cell.case_id, cell]),
	)('%s opens the room exactly when allowed', (_id, cell) => {
		const c = pack.http_cases.find((item) => item.id === cell.case_id);
		const backend = ChatBackend.fromPack(pack, c.given);
		const result = send(backend, c.request);
		expect(result.status < 300).toBe(cell.allow);
		expect(result.status === 404).toBe(!cell.allow);
	});
});

function act(backend, action) {
	backend.signals = [];
	const { op, actor, target } = action;
	let result;
	if (op === 'restart') return { status: 204 };
	if (op === 'remove') {
		backend.removeMember(action.group, action.user);
		return { status: 204 };
	}
	if (op === 'admit') {
		const membership = backend.admit(action.group, action.user, []);
		return { status: 201, membership_id: membership.id };
	}
	if (op === 'group_send')
		result = backend.request(actor, 'POST', `/api/v1/groups/${target}/messages`, {
			json: {
				membership_id: action.membership_id,
				client_id: action.client_id,
				body: action.body,
			},
		});
	else if (op === 'group_history')
		result = backend.request(actor, 'GET', `/api/v1/groups/${target}/messages`, {});
	else if (op === 'group_read')
		result = backend.request(actor, 'PUT', `/api/v1/groups/${target}/messages/read`, {
			json: { membership_id: action.membership_id, through_id: action.through_id },
		});
	else if (op === 'group_unread')
		result = backend.request(actor, 'GET', '/api/v1/group-chats/unread', {});
	else throw new Error(`Unmodeled action ${op}`);
	const outcome = { status: result.status };
	if (result.status >= 400) return { ...outcome, code: result.body.error.code };
	const data = result.body?.data ?? {};
	for (const key of ['id', 'through_id', 'unread_count']) if (key in data) outcome[key] = data[key];
	if (data.messages) outcome.ids = data.messages.map((message) => message.id);
	return outcome;
}

const ROOM_OPS = new Set(['group_send', 'group_history', 'group_read', 'group_unread']);
const CONTROL_OPS = new Set(['remove', 'admit', 'restart']);
const usesRooms = (actions) =>
	actions.some((a) => ROOM_OPS.has(a.op)) &&
	actions.every((a) => ROOM_OPS.has(a.op) || CONTROL_OPS.has(a.op));
const journeys = pack.sequences.filter((s) => usesRooms(s.steps.map((step) => step.action)));
const races = pack.races.filter((race) => usesRooms(race.actions));

describe('SN-A20 test model follows the approved room journey and race', () => {
	test('covers the removal/readmission journey and the removal-versus-send race', () => {
		expect(journeys.map((j) => j.id)).toEqual(['removal-readmission']);
		expect(races.map((r) => r.id)).toEqual(['remove-send']);
	});

	test.each(journeys.map((j) => [j.id, j]))('journey %s', (_id, journey) => {
		const backend = ChatBackend.fromPack(pack);
		for (const step of journey.steps) expect(act(backend, step.action)).toMatchObject(step.expect);
	});

	test.each(
		races.flatMap((race) =>
			race.orders.map((order) => [race.id, order.order.join(','), race, order]),
		),
	)('race %s in order %s', (_id, _label, race, order) => {
		const backend = ChatBackend.fromPack(pack);
		order.order.forEach((index, position) => {
			expect(act(backend, race.actions[index]).status).toBe(order.statuses[position]);
		});
	});
});

describe('SN-A20 room write-time delivery', () => {
	const cases = pack.delivery_cases.filter((c) => c.type === 'group.message');

	test('covers the room delivery cases', () => {
		expect(cases).toHaveLength(5);
	});

	test.each(cases.map((c) => [c.id, c]))('%s', (_id, c) => {
		const backend = ChatBackend.fromPack(pack, c.given);
		const membership = backend.roomMember(c.viewer, c.target);
		// A frame is written only for a valid session whose current membership is
		// the very generation it was queued for.
		const delivered =
			c.session_valid &&
			Boolean(backend.user(c.viewer)) &&
			Boolean(membership) &&
			membership.id === c.membership_id;
		expect(delivered).toBe(c.deliver);
	});
});

describe('SN-A20 room helpers', () => {
	test('a new membership starts reading at the room’s latest message, and departure drops it', () => {
		const backend = ChatBackend.fromPack(pack);
		expect(backend.roomUnread(2, 10)).toBe(1);
		backend.removeMember(10, 2);
		expect(backend.roomUnread(2, 10)).toBe(0);
		const membership = backend.admit(10, 2, []);
		expect(backend.roomCursor(membership)).toBe(802);
		expect(backend.roomUnread(2, 10)).toBe(0);
		backend.commitRoom(10, 1, { body: 'new' });
		expect(backend.roomUnread(2, 10)).toBe(1);
		expect(backend.signals.at(-1)).toMatchObject({
			type: 'group.message',
			recipients: [1, 2],
		});
	});
});
