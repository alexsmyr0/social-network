// @vitest-environment jsdom
// SN-A20: group chat against the stateful SN-B20 model (itself proved against
// the approved pack by room-model.test.js): access by role, history and
// paging, sending and retrying under a membership, live frames, recovery,
// reading, and membership loss and return.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatBackend } from '../../../../fixtures/phase5/chat-backend.js';
import {
	cleanupMounted,
	connect,
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

// Viewer 42 is Alex, creator of Chess Club (301, membership 501). Ada (7,
// private, membership 502) and Lee (10, membership 504) are members; the room
// holds 801 (Ada), 802 (Alex) and 803 (Lee), all read. Sam (8) is invited, Pat
// (9) has asked to join, Robin (99) and Quinn (12) are outsiders.
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const ROOM = '/groups/301/chat';
const messageIds = (wrapper) =>
	wrapper
		.findAll('.message[data-message-id]')
		.map((item) => Number(item.attributes('data-message-id')));
const bodies = (wrapper) => wrapper.findAll('.message__body').map((item) => item.text());
const authors = (wrapper) => wrapper.findAll('.message__who').map((item) => item.text());
const indicator = (wrapper) => wrapper.get('[data-testid="message-indicator"]');
const pending = (wrapper) => wrapper.findAll('.message--pending');
const roomCalls = (fetchRef, { method, path } = {}) =>
	fetchRef.calls.filter(
		(call) =>
			/\/api\/v1\/groups\/\d+\/messages/u.test(call.url) &&
			(!method || call.method === method) &&
			(!path || path.test(call.url)),
	);
const sendCalls = (fetchRef) => roomCalls(fetchRef, { method: 'POST' });
const readCalls = (fetchRef) => roomCalls(fetchRef, { method: 'PUT' });
const roomListCalls = (fetchRef) =>
	fetchRef.calls.filter((call) => /\/api\/v1\/group-chats(\?|$)/u.test(call.url));
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function submit(wrapper, text) {
	const field = await type(wrapper, text);
	await field.trigger('keydown.enter');
}

// Room messages committed by other members while nobody is listening.
function seedRoom(backend, count, { senders = [7, 10] } = {}) {
	for (let index = 0; index < count; index += 1)
		backend.commitRoom(301, senders[index % senders.length], { body: `note ${index + 1}` });
	backend.signals = [];
}

// Alex has read his private conversations, so only the group counts.
function quietDms(backend) {
	backend.dmCursors.set('42:10', 504);
}

// What another member's session sends: the committed message, then its signals.
function memberSends(backend, userId, body, clientId) {
	const membership = backend.membershipOf(301, userId);
	return backend.request(userId, 'POST', '/api/v1/groups/301/messages', {
		json: {
			membership_id: membership.id,
			client_id: clientId ?? crypto.randomUUID(),
			body,
		},
		headers: XHR,
	});
}

describe('SN-A20 room access by role', () => {
	test('the creator opens the room: history in order, names, composer and no image control', async () => {
		const app = await mountMessagesApp(ROOM);
		const { wrapper } = app;
		expect(wrapper.get('h1').text()).toBe('Chess Club');
		expect(wrapper.get('.eyebrow').text()).toBe('Group chat');
		expect(messageIds(wrapper)).toEqual([801, 802, 803]);
		expect(authors(wrapper)).toEqual(['Ada Lovelace', 'You', 'Lee Example']);
		expect(bodies(wrapper)).toEqual([
			'Welcome to the club.',
			'Thanks, Ada. Who has a board?',
			'I do ♟️',
		]);
		expect(wrapper.get('label[for="message-body"]').text()).toBe('Message Chess Club');
		expect(wrapper.find('#message-image').exists()).toBe(false);
		expect(wrapper.find('.file-button').exists()).toBe(false);
		expect(wrapper.get('.message-list').attributes('aria-label')).toBe('Messages in Chess Club');
		// The Chat tab of the group navigation is the current page.
		expect(wrapper.get('.group-nav [aria-current="page"]').text()).toContain('Chat');
		expect(app.router.currentRoute.value.name).toBe('group-chat');
		// Nothing is unread, so nothing is marked read.
		expect(readCalls(app.fetchRef)).toHaveLength(0);
	});

	test('an ordinary member opens the same room', async () => {
		const { wrapper, backend } = await mountMessagesApp(ROOM, { viewerId: 10 });
		expect(wrapper.get('h1').text()).toBe('Chess Club');
		expect(authors(wrapper)).toEqual(['Ada Lovelace', 'Alex Example', 'You']);
		expect(wrapper.find('form').exists()).toBe(true);
		expect(backend.groupMessages.size).toBe(3);
	});

	test.each([
		[8, 'an invitee'],
		[9, 'a pending requester'],
		[99, 'an outsider'],
		[12, 'another outsider'],
	])('%i (%s) sees only the members-only notice and the room is never requested', async (id) => {
		const { wrapper, fetchRef } = await mountMessagesApp(ROOM, { viewerId: id });
		expect(textOf(wrapper)).toContain('Only members of Chess Club can chat here.');
		expect(wrapper.find('form').exists()).toBe(false);
		expect(wrapper.find('.message-list').exists()).toBe(false);
		expect(wrapper.find('.group-nav').exists()).toBe(false);
		for (const text of ['Welcome to the club.', 'I do', 'Ada Lovelace', 'Lee Example'])
			expect(textOf(wrapper)).not.toContain(text);
		expect(roomCalls(fetchRef)).toHaveLength(0);
		expect(roomListCalls(fetchRef)).toHaveLength(0);
		expect(wrapper.find('a[href="/groups/301"]').exists()).toBe(true);
	});

	test('a departed member sees the notice, not the retained history', async () => {
		const backend = new ChatBackend();
		backend.removeMember(301, 10);
		const { wrapper, fetchRef } = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		expect(textOf(wrapper)).toContain('Only members of Chess Club can chat here.');
		expect(textOf(wrapper)).not.toContain('I do');
		expect(roomCalls(fetchRef)).toHaveLength(0);
	});

	test('an unknown group is one unavailable state', async () => {
		const { wrapper, fetchRef } = await mountMessagesApp('/groups/999/chat');
		expect(textOf(wrapper)).toContain('This group chat isn’t available.');
		expect(wrapper.find('form').exists()).toBe(false);
		expect(roomCalls(fetchRef)).toHaveLength(0);
	});

	test('a non-numeric or zero group is not a route', async () => {
		const { router } = await mountMessagesApp('/groups/301/chat');
		await router.push('/groups/0/chat');
		expect(router.currentRoute.value.name).toBe('not-found');
		await router.push('/groups/abc/chat');
		expect(router.currentRoute.value.name).toBe('not-found');
	});

	test('the group page offers the room to members only', async () => {
		const member = await mountMessagesApp('/groups/301');
		expect(member.wrapper.find('.group-nav a[href="/groups/301/chat"]').exists()).toBe(true);
		cleanupMounted();
		const outsider = await mountMessagesApp('/groups/301', { viewerId: 99 });
		expect(outsider.wrapper.find('a[href="/groups/301/chat"]').exists()).toBe(false);
	});

	test('a failed read shows a retry and nothing from the room until it is confirmed', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'GET', path: /\/groups\/301\/messages$/u, repeat: true });
		const { wrapper } = await mountMessagesApp(ROOM, { backend });
		expect(textOf(wrapper)).toContain('We can’t open this group chat right now.');
		expect(wrapper.find('.message-list').exists()).toBe(false);
		expect(wrapper.find('form').exists()).toBe(false);
		backend.faults.length = 0;
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Try again')
			.trigger('click');
		await settle();
		expect(messageIds(wrapper)).toEqual([801, 802, 803]);
	});

	test('author names stay names: no profile links, and an inactive author is unavailable', async () => {
		const backend = new ChatBackend();
		backend.users.get(10).active = false;
		const { wrapper } = await mountMessagesApp(ROOM, { backend });
		expect(authors(wrapper)).toEqual(['Ada Lovelace', 'You', 'Unavailable account']);
		expect(wrapper.find('.message-list a').exists()).toBe(false);
		expect(wrapper.find('.message-list img').exists()).toBe(false);
	});
});

describe('SN-A20 history', () => {
	test('shows the newest messages and pages older history without gaps or duplicates', async () => {
		const backend = new ChatBackend();
		seedRoom(backend, 40);
		const { wrapper, fetchRef } = await mountMessagesApp(ROOM, { backend });
		const earlier = () =>
			wrapper.findAll('button').find((item) => item.text() === 'Load earlier messages');
		expect(messageIds(wrapper)).toHaveLength(30);
		expect(messageIds(wrapper).at(-1)).toBe(843);
		await earlier().trigger('click');
		await settle();
		const ids = messageIds(wrapper);
		expect(ids).toHaveLength(43);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(43);
		expect(earlier()).toBeUndefined();
		expect(textOf(wrapper)).toContain('This is the start of the conversation.');
		const pages = roomCalls(fetchRef, { method: 'GET' }).map((call) => call.url);
		expect(pages.some((url) => url.includes('before_id='))).toBe(true);
	});

	test('a failed earlier-history request says so and can be retried', async () => {
		const backend = new ChatBackend();
		seedRoom(backend, 40);
		const { wrapper } = await mountMessagesApp(ROOM, { backend });
		backend.faults.push({ method: 'GET', path: /\/groups\/301\/messages$/u });
		const earlier = () =>
			wrapper.findAll('button').find((item) => item.text() === 'Load earlier messages');
		await earlier().trigger('click');
		await settle();
		expect(wrapper.get('.message-thread__older .field-error').text()).toContain(
			'couldn’t load earlier messages',
		);
		expect(messageIds(wrapper)).toHaveLength(30);
		await earlier().trigger('click');
		await settle();
		expect(messageIds(wrapper)).toHaveLength(43);
	});
});

describe('SN-A20 reading', () => {
	test('opening the room marks it read after it renders, once, under the viewer’s membership', async () => {
		const backend = new ChatBackend();
		seedRoom(backend, 2, { senders: [7, 42] });
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804, 805]);
		expect(readCalls(app.fetchRef)).toHaveLength(1);
		expect(readCalls(app.fetchRef)[0].url).toBe('/api/v1/groups/301/messages/read');
		expect(readCalls(app.fetchRef)[0].json).toEqual({ membership_id: 504, through_id: 805 });
		expect(backend.groupCursors.get(504)).toBe(805);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});

	test('a hidden page does not mark messages read until it becomes visible', async () => {
		let visibility = 'hidden';
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => visibility,
		});
		try {
			const backend = new ChatBackend();
			seedRoom(backend, 2, { senders: [7, 42] });
			const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
			expect(messageIds(app.wrapper)).toHaveLength(5);
			expect(readCalls(app.fetchRef)).toHaveLength(0);
			expect(indicator(app.wrapper).get('.message-badge').text()).toBe('2');
			visibility = 'visible';
			document.dispatchEvent(new Event('visibilitychange'));
			await settle();
			expect(readCalls(app.fetchRef)).toHaveLength(1);
			expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
		} finally {
			delete document.visibilityState;
		}
	});

	test('receiving, fetching and sending never mark anything read on their own', async () => {
		const backend = new ChatBackend();
		quietDms(backend);
		const app = await mountMessagesApp('/people', { backend });
		memberSends(app.backend, 7, 'ping');
		await deliverFrames(app);
		expect(readCalls(app.fetchRef)).toHaveLength(0);
		expect(app.backend.groupCursors.get(501)).toBe(803);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('1');
	});

	test('the viewer’s own messages never count as unread or trigger a read', async () => {
		const backend = new ChatBackend();
		quietDms(backend);
		const app = await mountMessagesApp(ROOM, { backend });
		await submit(app.wrapper, 'mine');
		await settle();
		expect(readCalls(app.fetchRef)).toHaveLength(0);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});

	test('a message from another member while the room is open is read once it renders', async () => {
		const backend = new ChatBackend();
		quietDms(backend);
		const app = await mountMessagesApp(ROOM, { backend });
		memberSends(app.backend, 7, 'Evening all');
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
		expect(readCalls(app.fetchRef)).toHaveLength(1);
		expect(readCalls(app.fetchRef)[0].json).toEqual({ membership_id: 501, through_id: 804 });
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});
});

describe('SN-A20 sending', () => {
	test('sends once with the membership and a v4 nonce, merges the response and the echo, and clears the draft', async () => {
		const app = await mountMessagesApp(ROOM);
		await submit(app.wrapper, 'See you Friday 👋');
		await settle();
		const posts = sendCalls(app.fetchRef);
		expect(posts).toHaveLength(1);
		expect(posts[0].url).toBe('/api/v1/groups/301/messages');
		expect(Object.keys(posts[0].json).sort()).toEqual(['body', 'client_id', 'membership_id']);
		expect(posts[0].json.membership_id).toBe(501);
		expect(posts[0].json.body).toBe('See you Friday 👋');
		expect(posts[0].json.client_id).toMatch(V4);
		expect(posts[0].headers['X-Requested-With']).toBe('XMLHttpRequest');
		// The response and the socket echo are one message, in ID order.
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
		expect(bodies(app.wrapper).at(-1)).toBe('See you Friday 👋');
		expect(authors(app.wrapper).at(-1)).toBe('You');
		expect(pending(app.wrapper)).toHaveLength(0);
		expect(app.wrapper.get('#message-body').element.value).toBe('');
		expect(document.activeElement).toBe(app.wrapper.get('#message-body').element);
		expect(app.backend.groupMessages.size).toBe(4);
		expect(app.backend.groupMessages.get(804).membership_id).toBe(501);
	});

	test('Enter sends and Shift+Enter adds a line; the Send button sends too', async () => {
		const app = await mountMessagesApp(ROOM);
		const field = await type(app.wrapper, 'line one');
		await field.trigger('keydown.enter', { shiftKey: true });
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
		await app.wrapper.get('.message-composer__send').trigger('click');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		await type(app.wrapper, 'second');
		await app.wrapper.get('form').trigger('submit');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(2);
	});

	test('an empty or whitespace-only message is never sent', async () => {
		const app = await mountMessagesApp(ROOM);
		expect(app.wrapper.get('.message-composer__send').attributes('disabled')).toBeDefined();
		await submit(app.wrapper, '   \n  ');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
	});

	test('emoji count as one code point each: 2,000 are sent, 2,001 are refused before any request', async () => {
		const app = await mountMessagesApp(ROOM);
		await type(app.wrapper, '😀'.repeat(2001));
		expect(app.wrapper.get('.field-error').text()).toContain('up to 2,000 characters');
		expect(app.wrapper.get('.message-composer__send').attributes('disabled')).toBeDefined();
		await app.wrapper.get('#message-body').trigger('keydown.enter');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
		await submit(app.wrapper, '😀'.repeat(2000));
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		expect([...app.backend.groupMessages.get(804).body]).toHaveLength(2000);
	});

	test('hidden control characters are refused with a message before any request', async () => {
		const app = await mountMessagesApp(ROOM);
		await submit(app.wrapper, 'a\u0007b');
		await settle();
		expect(app.wrapper.get('.field-error').text()).toContain('hidden control characters');
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
	});

	test('the emoji picker inserts Unicode at the cursor and the room carries it as plain text', async () => {
		const app = await mountMessagesApp(ROOM);
		const field = await type(app.wrapper, 'ab');
		field.element.setSelectionRange(1, 1);
		await app.wrapper.get('.emoji-picker__toggle').trigger('click');
		await settle();
		await app.wrapper.get('[aria-label="Thumbs up"]').trigger('click');
		await settle();
		expect(app.wrapper.get('#message-body').element.value).toBe('a👍b');
		await app.wrapper.get('#message-body').trigger('keydown.enter');
		await settle();
		expect(bodies(app.wrapper).at(-1)).toBe('a👍b');
	});

	test('rapid sends are committed and shown in the order they were written', async () => {
		const app = await mountMessagesApp(ROOM);
		for (const text of ['first', 'second', 'third', 'fourth']) {
			await type(app.wrapper, text);
			await app.wrapper.get('#message-body').trigger('keydown.enter');
		}
		await settle();
		await new Promise((resolve) => setTimeout(resolve, 80));
		await settle();
		const posts = sendCalls(app.fetchRef);
		expect(posts.map((call) => call.json.body)).toEqual(['first', 'second', 'third', 'fourth']);
		expect(new Set(posts.map((call) => call.json.client_id)).size).toBe(4);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804, 805, 806, 807]);
		expect(bodies(app.wrapper).slice(-4)).toEqual(['first', 'second', 'third', 'fourth']);
		expect(pending(app.wrapper)).toHaveLength(0);
	});

	test('a message in flight is listed as sending and is not committed until the server replies', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp(ROOM, {
			before: async (entry) => {
				if (hold && entry.method === 'POST') await gate.promise;
			},
		});
		hold = true;
		await submit(app.wrapper, 'in flight');
		await settle();
		expect(pending(app.wrapper)).toHaveLength(1);
		expect(app.wrapper.get('.message--pending').attributes('data-status')).toBe('sending');
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		gate.release();
		await settle();
		expect(pending(app.wrapper)).toHaveLength(0);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
	});

	test('a lost response keeps the nonce and the membership: a retry never duplicates', async () => {
		const dropEcho = (backend) => () => {
			backend.signals = [];
		};
		// Stored, but neither the response nor the echo arrived.
		const stored = new ChatBackend();
		stored.faults.push({ method: 'POST', path: /\/messages$/u, commit: true });
		const first = await mountMessagesApp(ROOM, { backend: stored, after: dropEcho(stored) });
		await submit(first.wrapper, 'maybe sent');
		await settle();
		expect(first.wrapper.get('.message--failed .message__state').text()).toContain(
			'couldn’t confirm',
		);
		expect(stored.groupMessages.size).toBe(4);
		await first.wrapper
			.get('.message--failed')
			.findAll('button')
			.find((item) => item.text() === 'Retry')
			.trigger('click');
		await settle();
		const replays = sendCalls(first.fetchRef);
		expect(replays).toHaveLength(2);
		expect(replays[1].json).toEqual(replays[0].json);
		expect(replays[1].json.membership_id).toBe(501);
		expect(bodies(first.wrapper).filter((text) => text === 'maybe sent')).toHaveLength(1);
		expect(pending(first.wrapper)).toHaveLength(0);
		expect(stored.groupMessages.size).toBe(4);
		cleanupMounted();

		// Never reached the server: failed, retryable, retried with the same nonce.
		const lost = new ChatBackend();
		lost.faults.push({ method: 'POST', path: /\/messages$/u });
		const second = await mountMessagesApp(ROOM, { backend: lost });
		await submit(second.wrapper, 'try again');
		await settle();
		expect(second.wrapper.get('.message--failed').attributes('data-status')).toBe('failed');
		expect(lost.groupMessages.size).toBe(3);
		await second.wrapper
			.get('.message--failed')
			.findAll('button')
			.find((item) => item.text() === 'Retry')
			.trigger('click');
		await settle();
		const posts = sendCalls(second.fetchRef);
		expect(posts).toHaveLength(2);
		expect(posts[1].json).toEqual(posts[0].json);
		expect(bodies(second.wrapper).filter((text) => text === 'try again')).toHaveLength(1);
		expect(pending(second.wrapper)).toHaveLength(0);
		expect(lost.groupMessages.size).toBe(4);
	});

	test('a stored message whose reply was lost appears on the next read without a retry', async () => {
		const quiet = new ChatBackend();
		quiet.faults.push({ method: 'POST', path: /\/messages$/u, commit: true });
		const app = await mountMessagesApp(ROOM, {
			backend: quiet,
			after: () => {
				quiet.signals = [];
			},
		});
		await submit(app.wrapper, 'found later');
		await settle();
		expect(pending(app.wrapper)).toHaveLength(1);
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(bodies(app.wrapper).filter((text) => text === 'found later')).toHaveLength(1);
		expect(pending(app.wrapper)).toHaveLength(0);
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
	});

	test('a failed message can be discarded and never comes back', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'POST', path: /\/messages$/u });
		const app = await mountMessagesApp(ROOM, { backend });
		await submit(app.wrapper, 'drop me');
		await settle();
		await app.wrapper
			.get('.message--failed')
			.findAll('button')
			.find((item) => item.text() === 'Discard')
			.trigger('click');
		await settle();
		expect(pending(app.wrapper)).toHaveLength(0);
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(textOf(app.wrapper)).not.toContain('drop me');
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
	});

	test('a retry nonce reused with different content is a conflict: not retried, discard only', async () => {
		const nonce = '33333333-3333-4333-8333-333333333333';
		vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(nonce);
		const backend = new ChatBackend();
		// The nonce was used before, in another room, for different text.
		backend.groupMessages.set(900, {
			id: 900,
			group_id: 302,
			sender_id: 42,
			membership_id: 999,
			body: 'something else',
			created_at: '2026-10-15T09:20:00Z',
			client_id: nonce,
		});
		const app = await mountMessagesApp(ROOM, { backend });
		await submit(app.wrapper, 'different words');
		await settle();
		const failed = app.wrapper.get('.message--failed');
		expect(failed.text()).toContain('already sent with different content');
		expect(failed.findAll('button').map((button) => button.text())).toEqual(['Discard']);
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		expect(backend.groupMessages.size).toBe(4);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
	});
});

describe('SN-A20 live delivery and recovery', () => {
	test('a message from another member arrives once, in order, and a repeated frame changes nothing', async () => {
		const app = await mountMessagesApp(ROOM);
		const reply = memberSends(app.backend, 10, 'Bring a clock too');
		expect(reply.status).toBe(201);
		await deliverFrames(app);
		expect(bodies(app.wrapper).at(-1)).toBe('Bring a clock too');
		expect(authors(app.wrapper).at(-1)).toBe('Lee Example');
		frame(app, { type: 'group.message', payload: reply.body.data });
		await settle();
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
	});

	test('a message from the viewer’s other tab arrives as theirs, is not unread and marks nothing', async () => {
		const backend = new ChatBackend();
		quietDms(backend);
		const app = await mountMessagesApp(ROOM, { backend });
		memberSends(backend, 42, 'typed on my phone');
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
		expect(authors(app.wrapper).at(-1)).toBe('You');
		expect(readCalls(app.fetchRef)).toHaveLength(0);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});

	test('switching to another room keeps messages and drafts apart', async () => {
		const backend = new ChatBackend();
		backend.memberships.set(506, {
			id: 506,
			group_id: 302,
			user_id: 42,
			role: 'member',
			joined_at: '2026-10-09T10:00:00Z',
		});
		backend.groupCursors.set(506, 0);
		backend.commitRoom(302, 99, { body: 'Monthly read: Middlemarch' });
		backend.signals = [];
		const app = await mountMessagesApp(ROOM, { backend });
		await type(app.wrapper, 'about chess');
		await app.router.push('/groups/302/chat');
		await settle();
		expect(app.wrapper.get('h1').text()).toBe('Book Club');
		expect(bodies(app.wrapper)).toEqual(['Monthly read: Middlemarch']);
		expect(app.wrapper.get('#message-body').element.value).toBe('');
		await submit(app.wrapper, 'about books');
		await settle();
		expect(sendCalls(app.fetchRef).at(-1).url).toBe('/api/v1/groups/302/messages');
		expect(sendCalls(app.fetchRef).at(-1).json.membership_id).toBe(506);
		await app.router.push(ROOM);
		await settle();
		expect(bodies(app.wrapper)).not.toContain('about books');
		expect(bodies(app.wrapper)).not.toContain('Monthly read: Middlemarch');
		expect(app.wrapper.get('#message-body').element.value).toBe('about chess');
	});

	test('two members talk: each sees the other’s messages in one shared order', async () => {
		const backend = new ChatBackend();
		const alex = await mountMessagesApp(ROOM, { backend });
		await submit(alex.wrapper, 'Who is in for Friday?');
		await settle();
		memberSends(backend, 7, 'I am!');
		await deliverFrames(alex);
		await submit(alex.wrapper, 'Great, see you');
		await settle();
		expect(bodies(alex.wrapper).slice(-3)).toEqual([
			'Who is in for Friday?',
			'I am!',
			'Great, see you',
		]);
		expect(messageIds(alex.wrapper)).toEqual([801, 802, 803, 804, 805, 806]);
		cleanupMounted();
		const ada = await mountMessagesApp(ROOM, { backend, viewerId: 7 });
		expect(bodies(ada.wrapper).slice(-3)).toEqual([
			'Who is in for Friday?',
			'I am!',
			'Great, see you',
		]);
		expect(authors(ada.wrapper).slice(-3)).toEqual(['Alex Example', 'You', 'Alex Example']);
		// Ada reads the room: she has two unread (Alex's), then none.
		expect(backend.roomUnread(7, 301)).toBe(0);
		expect(readCalls(ada.fetchRef)).toHaveLength(1);
		expect(readCalls(ada.fetchRef)[0].json).toEqual({ membership_id: 502, through_id: 806 });
	});

	test('a malformed or foreign frame is ignored', async () => {
		const app = await mountMessagesApp(ROOM);
		frame(app, { type: 'group.message', payload: { id: 1 } });
		frame(app, {
			type: 'group.message',
			payload: {
				id: 950,
				group_id: 302,
				sender_id: 99,
				sender_username: 'Robin Example',
				body: 'elsewhere',
				created_at: '2026-10-15T10:00:00Z',
				client_id: null,
			},
		});
		frame(app, {
			type: 'group.message',
			payload: {
				id: 951,
				group_id: 301,
				sender_id: 7,
				sender_username: 'Ada Lovelace',
				body: 'with a picture',
				image_url: '/api/v1/media/702',
				created_at: '2026-10-15T10:00:00Z',
				client_id: null,
			},
		});
		await settle();
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		expect(textOf(app.wrapper)).not.toContain('elsewhere');
		expect(textOf(app.wrapper)).not.toContain('with a picture');
	});

	test.each([
		35, 1235,
	])('after a reconnect all %i missed messages are recovered once and in order', async (missed) => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend });
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		// The socket is down: messages are committed and no frame arrives.
		seedRoom(backend, missed);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		await connect(app);
		const ids = messageIds(app.wrapper);
		expect(ids).toHaveLength(missed + 3);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(missed + 3);
		const urls = roomCalls(app.fetchRef, { method: 'GET' }).map((call) => call.url);
		expect(urls.some((url) => url.includes('before_id='))).toBe(true);
		expect(readCalls(app.fetchRef).at(-1).json).toEqual({
			membership_id: 501,
			through_id: ids.at(-1),
		});
	}, 30000);

	test('a live frame during the reconnect group read cannot advance the recovery boundary', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp(ROOM, {
			before: async (entry) => {
				if (hold && entry.method === 'GET' && entry.url === '/api/v1/groups/301')
					await gate.promise;
			},
		});
		seedRoom(app.backend, 35);
		hold = true;
		await connect(app);
		const reply = memberSends(app.backend, 7, 'live during recovery');
		frame(app, { type: 'group.message', payload: reply.body.data });
		await settle();
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 839]);
		hold = false;
		gate.release();
		await settle();
		const expected = Array.from({ length: 39 }, (_, index) => 801 + index);
		expect(messageIds(app.wrapper)).toEqual(expected);
		await app.social.refresh();
		await settle();
		expect(messageIds(app.wrapper)).toEqual(expected);
	});

	test('losing the connection says delivery is reconnecting and sending still works', async () => {
		const app = await mountMessagesApp(ROOM);
		expect(app.wrapper.find('.message-connection').exists()).toBe(false);
		app.sockets.at(-1).onclose();
		await settle();
		expect(app.wrapper.get('.message-connection').text()).toContain('reconnecting');
		await submit(app.wrapper, 'offline send');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		expect(bodies(app.wrapper).at(-1)).toBe('offline send');
	});

	test('another tab reading moves the cursor and the total from the server, never from the frame', async () => {
		const backend = new ChatBackend();
		seedRoom(backend, 2);
		const app = await mountMessagesApp('/people', { backend });
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('4');
		backend.groupCursors.set(501, 805);
		frame(app, {
			type: 'chat.read',
			payload: { kind: 'group', target_id: 301, through_id: 805, unread_count: 99 },
		});
		await settle();
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('2');
	});
});

describe('SN-A20 membership loss and return', () => {
	test.each([
		'/messages',
		'/people',
	])('membership ends while %s is open: drafts and failed sends are discarded before readmission', async (path) => {
		const app = await mountMessagesApp(ROOM, { viewerId: 10 });
		app.backend.faults.push({ method: 'POST', path: /\/groups\/301\/messages$/u });
		await submit(app.wrapper, 'failed under old membership');
		await settle();
		expect(app.messages.outbox('room-301')).toHaveLength(1);
		await type(app.wrapper, 'old draft');
		await app.router.push(path);
		await settle();
		// Ordinary navigation preserves a draft in the same membership.
		expect(app.messages.draft('room-301').body).toBe('old draft');
		app.backend.removeMember(301, 10);
		app.backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		expect(app.messages.draft('room-301')).toBeNull();
		expect(app.messages.outbox('room-301')).toEqual([]);
		app.backend.admit(301, 10, []);
		app.backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		await app.router.push(ROOM);
		await settle();
		expect(app.wrapper.get('#message-body').element.value).toBe('');
		expect(pending(app.wrapper)).toHaveLength(0);
	});

	test('a removal and readmission missed off-room still discards the old membership draft', async () => {
		const app = await mountMessagesApp(ROOM, { viewerId: 10 });
		await type(app.wrapper, 'old generation');
		await app.router.push('/messages');
		await settle();
		app.backend.removeMember(301, 10);
		app.backend.admit(301, 10, []);
		app.backend.signals = [];
		// No intervening non-member response, even when reopening directly.
		await app.router.push(ROOM);
		await settle();
		expect(app.wrapper.get('#message-body').element.value).toBe('');
		expect(pending(app.wrapper)).toHaveLength(0);
	});

	test('a changed membership off-room clears in-flight and queued sends and ignores a late reply', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp(ROOM, {
			viewerId: 10,
			after: async (entry) => {
				if (hold && entry.method === 'POST' && /\/groups\/301\/messages$/u.test(entry.url)) {
					app.backend.signals = [];
					await gate.promise;
				}
			},
		});
		await app.router.push('/people');
		await settle();
		hold = true;
		for (const body of ['committed but reply delayed', 'queued under old membership']) {
			app.messages.setBody('room-301', body);
			app.messages.sendRoom(301, 504);
		}
		app.messages.setBody('room-301', 'old draft');
		await settle();
		expect(app.messages.outbox('room-301')).toHaveLength(2);
		app.backend.removeMember(301, 10);
		app.backend.admit(301, 10, []);
		app.backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		expect(app.messages.draft('room-301')).toBeNull();
		expect(app.messages.outbox('room-301')).toEqual([]);
		const events = [];
		const unsubscribe = app.messages.subscribe((event) => events.push(event));
		gate.release();
		await settle();
		unsubscribe();
		expect(events.filter((event) => event.type === 'group-message')).toEqual([]);
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		expect(app.messages.outbox('room-301')).toEqual([]);
		await app.router.push(ROOM);
		await settle();
		expect(app.wrapper.get('#message-body').element.value).toBe('');
		expect(bodies(app.wrapper)).toContain('committed but reply delayed');
		expect(bodies(app.wrapper)).not.toContain('queued under old membership');
	});

	test('removal during an open room clears the room, composer, draft and cached messages', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		await type(app.wrapper, 'half-written thought');
		expect(app.messages.draft('room-301').body).toBe('half-written thought');
		const before = app.fetchRef.calls.length;
		backend.removeMember(301, 10);
		backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		expect(textOf(app.wrapper)).toContain('Only members of Chess Club can chat here.');
		expect(app.wrapper.find('form').exists()).toBe(false);
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
		for (const text of ['half-written thought', 'I do', 'Welcome to the club.'])
			expect(textOf(app.wrapper)).not.toContain(text);
		expect(app.messages.draft('room-301')).toBeNull();
		expect(app.messages.outbox('room-301')).toEqual([]);
		// After the removal the room's history is never requested again.
		const later = app.fetchRef.calls
			.slice(before)
			.filter((call) => /groups\/301\/messages/u.test(call.url));
		expect(later).toEqual([]);
		expect(backend.groupMessages.size).toBe(3);
	});

	test('a send after removal is refused: no false success, the room clears', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		// The removal has committed, but the signal has not reached this page yet.
		backend.removeMember(301, 10);
		backend.signals = [];
		await submit(app.wrapper, 'too late');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		expect(backend.groupMessages.size).toBe(3);
		expect(textOf(app.wrapper)).not.toContain('too late');
		expect(textOf(app.wrapper)).toContain('Only members of Chess Club can chat here.');
		expect(app.wrapper.find('form').exists()).toBe(false);
		expect(app.messages.outbox('room-301')).toEqual([]);
	});

	test('readmission shows a fresh room under the new membership', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		backend.removeMember(301, 10);
		backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		expect(app.wrapper.find('form').exists()).toBe(false);
		// Someone writes while Lee is away; Lee returns.
		memberSends(backend, 7, 'while you were away');
		backend.signals = [];
		const membership = backend.admit(301, 10, []);
		expect(membership.id).toBe(505);
		backend.signal('social.invalidate', [10]);
		await deliverFrames(app);
		// The whole room is readable; nothing earlier counts as unread.
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
		// A confirmed non-member who joins has nothing discarded to explain.
		expect(app.wrapper.find('[data-testid="room-notice"]').exists()).toBe(false);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
		expect(readCalls(app.fetchRef)).toHaveLength(0);
		await submit(app.wrapper, 'back again');
		await settle();
		const posts = sendCalls(app.fetchRef);
		expect(posts).toHaveLength(1);
		expect(posts[0].json.membership_id).toBe(505);
		expect(bodies(app.wrapper).at(-1)).toBe('back again');
	});

	test('a membership that changed unnoticed is a stale write: refused once, never re-sent under the new one', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		backend.removeMember(301, 10);
		backend.admit(301, 10, []);
		backend.signals = [];
		await submit(app.wrapper, 'written under the old membership');
		await settle();
		const posts = sendCalls(app.fetchRef);
		expect(posts).toHaveLength(1);
		expect(posts[0].json.membership_id).toBe(504);
		expect(backend.groupMessages.size).toBe(3);
		// The room re-read what Lee may see now: a fresh view with a note, and
		// nothing from the old membership.
		expect(app.wrapper.get('[data-testid="room-notice"]').text()).toContain('fresh view');
		expect(textOf(app.wrapper)).not.toContain('written under the old membership');
		expect(app.messages.outbox('room-301')).toEqual([]);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		await submit(app.wrapper, 'written afresh');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(2);
		expect(sendCalls(app.fetchRef)[1].json.membership_id).toBe(505);
		expect(backend.groupMessages.size).toBe(4);
	});

	test('an unread mark under an old membership is refused; the fresh room is read under the new one', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 10 });
		backend.removeMember(301, 10);
		backend.admit(301, 10, []);
		backend.signals = [];
		// Ada writes; Lee's page receives the frame and tries to mark it read.
		memberSends(backend, 7, 'ping');
		await deliverFrames(app);
		const marks = readCalls(app.fetchRef).map((call) => call.json.membership_id);
		expect(marks[0]).toBe(504);
		expect(backend.groupCursors.get(504)).toBeUndefined();
		// The refused mark re-read the room; the fresh view marks under 505.
		expect(marks.at(-1)).toBe(505);
		expect(marks.filter((id) => id === 504)).toHaveLength(1);
		expect(backend.groupCursors.get(505)).toBe(804);
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803, 804]);
	});

	test('the room disappears from the page when the whole group goes away for the viewer', async () => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp(ROOM, { backend, viewerId: 7 });
		expect(messageIds(app.wrapper)).toEqual([801, 802, 803]);
		backend.removeMember(301, 7);
		backend.signal('social.invalidate', [7]);
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([]);
		// Back navigation does not bring the cached room back.
		await app.router.push('/groups/301');
		await settle();
		await app.router.back();
		await settle();
		expect(textOf(app.wrapper)).toContain('Only members of Chess Club can chat here.');
		expect(textOf(app.wrapper)).not.toContain('Welcome to the club.');
	});
});
