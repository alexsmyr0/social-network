// The A19 interaction and browser tests run against ChatBackend. This proves
// that stand-in follows the approved SN-B20 pack before any UI result relies
// on it: every private-message HTTP case, the full 36-cell delivery matrix,
// the direct-message journeys, races and write-time delivery cases replay with
// exact statuses, bodies, resulting state and signals.
import { describe, expect, test } from 'vitest';

import { ChatBackend, loadChatFixtures } from '../../../../fixtures/phase5/chat-backend.js';

const pack = loadChatFixtures();
const chatCases = pack.http_cases.filter((c) => c.request.path.startsWith('/api/v1/chats'));

function send(backend, request) {
	return backend.request(request.actor, request.method, request.path, {
		json: request.json,
		headers: { 'X-Requested-With': request.xhr === false ? undefined : 'XMLHttpRequest' },
		origin: request.origin,
		contentType: request.content_type,
		bodyBytes: request.body_bytes,
		rawJson: request.raw_json,
		multipart: request.multipart,
	});
}

describe('SN-A19 test model conforms to the approved private-message pack', () => {
	test('covers every private-message HTTP case', () => {
		expect(chatCases).toHaveLength(86);
	});

	test.each(chatCases.map((c) => [c.id, c]))('%s', (_id, c) => {
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

describe('SN-A19 delivery matrix', () => {
	test('has all 36 directed-follow × visibility × online cells', () => {
		expect(pack.dm_matrix).toHaveLength(36);
	});

	test.each(pack.dm_matrix.map((cell) => [cell.case_id, cell]))('%s', (_id, cell) => {
		const backend = ChatBackend.fromPack(pack, {
			follows: { '1:2': cell.outgoing, '2:1': cell.incoming },
			users: { 2: { visibility: cell.recipient_visibility, online: cell.recipient_online } },
		});
		expect(backend.canSend(1, 2)).toBe(cell.can_send);
		expect(backend.live(1, 2)).toBe(cell.recipient_live);
		expect(backend.presenceVisible(1, 2)).toBe(cell.presence_visible);
	});
});

// Applies a journey/race action to the model and projects the result into the
// pack's compact outcome (`status`, `id`, `ids`, `code`, …).
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: maps each pack action to a request
function act(backend, action) {
	backend.signals = [];
	const { op, actor, target } = action;
	let result;
	if (op === 'restart') return { status: 204 };
	if (op === 'follow') {
		backend.setFollow(action.from, action.to, action.state);
		return { status: 204 };
	}
	if (op === 'online') {
		backend.setOnline(action.user, action.value, { announce: false });
		return { status: 204 };
	}
	if (op === 'dm_send')
		result = backend.request(actor, 'POST', `/api/v1/chats/${target}/messages`, {
			json: { client_id: action.client_id, body: action.body },
		});
	else if (op === 'dm_history')
		result = backend.request(actor, 'GET', `/api/v1/chats/${target}/messages`, {});
	else if (op === 'dm_read')
		result = backend.request(actor, 'PUT', `/api/v1/chats/${target}/read`, {
			json: { through_id: action.through_id },
		});
	else if (op === 'dm_unread') result = backend.request(actor, 'GET', '/api/v1/chats/unread', {});
	else if (op === 'media') result = backend.request(actor, 'GET', `/api/v1/media/${target}`, {});
	else if (op === 'notice_unread') {
		const unread = backend.visibleNotices(backend.user(actor)).filter((n) => !n.is_read);
		return { status: 200, unread_count: unread.length };
	} else throw new Error(`Unmodeled action ${op}`);
	const outcome = { status: result.status };
	if (result.status >= 400) return { ...outcome, code: result.body.error.code };
	const data = result.body?.data ?? {};
	for (const key of ['id', 'through_id', 'unread_count']) if (key in data) outcome[key] = data[key];
	if (data.messages) outcome.ids = data.messages.map((message) => message.id);
	return outcome;
}

const DM_OPS = new Set([
	'dm_send',
	'dm_history',
	'dm_read',
	'dm_unread',
	'media',
	'follow',
	'online',
	'restart',
	'notice_unread',
]);
const journeys = pack.sequences.filter((s) => s.steps.every((step) => DM_OPS.has(step.action.op)));
const races = pack.races.filter((race) => race.actions.every((a) => DM_OPS.has(a.op)));

describe('SN-A19 test model follows the approved DM journeys and races', () => {
	test('covers the direct-message journeys and races', () => {
		expect(journeys.map((j) => j.id)).toEqual([
			'unfollow-refollow',
			'nonce-retry',
			'cursor-offline-recovery',
		]);
		expect(races.map((r) => r.id)).toEqual([
			'unfollow-send',
			'duplicate-send',
			'conflicting-send',
			'read-send',
		]);
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

describe('SN-A19 write-time delivery', () => {
	const cases = pack.delivery_cases.filter((c) => c.type === 'dm.message');

	test.each(cases.map((c) => [c.id, c]))('%s', (_id, c) => {
		const backend = ChatBackend.fromPack(pack, c.given);
		const delivered =
			c.session_valid &&
			Boolean(backend.user(c.viewer)) &&
			(c.viewer === c.sender || backend.live(c.sender, c.viewer));
		expect(delivered).toBe(c.deliver);
	});
});

describe('SN-A19 presence helpers', () => {
	test('a presence change reaches only viewers allowed to see the account', () => {
		const backend = new ChatBackend();
		backend.setOnline(7, false);
		// Ada is private: Alex follows her and Lee follows her; no one else.
		expect(backend.signals).toEqual([
			{ type: 'presence.update', recipients: [10, 42], payload: { user_id: 7, is_online: false } },
		]);
		expect(backend.presenceSnapshot(99).users.map((user) => user.user_id)).toEqual([10, 42]);
	});
});
