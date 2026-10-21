// @vitest-environment jsdom
// SN-A20: the group-room client replays every approved HTTP case of the SN-B20
// pack through the real client functions, then checks what it refuses to show.
import { describe, expect, test, vi } from 'vitest';
import * as api from '../../../../src/api/chats.js';
import { loadChatFixtures } from '../../../fixtures/phase5/chat-backend.js';

const pack = loadChatFixtures();
const ROOM_PATH = /^\/api\/v1\/(group-chats|groups\/\d+\/messages)/u;
const cases = pack.http_cases.filter((c) => ROOM_PATH.test(c.request.path));

// Server-side rejections the client cannot produce: an unsupported verb, and a
// body carrying a field the client has no way to send (room images do not
// exist). They replay through the nearest client function so their outcome
// mapping is checked, but the request is not expected to match.
const SERVER_ONLY = new Set(['method-/groups/10/messages', 'room-image-forbidden']);

function call(request, fetchRef) {
	const url = new URL(request.path, 'http://test');
	const params = url.searchParams;
	const parts = url.pathname.replace('/api/v1', '').split('/').filter(Boolean);
	const body = request.json ?? {};
	if (parts[0] === 'group-chats' && parts[1] === 'unread') return api.fetchGroupUnread(fetchRef);
	if (parts[0] === 'group-chats')
		return api.fetchRooms(
			{
				page: params.has('page') ? Number(params.get('page')) : 1,
				perPage: params.has('per_page') ? Number(params.get('per_page')) : undefined,
			},
			fetchRef,
		);
	const groupId = Number(parts[1]);
	if (parts[3] === 'read')
		return api.markGroupRead(
			groupId,
			{ membershipId: body.membership_id, throughId: body.through_id },
			fetchRef,
		);
	if (request.method === 'POST')
		return api.sendGroupMessage(
			groupId,
			{ membershipId: body.membership_id, clientId: body.client_id, body: body.body },
			fetchRef,
		);
	return api.fetchGroupMessages(
		groupId,
		{
			beforeId: params.has('before_id') ? Number(params.get('before_id')) : undefined,
			limit: params.has('limit') ? Number(params.get('limit')) : undefined,
		},
		fetchRef,
	);
}

function expectedStatus(expected) {
	if (expected.status < 300) return 'ok';
	if (expected.status === 401) return 'unauthenticated';
	if (expected.status === 404) return 'not-found';
	if (expected.status === 409)
		return expected.body.error.code === 'STALE_MEMBERSHIP' ? 'stale-membership' : 'conflict';
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

describe('SN-A20 approved contract replay', () => {
	test('covers every group-room case', () => {
		expect(cases).toHaveLength(40);
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
		if (result.rooms) {
			expect(
				result.rooms.map((room) => [
					room.group_id,
					room.title,
					room.membership_id,
					room.read_through_id,
					room.unread_count,
					room.last_message,
				]),
			).toEqual(
				data.map((room) => [
					room.group.id,
					room.group.title,
					room.membership_id,
					room.read_through_id,
					room.unread_count,
					room.last_message,
				]),
			);
			expect(result.pagination).toEqual(meta.pagination);
		}
		if (result.messages) {
			expect(result.messages).toEqual(data.messages);
			expect(result.hasMore).toBe(data.has_more);
			expect(result.nextBeforeId).toBe(data.next_before_id);
		}
		if (result.message) {
			expect(result.message).toEqual(data);
			expect(result.duplicate).toBe(c.expect.status === 200);
		}
		if (result.throughId !== undefined) {
			expect(result.throughId).toBe(data.through_id);
			expect(result.unreadCount).toBe(data.unread_count);
		} else if (c.request.path.endsWith('/unread')) {
			expect(result.unreadCount).toBe(data.unread_count);
		}
	});
});

function okResponse(data, meta, status = 200) {
	return vi.fn(async () => ({ ok: true, status, json: async () => ({ data, meta }) }));
}
const caseBody = (id) => structuredClone(pack.http_cases.find((c) => c.id === id).expect.body);
const NONCE = '11111111-1111-4111-8111-111111111111';

describe('group-room client redaction and failure handling', () => {
	test('a room summary names the group, the membership and the counts, nothing else', async () => {
		const rooms = caseBody('room-summaries');
		rooms.data[0].group.description = 'secret';
		rooms.data[0].members = [{ id: 2 }];
		rooms.data[0].last_message.membership_id = 102;
		const result = await api.fetchRooms({}, okResponse(rooms.data, rooms.meta));
		expect(Object.keys(result.rooms[0]).sort()).toEqual([
			'group_id',
			'last_message',
			'membership_id',
			'read_through_id',
			'title',
			'unread_count',
		]);
		expect(result.rooms[0].last_message).toEqual(caseBody('room-summaries').data[0].last_message);
	});

	test('a room list that breaks the contract is unavailable', async () => {
		const rooms = caseBody('room-summaries');
		expect((await api.fetchRooms({}, okResponse(rooms.data))).status).toBe('unavailable');
		for (const mutate of [
			(row) => {
				row.membership_id = 0;
			},
			(row) => {
				row.unread_count = -1;
			},
			(row) => {
				row.read_through_id = 'x';
			},
			(row) => {
				row.group.title = null;
			},
			(row) => {
				row.last_message.group_id = 11;
			},
			(row) => {
				row.last_message.image_url = '/api/v1/media/702';
			},
			(row) => {
				row.last_message = undefined;
			},
		]) {
			const broken = structuredClone(rooms.data);
			mutate(broken[0]);
			expect((await api.fetchRooms({}, okResponse(broken, rooms.meta))).status).toBe('unavailable');
		}
		const twice = [rooms.data[0], rooms.data[0]];
		expect((await api.fetchRooms({}, okResponse(twice, rooms.meta))).status).toBe('unavailable');
		// Invalid rows anywhere in a multi-room response must reach the retry UI.
		for (const rows of [
			[null, rooms.data[0]],
			[rooms.data[0], null],
		]) {
			expect((await api.fetchRooms({}, okResponse(rows, rooms.meta))).status).toBe('unavailable');
		}
	});

	test('room history that breaks the contract is unavailable', async () => {
		const history = caseBody('group-member-room_history').data;
		const bad = (mutate) => {
			const copy = structuredClone(history);
			mutate(copy);
			return api.fetchGroupMessages(10, {}, okResponse(copy));
		};
		expect((await bad(() => {})).status).toBe('ok');
		expect((await bad((d) => d.messages.reverse())).status).toBe('unavailable');
		expect((await bad((d) => (d.has_more = true))).status).toBe('unavailable');
		expect((await bad((d) => (d.next_before_id = 801))).status).toBe('unavailable');
		expect((await bad((d) => (d.messages[0].group_id = 11))).status).toBe('unavailable');
		expect((await bad((d) => (d.messages[0].client_id = 'NOT-A-UUID'))).status).toBe('unavailable');
		expect((await bad((d) => (d.messages[1].image_url = '/api/v1/media/702'))).status).toBe(
			'unavailable',
		);
		expect((await bad((d) => (d.messages[1].sender_username = null))).status).toBe('unavailable');
		expect((await bad((d) => delete d.messages)).status).toBe('unavailable');
		// Another room's messages are never shown under this room's route.
		expect(
			(await api.fetchGroupMessages(11, {}, okResponse(structuredClone(history)))).status,
		).toBe('unavailable');
	});

	test('a send reply must be this room’s message with the same nonce', async () => {
		const created = caseBody('group-member-room_send').data;
		const send = (reply, groupId = 10) =>
			api.sendGroupMessage(
				groupId,
				{ membershipId: 102, clientId: created.client_id, body: 'Hi' },
				okResponse(reply, undefined, 201),
			);
		expect((await send(created)).status).toBe('ok');
		expect(
			(await send({ ...created, client_id: '22222222-2222-4222-8222-222222222222' })).status,
		).toBe('unavailable');
		expect((await send(created, 11)).status).toBe('unavailable');
		expect((await send({ ...created, body: undefined })).status).toBe('unavailable');
		expect((await send({ ...created, image_url: '/api/v1/media/702' })).status).toBe('unavailable');
	});

	test('a stale membership, a lost room and a conflict are named, never retried', async () => {
		const fail = (status, code) =>
			vi.fn(async () => ({
				ok: false,
				status,
				json: async () => ({ error: { code, message: 'x' } }),
			}));
		const args = { membershipId: 101, clientId: NONCE, body: 'Hi' };
		const stale = fail(409, 'STALE_MEMBERSHIP');
		expect((await api.sendGroupMessage(10, args, stale)).status).toBe('stale-membership');
		expect((await api.markGroupRead(10, { membershipId: 101, throughId: 1 }, stale)).status).toBe(
			'stale-membership',
		);
		expect((await api.sendGroupMessage(10, args, fail(409, 'MESSAGE_CONFLICT'))).status).toBe(
			'conflict',
		);
		expect((await api.sendGroupMessage(10, args, fail(404, 'NOT_FOUND'))).status).toBe('not-found');
		expect((await api.fetchGroupMessages(10, {}, fail(401, 'UNAUTHORIZED'))).status).toBe(
			'unauthenticated',
		);
		// A 409 without a pinned code is not mistaken for either.
		expect((await api.sendGroupMessage(10, args, fail(409, 'OTHER'))).status).toBe('unavailable');
		expect(stale).toHaveBeenCalledTimes(2);
	});

	test('lost and unconfirmed responses are unavailable and never replayed by the client', async () => {
		const lost = vi.fn(async () => {
			throw new Error('connection lost');
		});
		const args = { membershipId: 101, clientId: NONCE, body: 'Hi' };
		expect((await api.sendGroupMessage(10, args, lost)).status).toBe('unavailable');
		expect((await api.markGroupRead(10, { membershipId: 101, throughId: 802 }, lost)).status).toBe(
			'unavailable',
		);
		expect(lost).toHaveBeenCalledTimes(2);
		const server = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }));
		expect((await api.fetchGroupUnread(server)).status).toBe('unavailable');
		const empty = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }));
		expect((await api.sendGroupMessage(10, args, empty)).status).toBe('unavailable');
	});

	test('a send carries the membership, the nonce and the text, and no image field', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: caseBody('group-member-room_send').data }),
		}));
		await api.sendGroupMessage(10, { membershipId: 102, clientId: NONCE, body: 'Hi 👋' }, fetchRef);
		const [path, init] = fetchRef.mock.calls[0];
		expect(path).toBe('/api/v1/groups/10/messages');
		expect(JSON.parse(init.body)).toEqual({
			membership_id: 102,
			client_id: NONCE,
			body: 'Hi 👋',
		});
	});
});
