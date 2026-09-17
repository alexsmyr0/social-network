// D06 — Chat Frontend Regression Coverage
//
// This suite is the integrated regression layer for the realtime chat UI. The
// D01–D04 feature work each shipped focused unit tests that exercise one module
// in isolation (roster OR conversation). D06 instead wires `initChatRoster` and
// `initChatConversation` onto a SINGLE shared document, so the behaviours that
// only emerge from their interaction are protected:
//
//   - one inbound `dm.message` frame must reorder the roster AND render live in
//     the open conversation,
//   - clicking any rostered row (online or offline) must open its conversation,
//   - presence frames must repaint the roster while a thread is open.
//
// Each test is named after a bullet of the D06 verification gate so the mapping
// stays explicit. The fake DOM follows the project's node-environment stub style
// (vitest runs with `environment: 'node'`, no jsdom): real view modules render
// HTML strings we assert on, while imperative nodes (scroll, message list, error
// banner) are recording stubs.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../core/realtime/chat-socket.js';
import { resetAppState } from '../../core/state/app-state.js';
import {
	initChatConversation,
	SEND_MESSAGE_EVENT,
} from '../../features/chat/chat.conversation.page.js';
import { initChatRoster } from '../../features/chat/chat.roster.page.js';

const originalCustomEvent = globalThis.CustomEvent;

async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

function pushListener(map, type, handler) {
	if (!map.has(type)) {
		map.set(type, []);
	}
	map.get(type).push(handler);
}

function fireListeners(map, type, event) {
	for (const handler of map.get(type) ?? []) {
		handler(event);
	}
}

beforeEach(() => {
	// The session/presence slices are one module-level store shared by every
	// slice (issue #76), so each case starts from a clean slot set.
	resetAppState();
	if (typeof globalThis.CustomEvent !== 'function') {
		globalThis.CustomEvent = class CustomEvent {
			constructor(type, init = {}) {
				this.type = type;
				this.detail = init.detail;
				this.bubbles = Boolean(init.bubbles);
			}
		};
	}
});

afterEach(() => {
	globalThis.CustomEvent = originalCustomEvent;
	vi.restoreAllMocks();
});

// --- Fake DOM ---------------------------------------------------------------

// Roster root: records every innerHTML write to its `#roster-list` mount and
// hands back lazily-created row stubs so selection re-application after a live
// re-render can be observed.
function createRosterRoot() {
	const attrs = new Map();
	const listeners = new Map();
	const listMount = { innerHTML: '' };
	const rows = new Map();

	const root = {
		_listMount: listMount,
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		setAttribute(name, value) {
			attrs.set(name, String(value));
		},
		addEventListener(type, handler) {
			pushListener(listeners, type, handler);
		},
		querySelector(selector) {
			if (selector === '#roster-list') {
				return listMount;
			}
			const match = selector.match(/\[data-roster-user-id="(\d+)"\]/);
			if (match) {
				const id = Number(match[1]);
				if (!rows.has(id)) {
					const rowAttrs = new Map();
					const classes = new Set();
					rows.set(id, {
						setAttribute: (n, v) => rowAttrs.set(n, String(v)),
						getAttribute: (n) => (rowAttrs.has(n) ? rowAttrs.get(n) : null),
						classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
						_classes: classes,
					});
				}
				return rows.get(id);
			}
			return null;
		},
		querySelectorAll() {
			return [];
		},
		dispatch(type, event) {
			fireListeners(listeners, type, event);
		},
		_row: (id) => rows.get(id),
	};

	return root;
}

// A clickable roster row whose bubbling CustomEvents are forwarded to the shared
// document — this is what lets a roster click drive the conversation module, the
// same path real DOM bubbling provides in the browser.
function createClickableRow(documentRef, { id, username, isOnline }) {
	const rowAttrs = new Map([
		['data-roster-user-id', String(id)],
		['data-roster-username', username],
		['data-roster-online', isOnline ? 'true' : 'false'],
	]);
	const classes = new Set();
	const row = {
		getAttribute: (n) => (rowAttrs.has(n) ? rowAttrs.get(n) : null),
		setAttribute: (n, v) => rowAttrs.set(n, String(v)),
		classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
		closest: (sel) => (sel === '[data-roster-user-id]' ? row : null),
		dispatchEvent: (event) => {
			if (event?.bubbles) {
				documentRef.dispatch(event.type, event);
			}
			return true;
		},
	};
	return row;
}

// Conversation root: the initial render lands in `innerHTML` (a string we assert
// on), while live appends and prepended history go through the message-list stub
// so we can read what was inserted and where.
function createConversationRoot({ scrollTop = 0, scrollHeight = 600, growth = 120 } = {}) {
	const attrs = new Map();
	const listeners = new Map();
	const scrollListeners = new Map();

	const messagesList = {
		appended: [],
		insertAdjacentHTML(position, html) {
			this.appended.push({ position, html });
			// Prepending/appending nodes grows the scroll container, mirroring the
			// browser so the page's viewport-restore math can be exercised.
			scroll.scrollHeight += growth;
		},
	};

	const scroll = {
		innerHTML: '',
		scrollHeight,
		scrollTop,
		querySelector(selector) {
			return selector === '[data-conversation-messages]' ? messagesList : null;
		},
		addEventListener(type, handler) {
			pushListener(scrollListeners, type, handler);
		},
		dispatchScroll() {
			fireListeners(scrollListeners, 'scroll');
		},
	};

	const bannerAttrs = new Map([['hidden', '']]);
	const errorBanner = {
		textContent: '',
		setAttribute: (n, v) => bannerAttrs.set(n, String(v)),
		removeAttribute: (n) => bannerAttrs.delete(n),
		isHidden: () => bannerAttrs.has('hidden'),
	};

	const root = {
		innerHTML: '',
		_scroll: scroll,
		_messages: messagesList,
		_error: errorBanner,
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		setAttribute(name, value) {
			attrs.set(name, String(value));
		},
		addEventListener(type, handler) {
			pushListener(listeners, type, handler);
		},
		querySelector(selector) {
			if (selector === '[data-conversation-scroll]') {
				return scroll;
			}
			if (selector === '[data-conversation-error]') {
				return errorBanner;
			}
			if (selector === '[data-conversation-messages]') {
				return messagesList;
			}
			return null;
		},
		dispatch(type, event) {
			fireListeners(listeners, type, event);
		},
	};

	return root;
}

function createDocumentRef(rosterRoot, activeRoot) {
	const listeners = new Map();
	return {
		dispatched: [],
		querySelector(selector) {
			if (selector === '[data-chat-roster]') {
				return rosterRoot;
			}
			if (selector === '[data-chat-active]') {
				return activeRoot;
			}
			return null;
		},
		addEventListener(type, handler) {
			pushListener(listeners, type, handler);
		},
		dispatch(type, event) {
			fireListeners(listeners, type, event);
		},
		dispatchEvent(event) {
			this.dispatched.push(event);
			// Mirror a real document: listeners run synchronously during dispatch,
			// which is how the composer learns whether the app shell accepted its
			// outbound frame before it clears the typed text.
			fireListeners(listeners, event?.type, event);
			return true;
		},
	};
}

// Stands in for the app shell's SEND_MESSAGE_EVENT listener, which owns the
// socket and reports whether the frame actually left the client.
function acceptSends(documentRef, accepted = true) {
	documentRef.addEventListener(SEND_MESSAGE_EVENT, (event) => {
		if (event?.detail) {
			event.detail.accepted = accepted;
		}
	});
}

function okJson(body) {
	return { ok: true, status: 200, json: async () => body };
}

// One fetch stub fronting all three endpoints the chat UI touches: the signed-in
// id (/users/me), the roster (/chats) and conversation history (/chats/:id/messages,
// optionally paged with before_id).
function makeChatFetch({
	meId = 1,
	roster = [],
	history = [],
	hasMore = false,
	older = null,
} = {}) {
	return vi.fn(async (url) => {
		const u = String(url);
		if (u.endsWith('/users/me')) {
			return okJson({ data: { id: meId } });
		}
		if (u.includes('/messages')) {
			if (u.includes('before_id=') && older) {
				return okJson({ data: { messages: older.messages, has_more: older.hasMore } });
			}
			return okJson({ data: { messages: history, has_more: hasMore } });
		}
		return okJson({ data: roster });
	});
}

// Boots both chat modules on a shared document, exactly as create-app does at
// authenticated boot, and returns the wired handles.
async function setupChat(config = {}, rootOptions = {}) {
	const rosterRoot = createRosterRoot();
	const activeRoot = createConversationRoot(rootOptions);
	const documentRef = createDocumentRef(rosterRoot, activeRoot);
	const fetchRef = makeChatFetch(config);

	initChatRoster({ windowRef: {}, documentRef, fetchRef });
	initChatConversation({ windowRef: {}, documentRef, fetchRef });
	await flushMicrotasks();

	return { rosterRoot, activeRoot, documentRef, fetchRef };
}

function selectUser(documentRef, { userId, username = 'bob', isOnline = true }) {
	documentRef.dispatch('chat:user-selected', { detail: { userId, username, isOnline } });
}

function msg(id, { senderId = 2, recipientId = 1, username = 'bob' } = {}) {
	return {
		id,
		sender_id: senderId,
		recipient_id: recipientId,
		sender_username: username,
		body: `m${id}`,
		created_at: '2026-01-01T00:00:00Z',
	};
}

// --- Gate: offline composer behaviour is explicitly protected ---------------

describe('D06 — offline composer behaviour', () => {
	test('selecting an offline user disables the composer yet keeps history readable', async () => {
		const { activeRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [{ user_id: 4, username: 'kim', is_online: false, last_message_preview: 'older' }],
			history: [
				{
					id: 9,
					sender_id: 4,
					recipient_id: 1,
					sender_username: 'kim',
					body: 'offline history line',
					created_at: '2026-01-01T00:00:00Z',
				},
			],
		});

		selectUser(documentRef, { userId: 4, username: 'kim', isOnline: false });
		await flushMicrotasks();

		// Composer is disabled and the offline note is shown...
		expect(activeRoot.innerHTML).toContain('disabled');
		expect(activeRoot.innerHTML).toContain('data-conversation-offline');
		// ...but the past conversation is still rendered and legible.
		expect(activeRoot.innerHTML).toContain('offline history line');
	});

	test('selecting an online user enables the composer', async () => {
		const { activeRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [{ user_id: 2, username: 'bob', is_online: true, last_message_preview: null }],
			history: [],
		});

		selectUser(documentRef, { userId: 2, username: 'bob', isOnline: true });
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toContain('data-conversation-composer');
		expect(activeRoot.innerHTML).not.toContain('data-conversation-offline');
	});
});

// --- Gate: offline-history readability and empty-state conversations --------

describe('D06 — empty-state conversations', () => {
	test('selecting a user with no history shows a valid empty state', async () => {
		const { activeRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [{ user_id: 7, username: 'sam', is_online: true, last_message_preview: null }],
			history: [],
		});

		selectUser(documentRef, { userId: 7, username: 'sam', isOnline: true });
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toContain('data-conversation-empty');
		expect(activeRoot.innerHTML).toContain('No messages yet');
	});
});

// --- Gate: presence rendering + every rostered user remains selectable -------

describe('D06 — presence rendering and selectability', () => {
	test('a presence snapshot repaints per-user online/offline state across the roster', async () => {
		const { rosterRoot, documentRef, fetchRef } = await setupChat({
			roster: [
				{ user_id: 2, username: 'bob', is_online: false, last_message_preview: null },
				{ user_id: 3, username: 'cara', is_online: false, last_message_preview: null },
			],
		});
		const callsBefore = fetchRef.mock.calls.length;

		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 2, is_online: true }] },
		});

		const html = rosterRoot._listMount.innerHTML;
		// bob (2) is painted online, cara (3) stays offline, with no roster refetch.
		expect(html).toMatch(/data-roster-user-id="2"[\s\S]*?data-roster-online="true"/);
		expect(html).toMatch(/data-roster-user-id="3"[\s\S]*?data-roster-online="false"/);
		expect(fetchRef.mock.calls.length).toBe(callsBefore);
	});

	test('a presence update flips a single roster user without a refetch', async () => {
		const { rosterRoot, documentRef, fetchRef } = await setupChat({
			roster: [
				{ user_id: 2, username: 'bob', is_online: false, last_message_preview: null },
				{ user_id: 3, username: 'cara', is_online: false, last_message_preview: null },
			],
		});
		const callsBefore = fetchRef.mock.calls.length;

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 3, isOnline: true } });

		expect(rosterRoot._listMount.innerHTML).toMatch(
			/data-roster-user-id="3"[\s\S]*?data-roster-online="true"/,
		);
		expect(fetchRef.mock.calls.length).toBe(callsBefore);
	});

	test('an offline rostered user is still selectable and opens its conversation', async () => {
		const { activeRoot, rosterRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [{ user_id: 5, username: 'ada', is_online: false, last_message_preview: 'hey' }],
			history: [
				{
					id: 3,
					sender_id: 5,
					recipient_id: 1,
					sender_username: 'ada',
					body: 'past message',
					created_at: '2026-01-01T00:00:00Z',
				},
			],
		});

		// Click the offline row; the bubbling chat:user-selected must reach the
		// conversation and open the thread (offline users remain selectable).
		const row = createClickableRow(documentRef, { id: 5, username: 'ada', isOnline: false });
		rosterRoot.dispatch('click', { target: row });
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toContain('past message');
		expect(activeRoot.innerHTML).toContain('disabled');
		// Row is marked selected.
		expect(row.getAttribute('aria-pressed')).toBe('true');
	});
});

// --- Gate: live message rendering, roster reordering, send-error handling ----

describe('D06 — live messaging across roster and conversation', () => {
	test('one dm.message reorders the roster and renders live in the open conversation', async () => {
		const { rosterRoot, activeRoot, documentRef } = await setupChat({
			meId: 1,
			// API order puts cara first; a message from bob must float bob above her.
			roster: [
				{ user_id: 3, username: 'cara', is_online: true, last_message_preview: 'yo' },
				{ user_id: 2, username: 'bob', is_online: true, last_message_preview: 'hi' },
			],
			history: [
				{
					id: 5,
					sender_id: 2,
					recipient_id: 1,
					sender_username: 'bob',
					body: 'earlier',
					created_at: '2026-01-01T00:00:00Z',
				},
			],
		});

		selectUser(documentRef, { userId: 2, username: 'bob', isOnline: true });
		await flushMicrotasks();
		expect(activeRoot.innerHTML).toContain('earlier');

		// A single inbound frame drives BOTH modules through the shared document.
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: {
				message: {
					id: 7,
					sender_id: 2,
					recipient_id: 1,
					sender_username: 'bob',
					body: 'live ping',
				},
			},
		});
		await flushMicrotasks();

		// Roster: bob floated to the top with the refreshed preview.
		const rosterHtml = rosterRoot._listMount.innerHTML;
		expect(rosterHtml.indexOf('data-roster-user-id="2"')).toBeLessThan(
			rosterHtml.indexOf('data-roster-user-id="3"'),
		);
		expect(rosterHtml).toContain('live ping');

		// Conversation: the message rendered live and the viewport pinned to bottom.
		expect(activeRoot._messages.appended).toHaveLength(1);
		expect(activeRoot._messages.appended[0].position).toBe('beforeend');
		expect(activeRoot._messages.appended[0].html).toContain('live ping');
		expect(activeRoot._scroll.scrollTop).toBe(activeRoot._scroll.scrollHeight);
	});

	test('a dm.message for a different thread updates the roster but not the open conversation', async () => {
		const { rosterRoot, activeRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [
				{ user_id: 2, username: 'bob', is_online: true, last_message_preview: null },
				{ user_id: 9, username: 'zoe', is_online: true, last_message_preview: null },
			],
			history: [],
		});

		selectUser(documentRef, { userId: 2, username: 'bob', isOnline: true });
		await flushMicrotasks();

		// Message from zoe (9) while bob's thread is open.
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: {
				message: {
					id: 8,
					sender_id: 9,
					recipient_id: 1,
					sender_username: 'zoe',
					body: 'for zoe thread',
				},
			},
		});
		await flushMicrotasks();

		// Roster reorders zoe to the top; the open conversation does not append.
		expect(rosterRoot._listMount.innerHTML).toContain('for zoe thread');
		expect(activeRoot._messages.appended).toHaveLength(0);
	});

	test('a chat:error surfaces the conversation error banner', async () => {
		const { activeRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [{ user_id: 2, username: 'bob', is_online: true, last_message_preview: null }],
			history: [],
		});

		selectUser(documentRef, { userId: 2, username: 'bob', isOnline: true });
		await flushMicrotasks();

		documentRef.dispatch(WS_EVENTS.ERROR, {
			detail: { code: 'RECIPIENT_OFFLINE', message: 'That user just went offline.' },
		});

		expect(activeRoot._error.isHidden()).toBe(false);
		expect(activeRoot._error.textContent).toBe('That user just went offline.');
	});

	test('submitting the composer emits an outbound send for the active recipient', async () => {
		const { activeRoot, documentRef } = await setupChat({
			meId: 1,
			roster: [{ user_id: 2, username: 'bob', is_online: true, last_message_preview: null }],
			history: [],
		});

		acceptSends(documentRef);
		selectUser(documentRef, { userId: 2, username: 'bob', isOnline: true });
		await flushMicrotasks();

		const input = { value: '  hello bob  ' };
		const composer = {
			querySelector: (sel) => (sel === '[data-conversation-input]' ? input : null),
		};
		activeRoot.dispatch('submit', {
			target: { closest: (sel) => (sel === '[data-conversation-composer]' ? composer : null) },
			preventDefault: vi.fn(),
		});

		const sends = documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT);
		expect(sends).toHaveLength(1);
		expect(sends[0].detail).toEqual({ recipientId: 2, body: 'hello bob', accepted: true });
		// Input cleared after handing the message to the transport.
		expect(input.value).toBe('');
	});
});

// --- Gate: incremental history-loading behaviour ----------------------------

describe('D06 — incremental history loading', () => {
	test('scrolling to the top loads an older batch of 10 with before_id and preserves the viewport', async () => {
		const initial = Array.from({ length: 10 }, (_, i) => msg(i + 11));
		const older = Array.from({ length: 10 }, (_, i) => msg(i + 1));

		const { activeRoot, documentRef, fetchRef } = await setupChat(
			{
				meId: 1,
				roster: [],
				history: initial,
				hasMore: true,
				older: { messages: older, hasMore: false },
			},
			{ scrollTop: 0, scrollHeight: 600 },
		);

		selectUser(documentRef, { userId: 2, username: 'bob', isOnline: true });
		await flushMicrotasks();

		// The thread opens on its newest message. That is what makes scrolling up
		// possible at all: left at scrollTop 0 the container has nowhere to move,
		// so a real browser emits no scroll event and paging never runs.
		expect(activeRoot._scroll.scrollTop).toBe(activeRoot._scroll.scrollHeight);

		// Now the user scrolls up to the top, which is what triggers the load.
		activeRoot._scroll.scrollTop = 0;
		const previousTop = activeRoot._scroll.scrollTop;
		activeRoot._scroll.dispatchScroll();
		await flushMicrotasks();

		// Oldest rendered id was 11, so the older page is requested with before_id=11.
		const olderCall = fetchRef.mock.calls.find(([url]) => String(url).includes('before_id='));
		expect(olderCall?.[0]).toBe('/api/v1/chats/2/messages?before_id=11');

		// A single prepended batch of 10 items lands at the top of the list.
		expect(activeRoot._messages.appended).toHaveLength(1);
		expect(activeRoot._messages.appended[0].position).toBe('afterbegin');
		expect(activeRoot._messages.appended[0].html.match(/data-message-id/g)).toHaveLength(10);

		// The previously-visible content stays anchored: scrollTop shifts down by
		// exactly the height the prepend added, keeping the viewport usable.
		expect(activeRoot._scroll.scrollTop).toBeGreaterThan(previousTop);
	});
});
