// @vitest-environment jsdom
// SN-A19: the private-message client replays every approved HTTP case of the
// SN-B20 pack through the real client functions, then checks what it refuses
// to show.
import { describe, expect, test, vi } from 'vitest';
import * as api from '../../../../src/api/chats.js';
import { loadChatFixtures } from '../../../fixtures/phase5/chat-backend.js';

const pack = loadChatFixtures();
const cases = pack.http_cases.filter((c) => c.request.path.startsWith('/api/v1/chats'));

// Server-side rejections the client cannot produce (repeated or unknown query
// keys, an unsupported verb, hand-built raw bodies). They replay through the
// nearest client function so their outcome mapping is checked, but the request
// is not expected to match.
const SERVER_ONLY = new Set([
	'query-limit=1&limit=2',
	'query-unknown=1',
	'method-/chats/2/messages',
	'method-/chats/unread',
	'duplicate-json-key',
	'trailing-json',
	'upload-extra-part',
	'dm-unknown-field',
]);

function call(request, fetchRef) {
	const url = new URL(request.path, 'http://test');
	const params = url.searchParams;
	const parts = url.pathname.replace('/api/v1', '').split('/').filter(Boolean);
	const body = request.json ?? {};
	if (parts.length === 1)
		return api.fetchRoster(
			{
				page: params.has('page') ? Number(params.get('page')) : 1,
				perPage: params.has('per_page') ? Number(params.get('per_page')) : undefined,
			},
			fetchRef,
		);
	if (parts[1] === 'unread') return api.fetchUnread(fetchRef);
	const userId = Number(parts[1]);
	if (parts[2] === 'images')
		return api.uploadImage(
			userId,
			new File([new Uint8Array(4)], 'photo.png', { type: 'image/png' }),
			fetchRef,
		);
	if (parts[2] === 'read') return api.markRead(userId, body.through_id, fetchRef);
	if (request.method === 'POST')
		return api.sendMessage(
			userId,
			{ clientId: body.client_id, body: body.body, imageUrl: body.image_url },
			fetchRef,
		);
	return api.fetchMessages(
		userId,
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
	if (expected.status === 409) return 'conflict';
	if (expected.status === 413) return 'too-large';
	if (expected.status === 422) return 'invalid-image';
	return 'rejected';
}

function respond(expected, request) {
	return vi.fn(async () => ({
		ok: expected.status < 400,
		status: expected.status,
		json: async () => {
			if (expected.body === null || expected.body === undefined) throw new SyntaxError('empty');
			const body = structuredClone(expected.body);
			// An exact retry returns the original message; the client asks for
			// the nonce it sent, which the pack's sample already carries.
			return request.json?.client_id && body.data?.client_id
				? { ...body, data: { ...body.data, client_id: request.json.client_id } }
				: body;
		},
	}));
}

describe('SN-A19 approved contract replay', () => {
	test('covers every private-message case', () => {
		expect(cases).toHaveLength(86);
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verify request and each approved response schema
	test.each(cases.map((c) => [c.id, c]))('%s', async (_id, c) => {
		// The client mints lowercase v4 nonces; the one invalid-nonce case has none.
		const nonce = c.request.json?.client_id;
		if (
			nonce &&
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/u.test(nonce) &&
			c.expect.status === 201
		)
			throw new Error('unexpected nonce in a success case');
		const fetchRef = respond(c.expect, c.request);
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
			else if (!c.request.multipart) expect(init.body).toBeUndefined();
			if (c.request.multipart) {
				expect(init.body).toBeInstanceOf(FormData);
				expect([...init.body.keys()]).toEqual(['image']);
				expect(init.headers['Content-Type']).toBeUndefined();
			}
		}
		if (c.expect.status !== 200 && c.expect.status !== 201) {
			if (c.expect.status === 400 && c.expect.body.error.code === 'VALIDATION_ERROR')
				expect(result.fields).toEqual(c.expect.body.error.fields);
			return;
		}
		const { data, meta } = c.expect.body;
		if (result.entries) {
			expect(result.entries.map((e) => [e.user_id, e.name, e.can_send, e.unread_count])).toEqual(
				data.map((e) => [e.user_id, e.username, e.can_send, e.unread_count]),
			);
			expect(result.entries.map((e) => e.is_online)).toEqual(data.map((e) => e.is_online));
			expect(result.pagination).toEqual(meta.pagination);
		}
		if (result.messages) {
			expect(result.messages).toEqual(data.messages);
			expect(result.hasMore).toBe(data.has_more);
			expect(result.nextBeforeId).toBe(data.next_before_id);
		}
		if (result.message) {
			expect(result.message).toEqual({ ...data, client_id: c.request.json.client_id });
			expect(result.duplicate).toBe(c.expect.status === 200);
		}
		if (result.imageUrl) expect(result.imageUrl).toBe(data.image_url);
		if (result.throughId !== undefined) {
			expect(result.throughId).toBe(data.through_id);
			expect(result.unreadCount).toBe(data.unread_count);
		}
		if (c.request.path.endsWith('/unread')) expect(result.unreadCount).toBe(data.unread_count);
	});
});

function okResponse(data, meta, status = 200) {
	return vi.fn(async () => ({ ok: true, status, json: async () => ({ data, meta }) }));
}
const caseBody = (id) => structuredClone(pack.http_cases.find((c) => c.id === id).expect.body);
const NONCE = '11111111-1111-4111-8111-111111111111';

describe('private-message client redaction and failure handling', () => {
	test('roster rows are a name and an ID only, with presence only when reported', async () => {
		const roster = caseBody('dm-roster');
		roster.data[0].avatar_url = '/api/v1/users/2/avatar';
		roster.data[0].email = 'ada@example.com';
		roster.data[0].profile = { about_me: 'secret' };
		const result = await api.fetchRoster({}, okResponse(roster.data, roster.meta));
		expect(Object.keys(result.entries[0]).sort()).toEqual([
			'can_send',
			'is_online',
			'last_message_at',
			'last_sender_id',
			'name',
			'preview',
			'read_through_id',
			'unread_count',
			'user_id',
		]);
		const hidden = caseBody('dm-roster-retained-private');
		const retained = await api.fetchRoster({}, okResponse(hidden.data, hidden.meta));
		expect('is_online' in retained.entries[0]).toBe(false);
		expect(retained.entries[0].can_send).toBe(false);
	});

	test('a roster, history or send reply that breaks the contract is unavailable', async () => {
		const roster = caseBody('dm-roster');
		expect((await api.fetchRoster({}, okResponse(roster.data))).status).toBe('unavailable');
		for (const mutate of [
			(row) => {
				row.can_send = 'yes';
			},
			(row) => {
				row.unread_count = -1;
			},
			(row) => {
				row.is_online = 'online';
			},
			(row) => {
				row.last_message_preview = null;
			},
			(row) => {
				row.user_id = 0;
			},
		]) {
			const broken = structuredClone(roster.data);
			mutate(broken[0]);
			expect((await api.fetchRoster({}, okResponse(broken, roster.meta))).status).toBe(
				'unavailable',
			);
		}
		expect(
			(await api.fetchRoster({}, okResponse([roster.data[0], roster.data[0]], roster.meta))).status,
		).toBe('unavailable');

		const history = caseBody('dm-history').data;
		const bad = (mutate) => {
			const copy = structuredClone(history);
			mutate(copy);
			return api.fetchMessages(2, {}, okResponse(copy));
		};
		expect((await bad((d) => d.messages.reverse())).status).toBe('unavailable');
		expect((await bad((d) => (d.has_more = true))).status).toBe('unavailable');
		expect((await bad((d) => (d.next_before_id = 501))).status).toBe('unavailable');
		expect((await bad((d) => (d.messages[0].recipient_id = 3))).status).toBe('unavailable');
		expect((await bad((d) => (d.messages[1].sender_id = d.messages[1].recipient_id))).status).toBe(
			'unavailable',
		);
		expect((await bad((d) => (d.messages[0].client_id = 'NOT-A-UUID'))).status).toBe('unavailable');
		expect((await bad((d) => (d.messages[1].image_url = 'https://evil.test/x.png'))).status).toBe(
			'unavailable',
		);
		expect((await bad((d) => delete d.messages)).status).toBe('unavailable');
		// A third party's message in someone else's thread is never shown.
		expect((await api.fetchMessages(3, {}, okResponse(structuredClone(history)))).status).toBe(
			'unavailable',
		);
	});

	test('a send reply must be this account’s message, with the same nonce, to the same person', async () => {
		const created = caseBody('dm-accepted-accepted-private-true').data;
		const send = (reply, userId = 2) =>
			api.sendMessage(userId, { clientId: NONCE, body: 'Hi' }, okResponse(reply, undefined, 201));
		expect((await send(created)).status).toBe('ok');
		expect(
			(await send({ ...created, client_id: '22222222-2222-4222-8222-222222222222' })).status,
		).toBe('unavailable');
		expect((await send(created, 3)).status).toBe('unavailable');
		expect((await send({ ...created, body: undefined })).status).toBe('unavailable');
	});

	test('lost and unconfirmed responses are unavailable and never replayed by the client', async () => {
		const lost = vi.fn(async () => {
			throw new Error('connection lost');
		});
		expect((await api.sendMessage(2, { clientId: NONCE, body: 'Hi' }, lost)).status).toBe(
			'unavailable',
		);
		expect((await api.markRead(2, 502, lost)).status).toBe('unavailable');
		expect(lost).toHaveBeenCalledTimes(2);
		const server = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }));
		expect((await api.fetchUnread(server)).status).toBe('unavailable');
		const empty = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }));
		expect((await api.sendMessage(2, { clientId: NONCE, body: 'Hi' }, empty)).status).toBe(
			'unavailable',
		);
	});

	test('an empty image is omitted from the request and a staged image is claimed by URL', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: caseBody('dm-image-only').data }),
		}));
		await api.sendMessage(
			2,
			{ clientId: NONCE, body: '', imageUrl: '/api/v1/media/701' },
			fetchRef,
		);
		expect(JSON.parse(fetchRef.mock.calls[0][1].body)).toEqual({
			client_id: NONCE,
			body: '',
			image_url: '/api/v1/media/701',
		});
		await api.sendMessage(2, { clientId: NONCE, body: 'x', imageUrl: '' }, fetchRef);
		expect(JSON.parse(fetchRef.mock.calls[1][1].body)).toEqual({ client_id: NONCE, body: 'x' });
	});

	test('private images are read with the session and only when they are checked media', async () => {
		const png = new Blob([new Uint8Array(4)], { type: 'image/png' });
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			blob: async () => png,
			headers: { get: () => 'image/png' },
		}));
		const ok = await api.fetchImage('/api/v1/media/702', fetchRef);
		expect(ok).toEqual({ status: 'ok', blob: png });
		expect(fetchRef.mock.calls[0][1].credentials).toBe('include');
		expect((await api.fetchImage('https://evil.test/a.png', fetchRef)).status).toBe('unavailable');
		expect(fetchRef).toHaveBeenCalledTimes(1);
		const html = vi.fn(async () => ({
			ok: true,
			status: 200,
			blob: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }),
			headers: { get: () => 'image/svg+xml' },
		}));
		expect((await api.fetchImage('/api/v1/media/702', html)).status).toBe('unavailable');
		for (const [status, expected] of [
			[401, 'unauthenticated'],
			[404, 'not-found'],
			[500, 'unavailable'],
		]) {
			const denied = vi.fn(async () => ({ ok: false, status }));
			expect((await api.fetchImage('/api/v1/media/702', denied)).status).toBe(expected);
		}
	});
});
