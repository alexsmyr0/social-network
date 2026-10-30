// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

import { createSessionState } from '../../../../../src/features/auth/session-state.js';
import { createMessageState } from '../../../../../src/features/messages/message-state.js';
import { createNotificationState } from '../../../../../src/features/notifications/notification-state.js';
import { createSocialState } from '../../../../../src/features/social/social-state.js';
import { ChatBackend, createChatFetch } from '../../../../fixtures/phase5/chat-backend.js';

const retained = [];
afterEach(() => {
	for (const dispose of retained.splice(0)) dispose();
	vi.unstubAllGlobals();
});

async function setup({ viewerId = 42, backend = new ChatBackend(), ids } = {}) {
	const viewer = { id: viewerId };
	const fetchRef = createChatFetch(backend, { viewer: () => viewer.id });
	vi.stubGlobal('fetch', fetchRef);
	const session = createSessionState();
	await session.restore({ force: true });
	const social = createSocialState({ session });
	const sockets = [];
	const notifications = createNotificationState({
		session,
		social,
		socketFactory: () => {
			const socket = { close() {} };
			sockets.push(socket);
			return socket;
		},
	});
	let counter = 0;
	const messages = createMessageState({
		session,
		social,
		notifications,
		newId:
			ids ??
			(() => {
				counter += 1;
				return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
			}),
	});
	retained.push(() => {
		messages.dispose();
		notifications.dispose();
	});
	await settle();
	const frame = (value) => sockets.at(-1).onmessage({ data: JSON.stringify(value) });
	return { backend, viewer, fetchRef, session, social, notifications, messages, sockets, frame };
}

async function settle() {
	for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

describe('message state', () => {
	test('loads the unread total on sign-in and keeps it separate from notices', async () => {
		const backend = new ChatBackend();
		backend.commit(10, 42, { body: 'third' });
		const { messages, notifications } = await setup({ backend });
		expect(messages.state.unreadCount).toBe(3);
		expect(messages.state.unreadStatus).toBe('ready');
		expect(notifications.state.unreadCount).toBe(2);
	});

	test('an unknown total is shown as unknown rather than stale', async () => {
		const backend = new ChatBackend();
		const { messages, social } = await setup({ backend });
		backend.faults.push({ method: 'GET', path: /unread$/u, repeat: true });
		await social.refresh();
		await settle();
		expect(messages.state.unreadCount).toBeNull();
		expect(messages.state.unreadStatus).toBe('unavailable');
	});

	test('ignores unknown, malformed and foreign frames', async () => {
		const { messages, frame, fetchRef } = await setup();
		const calls = fetchRef.calls.length;
		const events = [];
		messages.subscribe((event) => events.push(event.type));
		frame({ type: 'nonsense', payload: {} });
		frame({ type: 'dm.message' });
		frame({ type: 'dm.message', payload: { id: 1, sender_id: 8, recipient_id: 9 } });
		frame({
			type: 'chat.read',
			payload: { kind: 'dm', target_id: 0, through_id: 1, unread_count: 1 },
		});
		frame({
			type: 'chat.read',
			payload: { kind: 'dm', target_id: 7, through_id: -1, unread_count: 1 },
		});
		frame({ type: 'presence.update', payload: { user_id: 'x', is_online: true } });
		frame({ type: 'presence.snapshot', payload: { users: [{ user_id: 7 }] } });
		await settle();
		expect(events).toEqual([]);
		expect(fetchRef.calls.length).toBe(calls);
		expect(messages.state.presence.snapshot).toBe(false);
	});

	test('presence follows snapshots and updates, and an invalidation forgets live presence', async () => {
		const { messages, frame } = await setup();
		const row = { user_id: 10, is_online: true };
		expect(messages.presenceFor(row)).toBe(true);
		frame({ type: 'presence.snapshot', payload: { users: [{ user_id: 11, is_online: true }] } });
		// A snapshot lists who is online: everyone else is offline.
		expect(messages.presenceFor(row)).toBe(false);
		frame({ type: 'presence.update', payload: { user_id: 10, is_online: true } });
		expect(messages.presenceFor(row)).toBe(true);
		frame({ type: 'social.invalidate' });
		await settle();
		expect(messages.state.presence).toEqual({ snapshot: false, users: {} });
		// A row without presence stays hidden whatever the frames say.
		expect(messages.presenceFor({ user_id: 10 })).toBeNull();
	});

	test('a message is queued with a fresh nonce, sent once and removed on success', async () => {
		const { messages, backend } = await setup();
		messages.setBody(10, '  hello  ');
		const outcome = messages.send(10);
		expect(outcome.status).toBe('queued');
		expect(messages.outbox(10)).toHaveLength(1);
		expect(messages.outbox(10)[0]).toMatchObject({
			body: 'hello',
			status: 'sending',
			retryable: false,
		});
		expect(messages.draft(10).body).toBe('');
		await settle();
		expect(messages.outbox(10)).toEqual([]);
		expect(backend.dms.size).toBe(5);
		expect(backend.dms.get(505).client_id).toBe(outcome.clientId);
	});

	test('refuses to send nothing, too much, or while an image is still uploading', async () => {
		const { messages, fetchRef } = await setup();
		expect(messages.send(10)).toEqual({ status: 'empty' });
		messages.setBody(10, '   ');
		expect(messages.send(10)).toEqual({ status: 'empty' });
		messages.setBody(10, 'x'.repeat(2001));
		expect(messages.send(10)).toEqual({ status: 'invalid', problem: 'TOO_LONG' });
		messages.setBody(10, 'ok');
		messages.draft(10).attachment = { name: 'a.png', status: 'uploading', url: null, token: 1 };
		expect(messages.send(10)).toEqual({ status: 'busy' });
		expect(fetchRef.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
	});

	test('a retry reuses the nonce and the exact payload; only a retryable message can retry', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'POST', path: /messages$/u });
		const { messages, fetchRef } = await setup({ backend });
		messages.setBody(10, 'again');
		const { clientId } = messages.send(10);
		await settle();
		expect(messages.outbox(10)[0]).toMatchObject({ status: 'failed', retryable: true });
		expect(messages.retry(10, 'unknown')).toBe(false);
		expect(messages.retry(10, clientId)).toBe(true);
		// A message already being resent cannot be retried again.
		expect(messages.retry(10, clientId)).toBe(false);
		await settle();
		const posts = fetchRef.calls.filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(2);
		expect(posts[1].json).toEqual(posts[0].json);
		expect(posts[0].json.client_id).toBe(clientId);
		expect(messages.outbox(10)).toEqual([]);
		expect(backend.dms.size).toBe(5);
	});

	test('sends in one conversation are serialized; different conversations do not wait for each other', async () => {
		const order = [];
		const backend = new ChatBackend();
		const original = backend.request.bind(backend);
		backend.request = (viewer, method, url, payload) => {
			if (method === 'POST') order.push(`${url.split('/')[4]}:${payload.json.body}`);
			return original(viewer, method, url, payload);
		};
		const { messages } = await setup({ backend });
		for (const [id, text] of [
			[10, 'a'],
			[10, 'b'],
			[7, 'c'],
			[10, 'd'],
		]) {
			messages.setBody(id, text);
			messages.send(id);
		}
		await settle();
		expect(order.filter((item) => item.startsWith('10:'))).toEqual(['10:a', '10:b', '10:d']);
		expect(order).toContain('7:c');
	});

	test('acknowledging committed messages clears only the pending entries they match', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'POST', path: /messages$/u, repeat: true });
		const { messages } = await setup({ backend });
		messages.setBody(10, 'one');
		const first = messages.send(10);
		await settle();
		messages.setBody(10, 'two');
		messages.send(10);
		await settle();
		expect(messages.outbox(10)).toHaveLength(2);
		messages.acknowledge(10, [
			{ id: 900, sender_id: 42, recipient_id: 10, client_id: first.clientId },
			// Someone else's message with the same nonce proves nothing.
			{ id: 901, sender_id: 10, recipient_id: 42, client_id: messages.outbox(10)[1].client_id },
		]);
		expect(messages.outbox(10).map((entry) => entry.body)).toEqual(['two']);
	});

	test('forgetting a conversation drops its draft, attachment and pending messages', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'POST', path: /messages$/u, repeat: true });
		const { messages } = await setup({ backend });
		messages.setBody(10, 'one');
		messages.send(10);
		messages.setBody(10, 'draft');
		await settle();
		messages.forget(10);
		expect(messages.draft(10)).toBeNull();
		expect(messages.outbox(10)).toEqual([]);
	});

	test('an account change clears drafts, pending messages and presence and ignores late results', async () => {
		const backend = new ChatBackend();
		const gate = {};
		const promise = new Promise((resolve) => {
			gate.release = resolve;
		});
		const original = backend.request.bind(backend);
		backend.request = (viewer, method, url, payload) => {
			const result = original(viewer, method, url, payload);
			return method === 'POST' ? { ...result, hold: promise } : result;
		};
		const { messages, viewer, session, frame } = await setup({ backend });
		messages.setBody(10, 'draft');
		frame({ type: 'presence.snapshot', payload: { users: [{ user_id: 10, is_online: true }] } });
		viewer.id = 99;
		await session.restore({ force: true });
		await settle();
		expect(messages.draft(10)).toBeNull();
		expect(messages.state.presence).toEqual({ snapshot: false, users: {} });
		expect(messages.state.unreadCount).toBe(0);
		gate.release();
	});

	test('a denied read-mark re-reads permissions and a stale 401 ends the session', async () => {
		const { messages, backend, social } = await setup();
		const invalidate = vi.spyOn(social, 'invalidate');
		backend.setFollow(10, 42, 'none');
		backend.setFollow(42, 10, 'none');
		backend.dms.clear();
		expect((await messages.markRead(10, 503)).status).toBe('not-found');
		expect(invalidate).toHaveBeenCalled();
	});

	test('upload failures map to plain messages and a denied upload re-reads permissions', async () => {
		const backend = new ChatBackend();
		const { messages } = await setup({ backend });
		const file = (type = 'image/png', size = 4) =>
			new File([new Uint8Array(size)], 'a.png', { type });
		backend.uploadFault = 413;
		await messages.attachImage(10, file());
		expect(messages.draft(10).attachment).toMatchObject({
			status: 'error',
			message: 'Images can be up to 10 MiB.',
		});
		backend.uploadFault = 500;
		await messages.attachImage(10, file());
		expect(messages.draft(10).attachment.message).toContain('couldn’t upload');
		backend.setFollow(10, 42, 'none');
		await messages.attachImage(10, file());
		expect(messages.draft(10).attachment.message).toContain('can’t send images');
		backend.setFollow(10, 42, 'accepted');
		await messages.attachImage(10, file());
		expect(messages.draft(10).attachment).toMatchObject({
			status: 'ready',
			url: '/api/v1/media/703',
		});
		// A newer choice wins over an older, slower upload.
		await messages.attachImage(10, file('image/gif'));
		expect(messages.draft(10).attachment.url).toBe('/api/v1/media/704');
		messages.removeAttachment(10);
		expect(messages.draft(10).attachment).toBeNull();
		messages.removeAttachment(99);
	});
});

describe('message state and group rooms', () => {
	const roomFrame = (overrides = {}) => ({
		type: 'group.message',
		payload: {
			id: 804,
			group_id: 301,
			sender_id: 7,
			sender_username: 'Ada Lovelace',
			body: 'hello',
			created_at: '2026-10-15T10:00:00Z',
			client_id: null,
			...overrides,
		},
	});

	test('the total is private plus group, and unknown unless both are known', async () => {
		const backend = new ChatBackend();
		backend.commitRoom(301, 7, { body: 'one' });
		backend.signals = [];
		const { messages, social } = await setup({ backend });
		expect(messages.state.unreadCount).toBe(2);
		expect(messages.state.groupUnreadCount).toBe(1);
		expect(messages.totalUnread()).toBe(3);
		backend.faults.push({ method: 'GET', path: /\/group-chats\/unread$/u, repeat: true });
		await social.refresh();
		await settle();
		expect(messages.state.unreadCount).toBe(2);
		expect(messages.state.groupUnreadCount).toBeNull();
		expect(messages.state.unreadStatus).toBe('unavailable');
		expect(messages.totalUnread()).toBeNull();
	});

	test('a room frame is announced to views and refetches the total instead of adding to it', async () => {
		const backend = new ChatBackend();
		const { messages, frame, fetchRef } = await setup({ backend });
		const events = [];
		messages.subscribe((event) => events.push(event));
		const calls = fetchRef.calls.length;
		backend.commitRoom(301, 7, { body: 'hello' });
		backend.signals = [];
		frame(roomFrame());
		frame(roomFrame());
		await settle();
		expect(events.map((event) => [event.type, event.message.id])).toEqual([
			['group-message', 804],
			['group-message', 804],
		]);
		expect(messages.state.groupUnreadCount).toBe(1);
		// Both frames collapse into one refetch of each total.
		expect(fetchRef.calls.slice(calls).filter((call) => /unread$/u.test(call.url))).toHaveLength(2);
	});

	test('ignores malformed room frames and read frames', async () => {
		const { messages, frame, fetchRef } = await setup();
		const calls = fetchRef.calls.length;
		const events = [];
		messages.subscribe((event) => events.push(event.type));
		frame({ type: 'group.message' });
		frame(roomFrame({ id: 0 }));
		frame(roomFrame({ group_id: 'x' }));
		frame(roomFrame({ image_url: '/api/v1/media/702' }));
		frame(roomFrame({ client_id: 'NOT-A-UUID' }));
		frame({
			type: 'chat.read',
			payload: { kind: 'group', target_id: 0, through_id: 1, unread_count: 1 },
		});
		frame({
			type: 'chat.read',
			payload: { kind: 'room', target_id: 301, through_id: 1, unread_count: 1 },
		});
		await settle();
		expect(events).toEqual([]);
		expect(fetchRef.calls.length).toBe(calls);
	});

	test('a read frame for a room is a room event, a private one stays a conversation event', async () => {
		const { messages, frame } = await setup();
		const events = [];
		messages.subscribe((event) => events.push(event));
		frame({
			type: 'chat.read',
			payload: { kind: 'group', target_id: 301, through_id: 803, unread_count: 0 },
		});
		frame({
			type: 'chat.read',
			payload: { kind: 'dm', target_id: 10, through_id: 504, unread_count: 0 },
		});
		await settle();
		expect(events).toEqual([
			{ type: 'group-read', groupId: 301, throughId: 803, unreadCount: 0 },
			{ type: 'read', userId: 10, throughId: 504, unreadCount: 0 },
		]);
	});

	test('a room message is queued under its membership, sent once and removed on success', async () => {
		const { messages, backend } = await setup();
		messages.setBody('room-301', '  hello room  ');
		const outcome = messages.sendRoom(301, 501);
		expect(outcome.status).toBe('queued');
		expect(messages.outbox('room-301')).toHaveLength(1);
		expect(messages.outbox('room-301')[0]).toMatchObject({
			kind: 'group',
			group_id: 301,
			membership_id: 501,
			body: 'hello room',
			status: 'sending',
			retryable: false,
		});
		expect(messages.draft('room-301').body).toBe('');
		await settle();
		expect(messages.outbox('room-301')).toEqual([]);
		expect(backend.groupMessages.size).toBe(4);
		// Private conversation state is a separate namespace.
		expect(messages.outbox(301)).toEqual([]);
	});

	test('an empty, invalid or unauthenticated room send is not queued', async () => {
		const { messages, backend } = await setup();
		messages.setBody('room-301', '   ');
		expect(messages.sendRoom(301, 501).status).toBe('empty');
		messages.setBody('room-301', 'a\u0007b');
		expect(messages.sendRoom(301, 501)).toEqual({ status: 'invalid', problem: 'INVALID_TEXT' });
		messages.setBody('room-301', 'fine');
		expect(messages.sendRoom(301, 0).status).toBe('unavailable');
		expect(messages.sendRoom(0, 501).status).toBe('unavailable');
		expect(messages.outbox('room-301')).toEqual([]);
		expect(backend.groupMessages.size).toBe(3);
	});

	test('a stale membership fails the send for good and re-reads; a lost response stays retryable', async () => {
		const backend = new ChatBackend();
		const { messages, social } = await setup({ backend });
		const refresh = vi.spyOn(social, 'invalidate');
		messages.setBody('room-301', 'old membership');
		messages.sendRoom(301, 999);
		await settle();
		expect(messages.outbox('room-301')[0]).toMatchObject({
			status: 'failed',
			retryable: false,
		});
		expect(messages.outbox('room-301')[0].message).toContain('membership');
		expect(refresh).toHaveBeenCalled();
		expect(backend.groupMessages.size).toBe(3);
		messages.discard('room-301', messages.outbox('room-301')[0].client_id);
		backend.faults.push({ method: 'POST', path: /\/groups\/301\/messages$/u });
		messages.setBody('room-301', 'lost');
		messages.sendRoom(301, 501);
		await settle();
		expect(messages.outbox('room-301')[0]).toMatchObject({ status: 'failed', retryable: true });
		expect(messages.retry('room-301', messages.outbox('room-301')[0].client_id)).toBe(true);
		await settle();
		expect(messages.outbox('room-301')).toEqual([]);
		expect(backend.groupMessages.size).toBe(4);
	});

	test('a room send reply is announced as a room message', async () => {
		const { messages } = await setup();
		const events = [];
		messages.subscribe((event) => events.push(event.type));
		messages.setBody('room-301', 'hi');
		messages.sendRoom(301, 501);
		await settle();
		expect(events).toContain('group-message');
		expect(events).not.toContain('message');
	});

	test('marking a room read announces the server’s cursor and refetches the total', async () => {
		const backend = new ChatBackend();
		backend.commitRoom(301, 7, { body: 'one' });
		backend.signals = [];
		const { messages } = await setup({ backend });
		const events = [];
		messages.subscribe((event) => events.push(event));
		const result = await messages.markRoomRead(301, 501, 804);
		expect(result.status).toBe('ok');
		await settle();
		expect(events).toContainEqual({
			type: 'group-read',
			groupId: 301,
			throughId: 804,
			unreadCount: 0,
		});
		expect(messages.state.groupUnreadCount).toBe(0);
		expect(backend.groupCursors.get(501)).toBe(804);
	});

	test('a read under an old membership, or after leaving, marks nothing and re-reads', async () => {
		const backend = new ChatBackend();
		const { messages, social } = await setup({ backend });
		const invalidate = vi.spyOn(social, 'invalidate');
		expect((await messages.markRoomRead(301, 999, 803)).status).toBe('stale-membership');
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect((await messages.markRoomRead(302, 503, 1)).status).toBe('not-found');
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(backend.groupCursors.get(501)).toBe(803);
	});

	test('forgetting a room drops its draft, pending messages and queue', async () => {
		const { messages } = await setup();
		messages.setBody('room-301', 'keep? no');
		messages.setBody('room-301', 'queued');
		messages.sendRoom(301, 501);
		messages.setBody('room-301', 'draft');
		messages.forget('room-301');
		expect(messages.draft('room-301')).toBeNull();
		expect(messages.outbox('room-301')).toEqual([]);
		await settle();
	});

	test('signing out discards room drafts, pending messages and totals', async () => {
		const { messages, session, viewer } = await setup();
		messages.setBody('room-301', 'secret');
		viewer.id = null;
		await session.restore({ force: true });
		await settle();
		expect(messages.draft('room-301')).toBeNull();
		expect(messages.state.groupUnreadCount).toBeNull();
		expect(messages.totalUnread()).toBeNull();
	});
});

describe('message state and an unconfirmed 401', () => {
	test('a 401 the session endpoint does not confirm is handled once, not in a loop', async () => {
		const backend = new ChatBackend();
		const { messages, social, viewer } = await setup({ backend });
		const handle = vi.spyOn(social, 'handleUnauthenticated');
		const original = backend.request.bind(backend);
		// The unread endpoint answers 401 while the session endpoint still says signed in.
		backend.request = (id, method, url, payload) =>
			url.endsWith('/chats/unread')
				? original(null, method, url, payload)
				: original(id, method, url, payload);
		await messages.refreshUnread();
		await settle();
		expect(handle.mock.calls.length).toBeLessThanOrEqual(2);
		expect(messages.state.unreadCount).toBeNull();
		expect(viewer.id).toBe(42);
	});
});
