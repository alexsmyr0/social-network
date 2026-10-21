// @vitest-environment jsdom
// SN-A20: the approved role matrix (creator, member, invitee, requester,
// outsider, departed, removed, departed author), the removal/readmission
// journey and the removal-versus-send race, replayed through the Vue
// application for the viewer who holds each role.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatBackend, loadChatFixtures } from '../../../../fixtures/phase5/chat-backend.js';
import {
	cleanupMounted,
	deliverFrames,
	mountMessagesApp,
	settle,
	textOf,
	type,
} from './harness.js';

const pack = loadChatFixtures();
const ROOM = '/groups/10/chat';
const NONCE_1 = '11111111-1111-4111-8111-111111111111';
const NONCE_2 = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const messageIds = (wrapper) =>
	wrapper
		.findAll('.message[data-message-id]')
		.map((item) => Number(item.attributes('data-message-id')));
const roomCalls = (fetchRef) =>
	fetchRef.calls.filter((call) => /\/api\/v1\/groups\/10\/messages/u.test(call.url));
const cell = (role, surface) =>
	pack.group_matrix.find((item) => item.case_id === `group-${role}-${surface}`);

describe('SN-A20 role matrix in the application', () => {
	test('has all 8 roles with history, send and read cells', () => {
		expect(Object.keys(pack.roles)).toHaveLength(8);
		for (const role of Object.keys(pack.roles))
			for (const surface of ['room_history', 'room_send', 'room_read'])
				expect(cell(role, surface)).toBeDefined();
	});

	test.each(
		Object.entries(pack.roles),
	)('%s (account %i): the room and its composer render exactly as the matrix allows', async (role, id) => {
		const backend = ChatBackend.fromPack(pack);
		const app = await mountMessagesApp(ROOM, { backend, viewerId: id });
		const history = cell(role, 'room_history').allow;
		const sending = cell(role, 'room_send').allow;
		expect(app.wrapper.find('.message-list').exists()).toBe(history);
		expect(app.wrapper.find('form').exists()).toBe(sending);
		if (history) {
			expect(messageIds(app.wrapper)).toEqual([801, 802]);
			expect(textOf(app.wrapper)).toContain('Message Chess');
		} else {
			expect(textOf(app.wrapper)).toContain('Only members of Chess can chat here.');
			for (const text of ['hello', 'welcome', 'Alex', 'Ada']) {
				// Names appear only inside the room, never in the notice.
				expect(app.wrapper.find('.social-state').text()).not.toContain(text);
			}
			// A role that may not read the room never asks for it.
			expect(roomCalls(app.fetchRef)).toHaveLength(0);
			expect(
				app.fetchRef.calls.filter((call) => /\/api\/v1\/group-chats(\?|$)/u.test(call.url)),
			).toHaveLength(0);
		}
	});

	test.each(
		Object.entries(pack.roles),
	)('%s (account %i): reading the room marks it read exactly when the matrix allows', async (role, id) => {
		const backend = ChatBackend.fromPack(pack);
		backend.commitRoom(10, 1, { body: 'fresh' });
		backend.signals = [];
		const app = await mountMessagesApp(ROOM, { backend, viewerId: id });
		const marks = app.fetchRef.calls.filter(
			(call) => call.method === 'PUT' && /messages\/read$/u.test(call.url),
		);
		const allowed = cell(role, 'room_read').allow;
		// The creator wrote the newest message himself, so he has nothing to mark;
		// the member has unread messages from the creator.
		expect(marks.length > 0).toBe(allowed && role !== 'creator');
		if (marks.length > 0) {
			expect(marks[0].json).toEqual({ membership_id: 102, through_id: 803 });
			expect(backend.groupCursors.get(102)).toBe(803);
		}
	});
});

describe('SN-A20 removal and readmission journey in the application', () => {
	test('replays the pack’s journey for the member', async () => {
		vi.spyOn(globalThis.crypto, 'randomUUID')
			.mockReturnValueOnce(NONCE_1)
			.mockReturnValueOnce(NONCE_2);
		const backend = ChatBackend.fromPack(pack);
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 2 });
		// Open: the creator's newest message is unread and is marked read.
		expect(messageIds(app.wrapper)).toEqual([801, 802]);
		expect(backend.groupCursors.get(102)).toBe(802);

		// The member sends: 803.
		const field = await type(app.wrapper, 'Room');
		await field.trigger('keydown.enter');
		await settle();
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		const first = roomCalls(app.fetchRef).find((call) => call.method === 'POST');
		expect(first.json).toEqual({ membership_id: 102, client_id: NONCE_1, body: 'Room' });

		// Removed: the room, composer and cached messages go; the creator still
		// reads the whole room, including the departed member's message.
		backend.removeMember(10, 2);
		backend.signal('social.invalidate', [2]);
		await deliverFrames(app);
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
		expect(app.wrapper.find('form').exists()).toBe(false);
		expect(textOf(app.wrapper)).not.toContain('Room');
		const creator = backend.request(1, 'GET', '/api/v1/groups/10/messages', {});
		expect(creator.body.data.messages.map((message) => message.id)).toEqual([801, 802, 803]);
		expect(backend.request(2, 'GET', '/api/v1/groups/10/messages', {}).status).toBe(404);

		// Readmitted under membership 112: the whole room is readable, nothing is
		// unread, and the next send goes under the new membership.
		const admitted = backend.admit(10, 2, []);
		expect(admitted.id).toBe(112);
		backend.signal('social.invalidate', [2]);
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		// (The member's one unread private message from the pack is not the room's.)
		expect(app.messages.state.groupUnreadCount).toBe(0);
		const again = await type(app.wrapper, 'Room');
		await again.trigger('keydown.enter');
		await settle();
		const posts = roomCalls(app.fetchRef).filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(2);
		expect(posts[1].json).toEqual({ membership_id: 112, client_id: NONCE_2, body: 'Room' });
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
		// The old generation can neither send nor be revived.
		const stale = backend.request(2, 'POST', '/api/v1/groups/10/messages', {
			json: { membership_id: 102, client_id: NONCE_1, body: 'Room' },
		});
		expect(stale.body.error.code).toBe('STALE_MEMBERSHIP');
		const conflict = backend.request(2, 'POST', '/api/v1/groups/10/messages', {
			json: { membership_id: 112, client_id: NONCE_1, body: 'Room' },
		});
		expect(conflict.body.error.code).toBe('MESSAGE_CONFLICT');
	});

	test('removal before the send: the send is refused and the room clears', async () => {
		vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(NONCE_1);
		const backend = ChatBackend.fromPack(pack);
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 2 });
		backend.removeMember(10, 2);
		backend.signals = [];
		const field = await type(app.wrapper, 'Room');
		await field.trigger('keydown.enter');
		await settle();
		expect(backend.groupMessages.size).toBe(2);
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members of Chess can chat here.');
	});

	test('send before the removal: the message is kept for the room and the sender’s view clears', async () => {
		vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(NONCE_1);
		const backend = ChatBackend.fromPack(pack);
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 2 });
		const field = await type(app.wrapper, 'Room');
		await field.trigger('keydown.enter');
		await settle();
		expect(backend.groupMessages.size).toBe(3);
		backend.removeMember(10, 2);
		backend.signal('social.invalidate', [2]);
		await deliverFrames(app);
		expect(backend.groupMessages.size).toBe(3);
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
		expect(textOf(app.wrapper)).not.toContain('Room');
	});
});

describe('SN-A20 room frames reach exactly the members', () => {
	test('a member’s message is a frame for every current member and nobody else', () => {
		const backend = ChatBackend.fromPack(pack);
		const reply = backend.request(2, 'POST', '/api/v1/groups/10/messages', {
			json: { membership_id: 102, client_id: NONCE_1, body: 'Hi 👋' },
		});
		expect(reply.status).toBe(201);
		expect(backend.signals).toEqual([
			{ type: 'group.message', recipients: [1, 2], payload: reply.body.data },
		]);
		backend.signals = [];
		backend.removeMember(10, 2);
		backend.request(1, 'POST', '/api/v1/groups/10/messages', {
			json: { membership_id: 101, client_id: NONCE_2, body: 'Alone' },
		});
		expect(backend.signals[0].recipients).toEqual([1]);
	});
});
