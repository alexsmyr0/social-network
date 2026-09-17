// Audit Q16, wired end to end through the roster controller.
//
// chat.roster.unread.test.js pins the pure state transitions; this pins the
// decision the controller makes on each incoming frame — which messages are
// news, which are already on screen, and when a thread stops being read.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import { CONVERSATION_CLOSED_EVENT } from '../../../../features/chat/chat.conversation.page.js';
import { initChatRoster } from '../../../../features/chat/chat.roster.page.js';

beforeEach(() => {
	resetAppState();
});

const originalCustomEvent = globalThis.CustomEvent;

beforeEach(() => {
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
});

async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

// Roster root stub carrying both mount points the controller paints into: the
// list itself and the unread slot beside the panel heading.
function createRosterRoot() {
	const attrs = new Map();
	const listeners = new Map();
	const listMount = { innerHTML: '' };
	const unreadSlot = { innerHTML: '' };
	const rows = new Map();

	function rowStub(id) {
		if (!rows.has(id)) {
			const rowAttrs = new Map();
			const classes = new Set();
			rows.set(id, {
				dispatchedEvents: [],
				setAttribute: (n, v) => rowAttrs.set(n, String(v)),
				getAttribute: (n) => (rowAttrs.has(n) ? rowAttrs.get(n) : null),
				classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
				closest: (sel) => (sel === '[data-roster-user-id]' ? rows.get(id) : null),
				dispatchEvent(event) {
					this.dispatchedEvents.push(event);
					return true;
				},
			});
		}
		return rows.get(id);
	}

	return {
		_listMount: listMount,
		_unreadSlot: unreadSlot,
		_row: rowStub,
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		setAttribute: (name, value) => attrs.set(name, String(value)),
		addEventListener(type, handler) {
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		},
		querySelector(selector) {
			if (selector === '#roster-list') {
				return listMount;
			}
			if (selector === '[data-roster-unread-slot]') {
				return unreadSlot;
			}
			const match = selector.match(/\[data-roster-user-id="(\d+)"\]/);
			return match ? rowStub(Number(match[1])) : null;
		},
		querySelectorAll: () => [],
		dispatch(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		},
	};
}

function createDocumentRef(rosterRoot) {
	const listeners = new Map();
	return {
		querySelector: (selector) => (selector === '[data-chat-roster]' ? rosterRoot : null),
		addEventListener(type, handler) {
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		},
		dispatch(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		},
	};
}

const ENTRIES = [
	{ user_id: 1, username: 'me-not-listed', is_online: false, last_message_preview: null },
	{ user_id: 2, username: 'beta', is_online: true, last_message_preview: 'old' },
	{ user_id: 3, username: 'gamma', is_online: true, last_message_preview: null },
];

function rosterFetch({ entries = ENTRIES, meId = 1 } = {}) {
	return vi.fn(async (url) => {
		if (String(url).endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		return { ok: true, status: 200, json: async () => ({ data: entries }) };
	});
}

async function mountRoster(overrides = {}) {
	const root = createRosterRoot();
	const documentRef = createDocumentRef(root);
	const fetchRef = rosterFetch(overrides);

	initChatRoster({ windowRef: {}, documentRef, fetchRef });
	await flushMicrotasks();

	return { root, documentRef, fetchRef };
}

function incomingFrom(senderId, body = 'hello') {
	return { detail: { message: { sender_id: senderId, recipient_id: 1, body } } };
}

// Clicking a roster row selects it, which is what opens the conversation.
function clickRow(root, userId) {
	const row = root._row(userId);
	row.setAttribute('data-roster-user-id', String(userId));
	row.setAttribute('data-roster-username', `user${userId}`);
	row.setAttribute('data-roster-online', 'true');
	root.dispatch('click', { target: row });
}

describe('roster unread badges (audit Q16)', () => {
	test('a DM that arrives while no thread is open is announced', async () => {
		const { root, documentRef } = await mountRoster();

		expect(root._unreadSlot.innerHTML).toBe('');

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2, 'ping while you are away'));
		await flushMicrotasks();

		expect(root._listMount.innerHTML).toContain('data-roster-unread-count="1"');
		expect(root._listMount.innerHTML).toContain('chat-roster__item--unread');
		// And the tally beside the heading, which stays visible however far the
		// roster is scrolled.
		expect(root._unreadSlot.innerHTML).toContain('data-roster-unread-total');
		expect(root._unreadSlot.innerHTML).toContain('>1</span>');
	});

	test('a message landing in the OPEN thread is not unread', async () => {
		const { root, documentRef } = await mountRoster();

		clickRow(root, 2);
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2, 'you are reading this'));
		await flushMicrotasks();

		expect(root._unreadSlot.innerHTML).toBe('');
		expect(root._listMount.innerHTML).not.toContain('chat-roster__item--unread');
	});

	test('a message from a DIFFERENT user is unread even with a thread open', async () => {
		const { root, documentRef } = await mountRoster();

		clickRow(root, 2);
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(3, 'over here'));
		await flushMicrotasks();

		expect(root._unreadSlot.innerHTML).toContain('>1</span>');
		expect(root._listMount.innerHTML).toContain('data-roster-unread-count="1"');
	});

	// The backend echoes the sender's own message back down the socket, so the
	// frame for a message we sent looks exactly like an incoming one apart from
	// its sender id.
	test('our own sent message never marks itself unread', async () => {
		const { root, documentRef } = await mountRoster();

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: { message: { sender_id: 1, recipient_id: 3, body: 'sent by me' } },
		});
		await flushMicrotasks();

		expect(root._unreadSlot.innerHTML).toBe('');
		// It still reorders and refreshes the preview — it just is not news.
		expect(root._listMount.innerHTML).toContain('sent by me');
		expect(root._listMount.innerHTML).not.toContain('chat-roster__item--unread');
	});

	test('opening the thread clears its badge', async () => {
		const { root, documentRef } = await mountRoster();

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2));
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2));
		await flushMicrotasks();
		expect(root._unreadSlot.innerHTML).toContain('>2</span>');

		clickRow(root, 2);

		expect(root._unreadSlot.innerHTML).toBe('');
		expect(root._listMount.innerHTML).not.toContain('chat-roster__item--unread');
	});

	test('opening one thread leaves another thread’s badge alone', async () => {
		const { root, documentRef } = await mountRoster();

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2));
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(3));
		await flushMicrotasks();

		clickRow(root, 2);

		expect(root._unreadSlot.innerHTML).toContain('>1</span>');
	});

	// Closing with the back arrow leaves the row selected but no longer read.
	test('a message arriving after the thread is closed counts again', async () => {
		const { root, documentRef } = await mountRoster();

		clickRow(root, 2);
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2, 'read live'));
		await flushMicrotasks();
		expect(root._unreadSlot.innerHTML).toBe('');

		documentRef.dispatch(CONVERSATION_CLOSED_EVENT, {});
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, incomingFrom(2, 'arrived after closing'));
		await flushMicrotasks();

		expect(root._unreadSlot.innerHTML).toContain('>1</span>');
	});
});
