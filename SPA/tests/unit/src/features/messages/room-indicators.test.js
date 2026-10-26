// @vitest-environment jsdom
// SN-A20: per-group unread counts in the message indicator, the group
// navigation and the Messages page; their separation from the notification
// badge; account changes; and keyboard access.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatBackend } from '../../../../fixtures/phase5/chat-backend.js';
import {
	cleanupMounted,
	deferred,
	deliverFrames,
	frame,
	mountMessagesApp,
	settle,
	textOf,
	type,
} from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const ROOM = '/groups/301/chat';
const indicator = (wrapper) => wrapper.get('[data-testid="message-indicator"]');
const badge = (wrapper) => indicator(wrapper).get('.message-badge').text();
const roomRows = (wrapper) =>
	wrapper
		.findAll('.roster-list[aria-label="Group chats"] .roster-row')
		.map((row) => Number(row.attributes('data-group-id')));
const roomCalls = (fetchRef) =>
	fetchRef.calls.filter((call) => /\/api\/v1\/groups\/\d+\/messages/u.test(call.url));
const roomListCalls = (fetchRef) =>
	fetchRef.calls.filter((call) => /\/api\/v1\/group-chats(\?|$)/u.test(call.url));

// Alex has two unread private messages from Lee (the default). Ada and Lee
// each write once in Chess Club, so he has two unread room messages.
function twoRoomMessages(backend) {
	backend.commitRoom(301, 7, { body: 'Anyone for a game?', created_at: '2026-10-15T10:00:00Z' });
	backend.commitRoom(301, 10, { body: 'Count me in', created_at: '2026-10-15T10:01:00Z' });
	backend.signals = [];
}

function memberSends(backend, userId, body) {
	return backend.request(userId, 'POST', '/api/v1/groups/301/messages', {
		json: {
			membership_id: backend.membershipOf(301, userId).id,
			client_id: crypto.randomUUID(),
			body,
		},
		headers: XHR,
	});
}

describe('SN-A20 the message indicator', () => {
	test('shows private and group unread messages together, labelled as messages', async () => {
		const backend = new ChatBackend();
		twoRoomMessages(backend);
		const { wrapper } = await mountMessagesApp('/people', { backend });
		expect(badge(wrapper)).toBe('4');
		expect(indicator(wrapper).attributes('aria-label')).toBe('Messages, 4 unread messages');
		expect(indicator(wrapper).text()).not.toMatch(/notif/iu);
		expect(indicator(wrapper).attributes('href')).toBe('/messages');
	});

	test('reading the room clears only the room’s part; reading a conversation only the conversation’s', async () => {
		const backend = new ChatBackend();
		twoRoomMessages(backend);
		const app = await mountMessagesApp(ROOM, { backend });
		expect(badge(app.wrapper)).toBe('2');
		expect(backend.roomUnread(42, 301)).toBe(0);
		await app.router.push('/messages/10');
		await settle();
		expect(badge(app.wrapper)).toBe('0');
	});

	test('a room message moves the message indicator and never the notification badge', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp('/people', { backend });
		const trigger = () => app.wrapper.get('.notification-trigger .notification-badge');
		const notices = trigger().text();
		const before = badge(app.wrapper);
		memberSends(backend, 7, 'one more');
		await deliverFrames(app);
		expect(badge(app.wrapper)).toBe(String(Number(before) + 1));
		expect(trigger().text()).toBe(notices);
		// Reading every notice moves only the notification badge.
		await app.notifications.markRead();
		await settle();
		expect(trigger().text()).toBe('0');
		expect(badge(app.wrapper)).toBe(String(Number(before) + 1));
	});

	test('the total is the server’s: a frame refetches it instead of adding to it', async () => {
		const backend = new ChatBackend();
		backend.dmCursors.set('42:10', 504);
		const app = await mountMessagesApp('/people', { backend });
		expect(badge(app.wrapper)).toBe('0');
		const reply = memberSends(backend, 7, 'a');
		await deliverFrames(app);
		expect(badge(app.wrapper)).toBe('1');
		// The same frame again, and a foreign one, do not add.
		frame(app, { type: 'group.message', payload: reply.body.data });
		frame(app, { type: 'group.message', payload: reply.body.data });
		await settle();
		expect(badge(app.wrapper)).toBe('1');
	});

	test('an unknown group total makes the indicator unknown, never a stale number', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'GET', path: /\/group-chats\/unread$/u, repeat: true });
		const { wrapper, messages } = await mountMessagesApp('/people', { backend });
		expect(indicator(wrapper).attributes('aria-label')).toBe('Messages, unread count unavailable');
		expect(badge(wrapper)).toBe('—');
		expect(messages.state.groupUnreadCount).toBeNull();
		expect(messages.state.unreadCount).toBe(2);
	});

	test('leaving the group removes its part of the total', async () => {
		const backend = new ChatBackend();
		backend.commitRoom(301, 7, { body: 'for Lee' });
		backend.signals = [];
		const app = await mountMessagesApp('/people', { backend, viewerId: 10 });
		expect(badge(app.wrapper)).toBe('1');
		backend.removeMember(301, 10);
		backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		expect(badge(app.wrapper)).toBe('0');
	});
});

describe('SN-A20 group navigation', () => {
	test('the Chat tab carries this group’s unread count, and a frame moves it', async () => {
		const backend = new ChatBackend();
		twoRoomMessages(backend);
		const app = await mountMessagesApp('/groups/301', { backend });
		const chat = () => app.wrapper.get('.group-nav a[href="/groups/301/chat"]');
		expect(chat().get('.group-nav__unread').text()).toBe('2');
		expect(chat().attributes('aria-label')).toBe('Chat, 2 unread messages');
		for (const other of ['posts', 'events', 'members'])
			expect(
				app.wrapper
					.get(`.group-nav a[href="/groups/301/${other}"]`)
					.find('.message-unread')
					.exists(),
			).toBe(false);
		memberSends(backend, 7, 'three');
		await deliverFrames(app);
		expect(chat().get('.group-nav__unread').text()).toBe('3');
		expect(chat().attributes('aria-label')).toBe('Chat, 3 unread messages');
	});

	test('the count belongs to the group: another group’s messages and an empty room show none', async () => {
		const app = await mountMessagesApp('/groups/301');
		expect(app.wrapper.find('.group-nav__unread').exists()).toBe(false);
		expect(app.wrapper.get('.group-nav a[href="/groups/301/chat"]').text()).toBe('Chat');
		expect(
			app.wrapper.get('.group-nav a[href="/groups/301/chat"]').attributes('aria-label'),
		).toBeUndefined();
	});

	test('opening the room clears the tab’s count', async () => {
		const backend = new ChatBackend();
		twoRoomMessages(backend);
		const app = await mountMessagesApp(ROOM, { backend });
		expect(app.wrapper.find('.group-nav__unread').exists()).toBe(false);
		expect(app.wrapper.get('.group-nav [aria-current="page"]').text()).toBe('Chat');
	});

	test('the tab never counts for someone who cannot read the room', async () => {
		const backend = new ChatBackend();
		twoRoomMessages(backend);
		const app = await mountMessagesApp('/groups/301', { backend, viewerId: 99 });
		expect(app.wrapper.find('.group-nav').exists()).toBe(true);
		expect(app.wrapper.find('.group-nav__unread').exists()).toBe(false);
		expect(app.wrapper.find('a[href="/groups/301/chat"]').exists()).toBe(false);
		// Nothing about rooms is asked for someone who cannot have one.
		expect(roomListCalls(app.fetchRef)).toHaveLength(0);
	});
});

describe('SN-A20 the Messages page lists group chats', () => {
	test('shows the viewer’s rooms with the last message and the unread count', async () => {
		const backend = new ChatBackend();
		twoRoomMessages(backend);
		const { wrapper } = await mountMessagesApp('/messages', { backend });
		expect(roomRows(wrapper)).toEqual([301]);
		const row = wrapper.get('[data-group-id="301"]');
		expect(row.text()).toContain('Chess Club');
		expect(row.text()).toContain('Lee Example: Count me in');
		expect(row.get('.message-unread').text()).toBe('2');
		expect(row.get('.message-unread').attributes('aria-label')).toBe('2 unread messages');
		expect(row.get('a').attributes('href')).toBe('/groups/301/chat');
		expect(textOf(wrapper)).toContain('1 group chat');
		// Private conversations are listed separately and unchanged.
		expect(wrapper.findAll('.roster-list[aria-label="Conversations"] .roster-row')).toHaveLength(3);
		expect(textOf(wrapper)).not.toContain('Book Club');
	});

	test('the viewer’s own last message reads "You:"', async () => {
		const { wrapper } = await mountMessagesApp('/messages', { viewerId: 10 });
		expect(wrapper.get('[data-group-id="301"]').text()).toContain('You: I do ♟️');
	});

	test('a group with no messages still has a room; a non-member has none', async () => {
		const robin = await mountMessagesApp('/messages', { viewerId: 99 });
		expect(roomRows(robin.wrapper)).toEqual([302]);
		expect(robin.wrapper.get('[data-group-id="302"]').text()).toContain('No messages yet.');
		expect(textOf(robin.wrapper)).not.toContain('Chess Club');
		cleanupMounted();
		const sam = await mountMessagesApp('/messages', { viewerId: 8 });
		expect(textOf(sam.wrapper)).toContain('No group chats yet.');
		expect(sam.wrapper.find('.roster-list[aria-label="Group chats"]').exists()).toBe(false);
		expect(textOf(sam.wrapper)).not.toContain('Chess Club');
		expect(sam.wrapper.find('a[href="/groups"]').exists()).toBe(true);
	});

	test('a room leaves the list the moment the viewer’s membership ends', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp('/messages', { backend, viewerId: 10 });
		expect(roomRows(app.wrapper)).toEqual([301]);
		backend.removeMember(301, 10);
		backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		expect(roomRows(app.wrapper)).toEqual([]);
		expect(textOf(app.wrapper)).not.toContain('Chess Club');
	});

	test('an outage shows a retry for group chats only, and no stale list', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'GET', path: /\/group-chats$/u, repeat: true });
		const { wrapper } = await mountMessagesApp('/messages', { backend });
		expect(textOf(wrapper)).toContain('We can’t load your group chats right now.');
		expect(wrapper.find('.roster-list[aria-label="Group chats"]').exists()).toBe(false);
		// Private conversations are unaffected.
		expect(wrapper.findAll('.roster-list[aria-label="Conversations"] .roster-row')).toHaveLength(3);
		backend.faults.length = 0;
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Try again')
			.trigger('click');
		await settle();
		expect(roomRows(wrapper)).toEqual([301]);
	});

	test('many rooms are paged; a room beyond the first page opens', async () => {
		const backend = new ChatBackend();
		for (let index = 0; index < 60; index += 1) {
			const id = 400 + index;
			backend.groups.set(id, {
				id,
				creator_id: 99,
				title: `Club ${id}`,
				description: 'Many.',
				created_at: '2026-10-08T12:00:00Z',
			});
			backend.memberships.set(600 + index, {
				id: 600 + index,
				group_id: id,
				user_id: 42,
				role: 'member',
				joined_at: '2026-10-08T12:00:00Z',
			});
		}
		const first = await mountMessagesApp('/messages', { backend });
		expect(roomRows(first.wrapper)).toHaveLength(20);
		expect(roomRows(first.wrapper)[0]).toBe(301);
		expect(textOf(first.wrapper)).toContain('61 group chats');
		const next = first.wrapper.get('nav[aria-label="Group chat pages"] a[rel="next"]');
		expect(next.attributes('href')).toBe('/messages?rooms=2');
		cleanupMounted();
		const second = await mountMessagesApp('/messages?rooms=2', { backend });
		expect(roomRows(second.wrapper)[0]).toBe(419);
		cleanupMounted();
		// Group 459 is on the second page of the unpaged room list (50 per page).
		const room = await mountMessagesApp('/groups/459/chat', { backend });
		expect(room.wrapper.get('h1').text()).toBe('Club 459');
		expect(roomListCalls(room.fetchRef).some((call) => call.url.includes('page=2'))).toBe(true);
		expect(textOf(room.wrapper)).toContain('No messages yet. Say hello.');
	});
});

describe('SN-A20 account changes and cleanup', () => {
	test('switching accounts clears the room, the draft and pending messages at once', async () => {
		const app = await mountMessagesApp(ROOM);
		await type(app.wrapper, 'private draft');
		expect(app.messages.draft('room-301').body).toBe('private draft');
		app.current.viewerId = 99;
		await app.session.restore({ force: true });
		await settle();
		expect(app.messages.draft('room-301')).toBeNull();
		expect(textOf(app.wrapper)).not.toContain('private draft');
		expect(textOf(app.wrapper)).not.toContain('Welcome to the club.');
		// Robin is not a member of Chess Club.
		expect(textOf(app.wrapper)).toContain('Only members of Chess Club can chat here.');
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
		await app.router.push('/messages');
		await settle();
		expect(roomRows(app.wrapper)).toEqual([302]);
	});

	test('a response that lands after the account changed is never painted', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp('/messages', {
			before: async (entry) => {
				if (hold && entry.method === 'GET' && /\/groups\/301\/messages/u.test(entry.url))
					await gate.promise;
			},
		});
		hold = true;
		await app.router.push(ROOM);
		await settle();
		app.current.viewerId = 99;
		await app.session.restore({ force: true });
		await settle();
		gate.release();
		await settle();
		expect(textOf(app.wrapper)).not.toContain('Welcome to the club.');
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
	});

	test('a pending send does not complete into the next account', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp(ROOM, {
			before: async (entry) => {
				if (hold && entry.method === 'POST') await gate.promise;
			},
		});
		hold = true;
		await type(app.wrapper, 'in flight');
		await app.wrapper.get('#message-body').trigger('keydown.enter');
		await settle();
		app.current.viewerId = 99;
		await app.session.restore({ force: true });
		await settle();
		gate.release();
		await settle();
		expect(app.messages.outbox('room-301')).toEqual([]);
		expect(textOf(app.wrapper)).not.toContain('in flight');
	});

	test('signing out clears the room, the drafts and the indicator; back never restores them', async () => {
		const app = await mountMessagesApp(ROOM);
		await type(app.wrapper, 'secret');
		await app.wrapper.get('.site-nav__logout').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.name).toBe('login');
		expect(app.messages.draft('room-301')).toBeNull();
		expect(app.messages.state.unreadCount).toBeNull();
		expect(app.messages.state.groupUnreadCount).toBeNull();
		expect(app.wrapper.find('[data-testid="message-indicator"]').exists()).toBe(false);
		await app.router.back();
		await settle();
		expect(textOf(app.wrapper)).not.toContain('Welcome to the club.');
		expect(textOf(app.wrapper)).not.toContain('secret');
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
	});

	test('a lost session on a room read ends the session cleanly', async () => {
		const app = await mountMessagesApp(ROOM);
		app.current.viewerId = null;
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(app.router.currentRoute.value.name).toBe('login');
		expect(textOf(app.wrapper)).not.toContain('Welcome to the club.');
		expect(roomCalls(app.fetchRef).length).toBeGreaterThan(0);
	});
});

describe('SN-A20 keyboard and accessibility', () => {
	test('the room, composer and Chat tab are reachable with names and roles', async () => {
		const app = await mountMessagesApp(ROOM);
		const list = app.wrapper.get('.message-list');
		expect(list.attributes('role')).toBe('log');
		expect(list.attributes('aria-live')).toBe('polite');
		expect(list.attributes('aria-label')).toBe('Messages in Chess Club');
		expect(list.attributes('tabindex')).toBe('0');
		expect(app.wrapper.get('label[for="message-body"]').text()).toBe('Message Chess Club');
		expect(app.wrapper.get('nav[aria-label="Chess Club sections"]').exists()).toBe(true);
		for (const control of app.wrapper.findAll('form button, form textarea, form input'))
			expect(control.attributes('tabindex')).not.toBe('-1');
		// The unread count in the tab is announced once, as text, not twice.
		const messages = await mountMessagesApp('/messages');
		expect(messages.wrapper.get('#rooms-heading').text()).toBe('Group chats');
		expect(messages.wrapper.get('section[aria-labelledby="rooms-heading"]').exists()).toBe(true);
	});
});
