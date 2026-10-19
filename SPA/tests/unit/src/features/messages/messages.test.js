// @vitest-environment jsdom
// SN-A19: private messages against the stateful SN-B20 model (itself proved
// against the approved pack by chat-model.test.js): roster, conversation,
// sending and retrying, live frames, presence, images and account changes.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatBackend } from '../../../../fixtures/phase5/chat-backend.js';
import {
	chatCalls,
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
	vi.useRealTimers();
});

// Viewer 42 is Alex. Conversations: Lee (10, two unread, follows Alex), Ada
// (7, private, Alex follows her, image in the history) and Kim (11, no
// history, offline). Sam (8, pending), Pat (9) and Robin (99) are strangers.
const rosterIds = (wrapper) =>
	wrapper.findAll('.roster-row').map((row) => Number(row.attributes('data-user-id')));
const messageIds = (wrapper) =>
	wrapper
		.findAll('.message[data-message-id]')
		.map((item) => Number(item.attributes('data-message-id')));
const bodies = (wrapper) => wrapper.findAll('.message__body').map((item) => item.text());
const indicator = (wrapper) => wrapper.get('[data-testid="message-indicator"]');
const send = (wrapper) => wrapper.get('.message-composer__send');
const pending = (wrapper) => wrapper.findAll('.message--pending');
const sendCalls = (fetchRef) => chatCalls(fetchRef, { method: 'POST', path: /\/messages$/u });
const readCalls = (fetchRef) => chatCalls(fetchRef, { method: 'PUT' });
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function submit(wrapper, text) {
	const field = await type(wrapper, text);
	await field.trigger('keydown.enter');
}

function seed(backend, count, { from = 10, to = 42 } = {}) {
	for (let index = 1; index <= count; index += 1) {
		backend.commit(index % 2 ? from : to, index % 2 ? to : from, { body: `message ${index}` });
	}
	backend.signals = [];
	backend.dmCursors.set(`${to}:${from}`, backend.dms.size + 600);
}

describe('SN-A19 roster and the message indicator', () => {
	test('lists conversations and people the viewer may message, never strangers', async () => {
		const { wrapper } = await mountMessagesApp('/messages');
		expect(rosterIds(wrapper)).toEqual([10, 7, 11]);
		const lee = wrapper.get('[data-user-id="10"]');
		expect(lee.text()).toContain('Lee Example');
		expect(lee.text()).toContain('Bring the clock.');
		expect(lee.get('.message-unread').text()).toBe('2');
		expect(lee.get('.message-unread').attributes('aria-label')).toBe('2 unread messages');
		const ada = wrapper.get('[data-user-id="7"]');
		expect(ada.text()).toContain('You: Yes. Here is the board.');
		expect(ada.find('.message-unread').exists()).toBe(false);
		const kim = wrapper.get('[data-user-id="11"]');
		expect(kim.text()).toContain('No messages yet. Say hello.');
		const page = textOf(wrapper);
		for (const stranger of ['Sam Example', 'Pat Example', 'Robin Example', 'Quinn Example'])
			expect(page).not.toContain(stranger);
		expect(wrapper.get('.social-status').text()).toBe('3 conversations');
		expect(lee.get('a').attributes('href')).toBe('/messages/10');
	});

	test('the indicator shows the unread total on every page and never mentions notifications', async () => {
		const { wrapper, router } = await mountMessagesApp('/people');
		expect(indicator(wrapper).attributes('aria-label')).toBe('Messages, 2 unread messages');
		expect(indicator(wrapper).get('.message-badge').text()).toBe('2');
		expect(indicator(wrapper).attributes('href')).toBe('/messages');
		await router.push('/groups');
		await settle();
		expect(indicator(wrapper).get('.message-badge').text()).toBe('2');
		expect(indicator(wrapper).text()).not.toMatch(/notif/iu);
	});

	test('message and notification badges are separate controls with separate counts', async () => {
		const app = await mountMessagesApp('/messages');
		const trigger = () => app.wrapper.get('.notification-trigger');
		const notices = trigger().get('.notification-badge').text();
		expect(indicator(app.wrapper).element).not.toBe(trigger().element);
		expect(indicator(app.wrapper).classes()).not.toContain('notification-trigger');
		// A new message moves only the message indicator.
		app.backend.commit(10, 42, { body: 'one more' });
		await deliverFrames(app);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('3');
		expect(trigger().get('.notification-badge').text()).toBe(notices);
		// Reading every notice moves only the notification badge.
		await app.notifications.markRead();
		await settle();
		expect(trigger().get('.notification-badge').text()).toBe('0');
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('3');
	});

	test('a viewer with no relationships sees an honest empty roster and a zero indicator', async () => {
		const { wrapper } = await mountMessagesApp('/messages', { viewerId: 99 });
		expect(textOf(wrapper)).toContain('No conversations yet.');
		expect(wrapper.find('.roster-list').exists()).toBe(false);
		expect(indicator(wrapper).get('.message-badge').classes()).toContain('message-badge--zero');
		expect(indicator(wrapper).attributes('aria-label')).toBe('Messages, 0 unread messages');
	});

	test('an outage shows a retry and no stale roster; an unknown count is shown as unknown', async () => {
		const backend = new ChatBackend();
		backend.faults.push(
			{ method: 'GET', path: /\/chats$/u, repeat: true },
			{ method: 'GET', path: /\/chats\/unread$/u, repeat: true },
		);
		const { wrapper } = await mountMessagesApp('/messages', { backend });
		expect(textOf(wrapper)).toContain('We can’t load your messages right now.');
		expect(wrapper.find('.roster-list').exists()).toBe(false);
		expect(indicator(wrapper).attributes('aria-label')).toBe('Messages, unread count unavailable');
		backend.faults.length = 0;
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Try again')
			.trigger('click');
		await settle();
		expect(rosterIds(wrapper)).toEqual([10, 7, 11]);
	});

	test('presence is shown only where the profile is visible and follows live frames', async () => {
		const backend = new ChatBackend({
			// Ada is private and Alex does not follow her; she follows Alex.
			given: {
				follows: { 72: null, 76: { id: 76, follower_id: 7, followed_id: 42, state: 'accepted' } },
			},
		});
		const app = await mountMessagesApp('/messages', { backend });
		const presence = (id) => app.wrapper.get(`[data-user-id="${id}"] .presence`);
		expect(presence(10).attributes('data-online')).toBe('true');
		expect(presence(10).text()).toBe('Online');
		expect(presence(11).text()).toBe('Offline');
		// Ada's profile is hidden from Alex, so no presence is shown at all.
		expect(app.wrapper.find('[data-user-id="7"] .presence').exists()).toBe(false);
		frame(app, { type: 'presence.update', payload: { user_id: 10, is_online: false } });
		await settle();
		expect(presence(10).text()).toBe('Offline');
		frame(app, {
			type: 'presence.snapshot',
			payload: { users: [{ user_id: 11, is_online: true }] },
		});
		await settle();
		expect(presence(11).text()).toBe('Online');
		expect(presence(10).text()).toBe('Offline');
		// A frame about someone hidden never creates an indicator.
		frame(app, { type: 'presence.update', payload: { user_id: 7, is_online: true } });
		await settle();
		expect(app.wrapper.find('[data-user-id="7"] .presence').exists()).toBe(false);
	});
});

describe('SN-A19 conversation access', () => {
	test.each([
		[9, 'a stranger'],
		[8, 'a pending requester'],
		[42, 'the viewer'],
		[999, 'a missing account'],
	])('%i (%s) is one unavailable state with no composer, history or name', async (id) => {
		const { wrapper, fetchRef } = await mountMessagesApp(`/messages/${id}`);
		expect(textOf(wrapper)).toContain('This conversation isn’t available.');
		expect(wrapper.find('form').exists()).toBe(false);
		expect(wrapper.find('.message-list').exists()).toBe(false);
		for (const name of ['Pat Example', 'Sam Example', 'Robin Example'])
			expect(textOf(wrapper)).not.toContain(name);
		expect(sendCalls(fetchRef)).toHaveLength(0);
		expect(chatCalls(fetchRef, { path: /\/media\//u })).toHaveLength(0);
	});

	test('a non-numeric or zero route is not a conversation', async () => {
		const { router } = await mountMessagesApp('/messages');
		await router.push('/messages/0');
		expect(router.currentRoute.value.name).toBe('not-found');
		await router.push('/messages/abc');
		expect(router.currentRoute.value.name).toBe('not-found');
	});

	test('opens a conversation in message order with the partner’s private image', async () => {
		const app = await mountMessagesApp('/messages/7');
		const { wrapper } = app;
		expect(wrapper.get('h1').text()).toBe('Ada Lovelace');
		expect(messageIds(wrapper)).toEqual([501, 502]);
		expect(bodies(wrapper)).toEqual([
			'Morning! Did you see the new rules?',
			'Yes. Here is the board.',
		]);
		const names = wrapper.findAll('.message__who').map((item) => item.text());
		expect(names).toEqual(['Ada Lovelace', 'You']);
		expect(wrapper.get('.conversation-head .presence').text()).toBe('Online');
		// The private image is read with the session and shown from a local URL.
		const image = wrapper.get('.message[data-message-id="502"] img');
		expect(image.attributes('src')).toBe('blob:test/1');
		expect(image.attributes('alt')).toContain('Ada Lovelace');
		expect(chatCalls(app.fetchRef, { path: /\/media\/702$/u })).toHaveLength(0);
		expect(app.fetchRef.calls.filter((call) => call.url === '/api/v1/media/702')).toHaveLength(1);
		expect(send(wrapper).attributes('disabled')).toBeDefined();
	});

	test('a missing image is a quiet placeholder, not a broken picture', async () => {
		const backend = new ChatBackend();
		backend.media.delete(702);
		const { wrapper } = await mountMessagesApp('/messages/7', { backend });
		expect(wrapper.get('.message[data-message-id="502"]').text()).toContain('Image unavailable');
		expect(wrapper.find('.message img').exists()).toBe(false);
	});

	test('a conversation outage shows a retry and no stale messages', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'GET', path: /\/chats\/10\/messages$/u, repeat: true });
		const { wrapper } = await mountMessagesApp('/messages/10', { backend });
		expect(textOf(wrapper)).toContain('We can’t open this conversation right now.');
		expect(wrapper.find('.message-list').exists()).toBe(false);
		expect(wrapper.find('form').exists()).toBe(false);
		backend.faults.length = 0;
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Try again')
			.trigger('click');
		await settle();
		expect(messageIds(wrapper)).toEqual([503, 504]);
	});

	test('a message without a partner profile link still shows the profile entry point', async () => {
		const accepted = await mountMessagesApp('/users/7');
		expect(accepted.wrapper.find('a[href="/messages/7"]').exists()).toBe(true);
		cleanupMounted();
		const none = await mountMessagesApp('/users/10');
		expect(none.wrapper.find('a[href="/messages/10"]').exists()).toBe(false);
	});
});

describe('SN-A19 reading', () => {
	test('opening a conversation marks it read after it renders, once, with the largest ID', async () => {
		const app = await mountMessagesApp('/messages/10');
		expect(messageIds(app.wrapper)).toEqual([503, 504]);
		expect(readCalls(app.fetchRef)).toHaveLength(1);
		expect(readCalls(app.fetchRef)[0].url).toBe('/api/v1/chats/10/read');
		expect(readCalls(app.fetchRef)[0].json).toEqual({ through_id: 504 });
		expect(app.backend.cursor(42, 10)).toBe(504);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});

	test('a hidden page does not mark messages read until it becomes visible', async () => {
		let visibility = 'hidden';
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => visibility,
		});
		try {
			const app = await mountMessagesApp('/messages/10');
			expect(messageIds(app.wrapper)).toEqual([503, 504]);
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

	test('fetching, receiving and sending never mark anything read on their own', async () => {
		const app = await mountMessagesApp('/messages');
		expect(readCalls(app.fetchRef)).toHaveLength(0);
		expect(app.backend.cursor(42, 10)).toBe(0);
		app.backend.commit(10, 42, { body: 'ping' });
		await deliverFrames(app);
		expect(readCalls(app.fetchRef)).toHaveLength(0);
		expect(app.wrapper.get('[data-user-id="10"] .message-unread').text()).toBe('3');
	});

	test('the unread total is the server’s: frames refetch it instead of adding to it', async () => {
		const app = await mountMessagesApp('/people');
		app.backend.commit(10, 42, { body: 'a' });
		app.backend.commit(10, 42, { body: 'b' });
		await deliverFrames(app);
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('4');
		// Another tab reads: a read frame carries no count the page trusts blindly.
		app.backend.dmCursors.set('42:10', 999);
		frame(app, {
			type: 'chat.read',
			payload: { kind: 'dm', target_id: 10, through_id: 999, unread_count: 0 },
		});
		await settle();
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
		// Malformed or foreign frames change nothing.
		frame(app, {
			type: 'chat.read',
			payload: { kind: 'group', target_id: 10, through_id: 1, unread_count: 7 },
		});
		frame(app, { type: 'dm.message', payload: { id: 1 } });
		await settle();
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});
});

describe('SN-A19 sending', () => {
	test('sends once with a v4 nonce, merges the response and the echo, and clears the draft', async () => {
		const app = await mountMessagesApp('/messages/10');
		await submit(app.wrapper, 'See you Friday 👋');
		await settle();
		const posts = sendCalls(app.fetchRef);
		expect(posts).toHaveLength(1);
		expect(posts[0].url).toBe('/api/v1/chats/10/messages');
		expect(posts[0].json.body).toBe('See you Friday 👋');
		expect(posts[0].json.client_id).toMatch(V4);
		expect(Object.keys(posts[0].json).sort()).toEqual(['body', 'client_id']);
		expect(posts[0].headers['X-Requested-With']).toBe('XMLHttpRequest');
		// Response and socket echo are one message, in ID order, with nothing pending.
		expect(messageIds(app.wrapper)).toEqual([503, 504, 505]);
		expect(bodies(app.wrapper).at(-1)).toBe('See you Friday 👋');
		expect(pending(app.wrapper)).toHaveLength(0);
		expect(app.wrapper.get('#message-body').element.value).toBe('');
		expect(document.activeElement).toBe(app.wrapper.get('#message-body').element);
		expect(app.backend.dms.size).toBe(5);
	});

	test('the message box sends on Enter, keeps Shift+Enter for a new line and ignores empty input', async () => {
		const app = await mountMessagesApp('/messages/10');
		const field = await type(app.wrapper, 'line one');
		await field.trigger('keydown.enter', { shiftKey: true });
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
		await type(app.wrapper, '   \n  ');
		expect(send(app.wrapper).attributes('disabled')).toBeDefined();
		await app.wrapper.get('#message-body').trigger('keydown.enter');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
		await type(app.wrapper, 'hello');
		await send(app.wrapper).trigger('click');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
	});

	test('rapid sends go out one at a time, in order, with no duplicates or reordering', async () => {
		let active = 0;
		let peak = 0;
		const app = await mountMessagesApp('/messages/10', {
			before: async (entry) => {
				if (entry.method !== 'POST') return;
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
			after: (entry) => {
				if (entry.method === 'POST') active -= 1;
			},
		});
		for (const text of ['first', 'second', 'third', 'fourth']) await submit(app.wrapper, text);
		expect(pending(app.wrapper).length).toBeGreaterThan(0);
		await settle();
		await new Promise((resolve) => setTimeout(resolve, 80));
		await settle();
		expect(peak).toBe(1);
		const posts = sendCalls(app.fetchRef);
		expect(posts.map((call) => call.json.body)).toEqual(['first', 'second', 'third', 'fourth']);
		expect(new Set(posts.map((call) => call.json.client_id)).size).toBe(4);
		expect(messageIds(app.wrapper)).toEqual([503, 504, 505, 506, 507, 508]);
		expect(bodies(app.wrapper).slice(-4)).toEqual(['first', 'second', 'third', 'fourth']);
		expect(pending(app.wrapper)).toHaveLength(0);
	});

	test('a lost response keeps the nonce: a retry never duplicates, whether or not it was stored', async () => {
		const dropEcho = (backend) => () => {
			backend.signals = [];
		};
		// Stored, but neither the response nor the echo arrived: the retry
		// returns the original message instead of a second one.
		const stored = new ChatBackend();
		stored.faults.push({ method: 'POST', path: /\/messages$/u, commit: true });
		const first = await mountMessagesApp('/messages/10', {
			backend: stored,
			after: dropEcho(stored),
		});
		await submit(first.wrapper, 'maybe sent');
		await settle();
		expect(first.wrapper.get('.message--failed .message__state').text()).toContain(
			'couldn’t confirm',
		);
		expect(stored.dms.size).toBe(5);
		await first.wrapper
			.get('.message--failed')
			.findAll('button')
			.find((item) => item.text() === 'Retry')
			.trigger('click');
		await settle();
		const replays = sendCalls(first.fetchRef);
		expect(replays).toHaveLength(2);
		expect(replays[1].json).toEqual(replays[0].json);
		expect(bodies(first.wrapper).filter((text) => text === 'maybe sent')).toHaveLength(1);
		expect(pending(first.wrapper)).toHaveLength(0);
		expect(stored.dms.size).toBe(5);
		cleanupMounted();

		// Stored and the echo arrived: the message simply appears, nothing to retry.
		const echoed = new ChatBackend();
		echoed.faults.push({ method: 'POST', path: /\/messages$/u, commit: true });
		const second = await mountMessagesApp('/messages/10', { backend: echoed });
		await submit(second.wrapper, 'echoed');
		await settle();
		expect(bodies(second.wrapper).filter((text) => text === 'echoed')).toHaveLength(1);
		expect(pending(second.wrapper)).toHaveLength(0);
		cleanupMounted();

		// Stored, nothing arrived, and no retry: a later refetch shows it.
		const quiet = new ChatBackend();
		quiet.faults.push({ method: 'POST', path: /\/messages$/u, commit: true });
		const third = await mountMessagesApp('/messages/10', {
			backend: quiet,
			after: dropEcho(quiet),
		});
		await submit(third.wrapper, 'found later');
		await settle();
		expect(pending(third.wrapper)).toHaveLength(1);
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(bodies(third.wrapper).filter((text) => text === 'found later')).toHaveLength(1);
		expect(pending(third.wrapper)).toHaveLength(0);
		cleanupMounted();

		// Never reached the server: failed, retryable, and retried with the same nonce.
		const lost = new ChatBackend();
		lost.faults.push({ method: 'POST', path: /\/messages$/u });
		const fourth = await mountMessagesApp('/messages/10', { backend: lost });
		await submit(fourth.wrapper, 'try again');
		await settle();
		const failed = fourth.wrapper.get('.message--failed');
		expect(failed.attributes('data-status')).toBe('failed');
		expect(lost.dms.size).toBe(4);
		await failed
			.findAll('button')
			.find((item) => item.text() === 'Retry')
			.trigger('click');
		await settle();
		const posts = sendCalls(fourth.fetchRef);
		expect(posts).toHaveLength(2);
		expect(posts[1].json).toEqual(posts[0].json);
		expect(bodies(fourth.wrapper).filter((text) => text === 'try again')).toHaveLength(1);
		expect(pending(fourth.wrapper)).toHaveLength(0);
		expect(lost.dms.size).toBe(5);
	});

	test('a failed message can be discarded and never comes back', async () => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'POST', path: /\/messages$/u });
		const app = await mountMessagesApp('/messages/10', { backend });
		await submit(app.wrapper, 'drop me');
		await settle();
		await app.wrapper
			.get('.message--failed')
			.findAll('button')
			.find((item) => item.text() === 'Discard')
			.trigger('click');
		await settle();
		expect(pending(app.wrapper)).toHaveLength(0);
		expect(textOf(app.wrapper)).not.toContain('drop me');
		expect(backend.dms.size).toBe(4);
	});

	test('a server rejection is explained and offers no retry', async () => {
		const backend = new ChatBackend();
		const original = backend.sendMessage.bind(backend);
		backend.sendMessage = () => ({
			status: 400,
			headers: { 'Cache-Control': 'no-store' },
			body: {
				error: {
					code: 'VALIDATION_ERROR',
					message: 'Validation failed',
					fields: { body: 'INVALID_TEXT' },
				},
			},
		});
		const app = await mountMessagesApp('/messages/10', { backend });
		await submit(app.wrapper, 'hello');
		await settle();
		const failed = app.wrapper.get('.message--failed');
		expect(failed.text()).toContain('hidden control characters');
		expect(failed.findAll('button').map((item) => item.text())).toEqual(['Discard']);
		backend.sendMessage = original;
	});

	test('losing the relationship turns the box off but keeps the history readable', async () => {
		const app = await mountMessagesApp('/messages/10');
		await type(app.wrapper, 'half written');
		app.backend.setFollow(10, 42, 'none');
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([503, 504]);
		expect(app.wrapper.get('#message-body').attributes('disabled')).toBeDefined();
		expect(send(app.wrapper).attributes('disabled')).toBeDefined();
		expect(textOf(app.wrapper)).toContain('You can’t message Lee Example any more.');
		expect(app.wrapper.get('.emoji-picker__toggle').attributes('disabled')).toBeDefined();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
		// The roster says the same.
		const roster = await mountMessagesApp('/messages', { backend: app.backend });
		expect(roster.wrapper.get('[data-user-id="10"]').text()).toContain('Read only');
	});

	test('a stale page that still sends is refused: no success, no retry, then the box is off', async () => {
		const app = await mountMessagesApp('/messages/10');
		// The relationship ends without this page being told.
		app.backend.setFollow(10, 42, 'none');
		app.backend.signals = [];
		await submit(app.wrapper, 'too late');
		await settle();
		const failed = app.wrapper.get('.message--failed');
		expect(failed.text()).toContain('You can’t message this person any more');
		expect(failed.findAll('button').map((item) => item.text())).toEqual(['Discard']);
		expect(app.backend.dms.size).toBe(4);
		expect(messageIds(app.wrapper)).toEqual([503, 504]);
		expect(app.wrapper.get('#message-body').attributes('disabled')).toBeDefined();
	});

	test('a pair that loses its relationship with no history disappears with its draft', async () => {
		const app = await mountMessagesApp('/messages/11');
		await type(app.wrapper, 'draft for Kim');
		expect(app.messages.draft(11).body).toBe('draft for Kim');
		app.backend.setFollow(42, 11, 'none');
		await deliverFrames(app);
		expect(textOf(app.wrapper)).toContain('This conversation isn’t available.');
		expect(app.wrapper.find('form').exists()).toBe(false);
		expect(app.messages.draft(11)).toBeNull();
	});

	test('the draft survives leaving and reopening the conversation', async () => {
		const app = await mountMessagesApp('/messages/10');
		await type(app.wrapper, 'later');
		await app.router.push('/messages');
		await settle();
		await app.router.push('/messages/10');
		await settle();
		expect(app.wrapper.get('#message-body').element.value).toBe('later');
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
	});
});

describe('SN-A19 text and emoji', () => {
	test('counts code points: 2000 emoji are allowed, 2001 are not, and CRLF becomes LF', async () => {
		const app = await mountMessagesApp('/messages/10');
		await type(app.wrapper, '😀'.repeat(2000));
		expect(app.wrapper.get('.message-composer__count').text()).toBe('2,000 / 2,000');
		expect(send(app.wrapper).attributes('disabled')).toBeUndefined();
		await type(app.wrapper, '😀'.repeat(2001));
		expect(app.wrapper.get('.field-error').text()).toContain('up to 2,000 characters');
		expect(app.wrapper.get('.field-error').attributes('role')).toBe('alert');
		expect(app.wrapper.get('.message-composer__count').classes()).toContain(
			'message-composer__count--over',
		);
		expect(send(app.wrapper).attributes('disabled')).toBeDefined();
		await app.wrapper.get('#message-body').trigger('keydown.enter');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
		await type(app.wrapper, 'a\r\nb\tc');
		await send(app.wrapper).trigger('click');
		await settle();
		expect(sendCalls(app.fetchRef)[0].json.body).toBe('a\nb\tc');
		expect(bodies(app.wrapper).at(-1)).toBe('a\nb\tc');
	});

	test('hidden control characters are refused before anything is sent', async () => {
		const app = await mountMessagesApp('/messages/10');
		await type(app.wrapper, 'bell\u0007');
		expect(app.wrapper.get('.field-error').text()).toContain('hidden control characters');
		expect(send(app.wrapper).attributes('disabled')).toBeDefined();
		expect(sendCalls(app.fetchRef)).toHaveLength(0);
	});

	test('long, wide and marked-up text renders as plain text and wraps', async () => {
		const app = await mountMessagesApp('/messages/10');
		const text = `<b>x</b> ${'W'.repeat(300)} 👩🏽‍💻\nsecond line`;
		await submit(app.wrapper, text);
		await settle();
		const last = app.wrapper.findAll('.message__body').at(-1);
		expect(last.text()).toBe(text);
		expect(last.find('b').exists()).toBe(false);
		expect(last.html()).toContain('&lt;b&gt;');
	});

	test('the emoji picker is keyboard operable and inserts at the cursor', async () => {
		const app = await mountMessagesApp('/messages/10');
		const field = await type(app.wrapper, 'ab');
		field.element.setSelectionRange(1, 1);
		const toggle = app.wrapper.get('.emoji-picker__toggle');
		expect(toggle.attributes('aria-expanded')).toBe('false');
		await toggle.trigger('click');
		await settle();
		expect(toggle.attributes('aria-expanded')).toBe('true');
		const panel = app.wrapper.get('.emoji-picker__panel');
		expect(panel.attributes('role')).toBe('group');
		const items = panel.findAll('button');
		expect(items.length).toBeGreaterThan(20);
		for (const item of items) expect(item.attributes('aria-label')).toBeTruthy();
		expect(document.activeElement).toBe(items[0].element);
		await app.wrapper.get('[aria-label="Thumbs up"]').trigger('click');
		await settle();
		expect(app.wrapper.get('#message-body').element.value).toBe('a👍b');
		expect(document.activeElement).toBe(app.wrapper.get('#message-body').element);
		await app.wrapper.get('.emoji-picker__item').trigger('keydown', { key: 'Escape' });
		await settle();
		expect(app.wrapper.find('.emoji-picker__panel').exists()).toBe(false);
		expect(document.activeElement).toBe(toggle.element);
	});
});

describe('SN-A19 images', () => {
	const png = () =>
		new File([new Uint8Array([137, 80, 78, 71])], 'board.png', { type: 'image/png' });

	async function choose(wrapper, file) {
		const input = wrapper.get('#message-image');
		Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
		await input.trigger('change');
		await settle();
	}

	test('an image alone can be sent: staged privately, previewed, then claimed by the send', async () => {
		const app = await mountMessagesApp('/messages/10');
		await choose(app.wrapper, png());
		const upload = chatCalls(app.fetchRef, { method: 'POST', path: /\/images$/u });
		expect(upload).toHaveLength(1);
		expect(upload[0].url).toBe('/api/v1/chats/10/images');
		expect(upload[0].multipart.map((part) => part.name)).toEqual(['image']);
		expect(app.wrapper.get('.message-composer__preview img').attributes('src')).toMatch(/^blob:/u);
		expect(app.wrapper.get('.message-composer__preview figcaption').text()).toBe('board.png');
		expect(send(app.wrapper).attributes('disabled')).toBeUndefined();
		await send(app.wrapper).trigger('click');
		await settle();
		expect(sendCalls(app.fetchRef)[0].json).toMatchObject({
			body: '',
			image_url: '/api/v1/media/703',
		});
		const sent = app.wrapper.get('.message[data-message-id="505"]');
		expect(sent.find('.message__body').exists()).toBe(false);
		expect(sent.get('img').attributes('src')).toMatch(/^blob:/u);
		expect(app.wrapper.find('.message-composer__preview').exists()).toBe(false);
		expect(app.backend.media.get(703).message_id).toBe(505);
	});

	test('a removed attachment is not sent, and a wrong file type never uploads', async () => {
		const app = await mountMessagesApp('/messages/10');
		await choose(app.wrapper, png());
		await app.wrapper
			.findAll('button')
			.find((item) => item.text() === 'Remove image')
			.trigger('click');
		await settle();
		expect(app.wrapper.find('.message-composer__preview').exists()).toBe(false);
		await submit(app.wrapper, 'just text');
		await settle();
		expect(sendCalls(app.fetchRef)[0].json).toEqual({
			client_id: expect.stringMatching(V4),
			body: 'just text',
		});
		await choose(app.wrapper, new File(['x'], 'notes.txt', { type: 'text/plain' }));
		expect(app.wrapper.get('.message-composer__image .field-error').text()).toBe(
			'Choose a JPEG, PNG or GIF image.',
		);
		await choose(
			app.wrapper,
			new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
		);
		expect(app.wrapper.get('.message-composer__image .field-error').text()).toBe(
			'Images can be up to 5 MiB.',
		);
		expect(chatCalls(app.fetchRef, { method: 'POST', path: /\/images$/u })).toHaveLength(1);
	});

	test('a rejected image upload says so and leaves the text sendable', async () => {
		const backend = new ChatBackend();
		backend.uploadFault = 422;
		const app = await mountMessagesApp('/messages/10', { backend });
		await type(app.wrapper, 'caption');
		await choose(app.wrapper, png());
		expect(app.wrapper.get('.message-composer__image .field-error').text()).toContain(
			'isn’t a valid JPEG, PNG or GIF',
		);
		expect(send(app.wrapper).attributes('disabled')).toBeUndefined();
		await send(app.wrapper).trigger('click');
		await settle();
		expect(sendCalls(app.fetchRef)[0].json.image_url).toBeUndefined();
	});

	test('a denied send keeps the staged image for the uploader’s retry', async () => {
		const app = await mountMessagesApp('/messages/10');
		await choose(app.wrapper, png());
		app.backend.setFollow(10, 42, 'none');
		app.backend.signals = [];
		await send(app.wrapper).trigger('click');
		await settle();
		expect(app.wrapper.get('.message--failed').text()).toContain(
			'You can’t message this person any more',
		);
		expect(app.backend.media.get(703).message_id).toBeNull();
		expect(app.backend.media.get(703).uploader_id).toBe(42);
	});
});

describe('SN-A19 live delivery', () => {
	test('a live message from the partner appears at once, in order, and is marked read', async () => {
		const app = await mountMessagesApp('/messages/10');
		app.backend.commit(10, 42, { body: 'Running late' });
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([503, 504, 505]);
		expect(bodies(app.wrapper).at(-1)).toBe('Running late');
		expect(readCalls(app.fetchRef).at(-1).json).toEqual({ through_id: 505 });
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
		expect(pending(app.wrapper)).toHaveLength(0);
	});

	test('a repeated frame for the same message is one entry', async () => {
		const app = await mountMessagesApp('/messages/10');
		const message = app.backend.commit(10, 42, { body: 'once' });
		app.backend.signals = [];
		const wire = app.backend.wire(message);
		for (let index = 0; index < 3; index += 1) frame(app, { type: 'dm.message', payload: wire });
		await settle();
		expect(messageIds(app.wrapper)).toEqual([503, 504, 505]);
	});

	test('the viewer’s own message from another tab is merged without becoming unread', async () => {
		const app = await mountMessagesApp('/messages/10');
		app.backend.commit(42, 10, {
			body: 'from my other tab',
			client_id: '99999999-9999-4999-8999-999999999999',
		});
		await deliverFrames(app);
		const last = app.wrapper.findAll('.message').at(-1);
		expect(last.get('.message__who').text()).toBe('You');
		expect(last.get('.message__body').text()).toBe('from my other tab');
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('0');
	});

	test('a message in another conversation moves the roster and total, not the open thread', async () => {
		const app = await mountMessagesApp('/messages/10');
		app.backend.commit(7, 42, { body: 'Ada here' });
		await deliverFrames(app);
		expect(messageIds(app.wrapper)).toEqual([503, 504]);
		expect(textOf(app.wrapper)).not.toContain('Ada here');
		expect(indicator(app.wrapper).get('.message-badge').text()).toBe('1');
	});

	test('a frame for someone who is not a messageable partner never reaches a thread', async () => {
		const app = await mountMessagesApp('/messages/9');
		frame(app, {
			type: 'dm.message',
			payload: {
				id: 900,
				sender_id: 9,
				recipient_id: 42,
				sender_username: 'Pat Example',
				body: 'hi stranger',
				created_at: '2026-10-15T12:00:00Z',
				client_id: null,
			},
		});
		await settle();
		expect(textOf(app.wrapper)).not.toContain('hi stranger');
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
	});

	test('a message withheld from live delivery appears on the next focus, refetch or reopen', async () => {
		// Alex is private and does not follow Lee, who follows Alex: Lee may
		// message Alex, but instant delivery is withheld from Alex.
		const backend = new ChatBackend();
		backend.users.get(42).visibility = 'private';
		const app = await mountMessagesApp('/messages/10', { backend });
		backend.commit(10, 42, { body: 'quiet one' });
		expect(backend.signals[0].recipients).toEqual([10]);
		await deliverFrames(app);
		expect(textOf(app.wrapper)).not.toContain('quiet one');
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(bodies(app.wrapper).at(-1)).toBe('quiet one');
	});
});

describe('SN-A19 history and recovery', () => {
	test('pages older history on request without duplicates or reordering', async () => {
		const backend = new ChatBackend();
		seed(backend, 40);
		const app = await mountMessagesApp('/messages/10', { backend });
		expect(messageIds(app.wrapper)).toHaveLength(30);
		const earlier = () =>
			app.wrapper.findAll('button').find((item) => item.text() === 'Load earlier messages');
		expect(earlier()).toBeTruthy();
		await earlier().trigger('click');
		await settle();
		const ids = messageIds(app.wrapper);
		expect(ids).toHaveLength(42);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(ids.length);
		expect(earlier()).toBeUndefined();
		expect(textOf(app.wrapper)).toContain('This is the start of the conversation.');
		const pages = chatCalls(app.fetchRef, { method: 'GET', path: /\/messages\?/u }).map(
			(call) => call.url,
		);
		expect(pages.some((url) => url.includes('before_id='))).toBe(true);
	});

	test('a failed earlier-history request says so and can be retried', async () => {
		const backend = new ChatBackend();
		seed(backend, 40);
		const app = await mountMessagesApp('/messages/10', { backend });
		backend.faults.push({ method: 'GET', path: /\/chats\/10\/messages$/u });
		const earlier = () =>
			app.wrapper.findAll('button').find((item) => item.text() === 'Load earlier messages');
		await earlier().trigger('click');
		await settle();
		expect(app.wrapper.get('.message-thread__older .field-error').text()).toContain(
			'couldn’t load earlier messages',
		);
		expect(messageIds(app.wrapper)).toHaveLength(30);
		await earlier().trigger('click');
		await settle();
		expect(messageIds(app.wrapper)).toHaveLength(42);
	});

	test.each([
		35, 1235,
	])('after a reconnect all %i missed messages are recovered', async (missed) => {
		const backend = new ChatBackend();
		const app = await mountMessagesApp('/messages/10', { backend });
		expect(messageIds(app.wrapper)).toEqual([503, 504]);
		// The socket is down: messages are committed and no frame arrives.
		for (let index = 0; index < missed; index += 1)
			backend.commit(10, 42, { body: `missed ${index}` });
		backend.signals = [];
		expect(messageIds(app.wrapper)).toEqual([503, 504]);
		await connect(app);
		const ids = messageIds(app.wrapper);
		expect(ids).toHaveLength(missed + 2);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(missed + 2);
		const urls = chatCalls(app.fetchRef, { method: 'GET', path: /\/10\/messages/u }).map(
			(call) => call.url,
		);
		expect(urls.some((url) => url.includes('before_id='))).toBe(true);
		expect(readCalls(app.fetchRef).at(-1).json).toEqual({ through_id: ids.at(-1) });
	});

	test('losing the connection says delivery is reconnecting and sending still works', async () => {
		const app = await mountMessagesApp('/messages/10');
		expect(app.wrapper.find('.message-connection').exists()).toBe(false);
		app.sockets.at(-1).onclose();
		await settle();
		expect(app.wrapper.get('.message-connection').text()).toContain('reconnecting');
		await submit(app.wrapper, 'offline send');
		await settle();
		expect(sendCalls(app.fetchRef)).toHaveLength(1);
		expect(bodies(app.wrapper).at(-1)).toBe('offline send');
	});

	test('a message sent to someone offline is stored and shown to them on their next fetch', async () => {
		const backend = new ChatBackend();
		backend.setOnline(10, false, { announce: false });
		const app = await mountMessagesApp('/messages/10', { backend });
		await submit(app.wrapper, 'for later');
		await settle();
		expect(backend.signals).toEqual([]);
		cleanupMounted();
		const lee = await mountMessagesApp('/messages/42', { backend, viewerId: 10 });
		expect(bodies(lee.wrapper).at(-1)).toBe('for later');
		expect(indicator(lee.wrapper).get('.message-badge').text()).toBe('0');
		expect(backend.cursor(10, 42)).toBe(Math.max(...backend.dms.keys()));
	});
});

describe('SN-A19 account changes and cleanup', () => {
	test('switching accounts clears conversations, drafts, pending messages and cached images', async () => {
		const app = await mountMessagesApp('/messages/7');
		await type(app.wrapper, 'private draft');
		expect(app.objectUrls.created).toHaveLength(1);
		app.current.viewerId = 99;
		await app.session.restore({ force: true });
		await settle();
		expect(app.messages.draft(7)).toBeNull();
		expect(app.objectUrls.revoked).toContain('blob:test/1');
		expect(textOf(app.wrapper)).not.toContain('private draft');
		expect(textOf(app.wrapper)).not.toContain('Morning! Did you see the new rules?');
		expect(app.wrapper.find('img.message-image').exists()).toBe(false);
		// Robin has no relationship with Ada, so her conversation is unavailable.
		expect(textOf(app.wrapper)).toContain('This conversation isn’t available.');
		await app.router.push('/messages');
		await settle();
		expect(rosterIds(app.wrapper)).toEqual([]);
	});

	test('a response that lands after the account changed is never painted', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp('/messages', {
			before: async (entry) => {
				if (hold && entry.method === 'GET' && /\/chats\/10\/messages/u.test(entry.url))
					await gate.promise;
			},
		});
		hold = true;
		await app.router.push('/messages/10');
		await settle();
		app.current.viewerId = 99;
		await app.session.restore({ force: true });
		await settle();
		gate.release();
		await settle();
		expect(textOf(app.wrapper)).not.toContain('Bring the clock.');
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
	});

	test('a pending send does not complete into the next account', async () => {
		const gate = deferred();
		let hold = false;
		const app = await mountMessagesApp('/messages/10', {
			before: async (entry) => {
				if (hold && entry.method === 'POST') await gate.promise;
			},
		});
		hold = true;
		await submit(app.wrapper, 'in flight');
		app.current.viewerId = 99;
		await app.session.restore({ force: true });
		await settle();
		gate.release();
		await settle();
		expect(app.messages.outbox(10)).toEqual([]);
		expect(textOf(app.wrapper)).not.toContain('in flight');
	});

	test('signing out clears the message state and the indicator', async () => {
		const app = await mountMessagesApp('/messages/7');
		await type(app.wrapper, 'secret');
		await app.wrapper.get('.site-nav__logout').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.name).toBe('login');
		expect(app.messages.draft(7)).toBeNull();
		expect(app.messages.state.unreadCount).toBeNull();
		expect(app.objectUrls.revoked).toContain('blob:test/1');
		expect(app.wrapper.find('[data-testid="message-indicator"]').exists()).toBe(false);
	});

	test('a lost session on a message read ends the session cleanly', async () => {
		const app = await mountMessagesApp('/messages/10');
		app.current.viewerId = null;
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(app.router.currentRoute.value.name).toBe('login');
		expect(app.wrapper.find('.message-list').exists()).toBe(false);
	});
});

describe('SN-A19 keyboard and accessibility', () => {
	test('the roster rows, composer controls and thread are reachable with names and roles', async () => {
		const app = await mountMessagesApp('/messages/10');
		const list = app.wrapper.get('.message-list');
		expect(list.attributes('role')).toBe('log');
		expect(list.attributes('aria-live')).toBe('polite');
		expect(list.attributes('aria-label')).toBe('Messages with Lee Example');
		expect(list.attributes('tabindex')).toBe('0');
		expect(app.wrapper.get('label[for="message-body"]').text()).toBe('Message Lee Example');
		expect(app.wrapper.get('label[for="message-image"]').text()).toBe('Add an image');
		for (const control of app.wrapper.findAll('form button, form textarea, form input'))
			expect(control.attributes('tabindex')).not.toBe('-1');
	});
});
