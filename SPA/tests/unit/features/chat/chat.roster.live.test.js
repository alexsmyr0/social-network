import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import { initChatRoster } from '../../../../features/chat/chat.roster.page.js';

// The session/presence slices are one module-level store shared by every slice
// (issue #76), so each case starts from a clean slot set rather than inheriting
// the previous one's identity and presence.
beforeEach(() => {
	resetAppState();
});

const originalCustomEvent = globalThis.CustomEvent;

async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

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

// The list mount records every innerHTML write so a test can read what the
// roster painted on the latest re-render. A lightweight selected-row stub is
// returned for the data-roster-user-id query so selection re-application works.
function createRosterRoot() {
	const attrs = new Map();
	const listeners = new Map();
	const listMount = { innerHTML: '' };
	const selectedRows = new Map();

	const root = {
		_listMount: listMount,
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		setAttribute(name, value) {
			attrs.set(name, String(value));
		},
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
			const match = selector.match(/\[data-roster-user-id="(\d+)"\]/);
			if (match) {
				const id = Number(match[1]);
				if (!selectedRows.has(id)) {
					const rowAttrs = new Map();
					const classes = new Set();
					selectedRows.set(id, {
						setAttribute: (n, v) => rowAttrs.set(n, String(v)),
						getAttribute: (n) => (rowAttrs.has(n) ? rowAttrs.get(n) : null),
						classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
						_classes: classes,
					});
				}
				return selectedRows.get(id);
			}
			return null;
		},
		querySelectorAll() {
			return [];
		},
		dispatch(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		},
		_selectedRow: (id) => selectedRows.get(id),
	};

	return root;
}

function createDocumentRef(rosterRoot) {
	const listeners = new Map();
	return {
		querySelector(selector) {
			return selector === '[data-chat-roster]' ? rosterRoot : null;
		},
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

function rosterFetch({ entries = [], meId = 1 } = {}) {
	return vi.fn(async (url) => {
		if (String(url).endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		return { ok: true, status: 200, json: async () => ({ data: entries }) };
	});
}

const ENTRIES = [
	{ user_id: 1, username: 'alpha', is_online: false, last_message_preview: null },
	{ user_id: 2, username: 'beta', is_online: false, last_message_preview: 'old' },
];

describe('roster live updates (D04)', () => {
	test('presence snapshot repaints online state without a roster refetch', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const fetchRef = rosterFetch({ entries: ENTRIES });

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();
		const rosterCallsBefore = fetchRef.mock.calls.length;

		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 1, is_online: true }] },
		});

		expect(root._listMount.innerHTML).toContain('data-roster-online="true"');
		// User 1 painted online; no extra fetch was issued for the repaint.
		expect(fetchRef.mock.calls.length).toBe(rosterCallsBefore);
	});

	test('presence update flips a single user without a refetch', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const fetchRef = rosterFetch({ entries: ENTRIES });

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();
		const callsBefore = fetchRef.mock.calls.length;

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 2, isOnline: true },
		});

		expect(root._listMount.innerHTML).toContain('data-roster-user-id="2"');
		expect(root._listMount.innerHTML).toContain('data-roster-online="true"');
		expect(fetchRef.mock.calls.length).toBe(callsBefore);
	});

	test('a dm.message moves the other party to the top and updates the preview', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const fetchRef = rosterFetch({ entries: ENTRIES, meId: 1 });

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();

		// Incoming message from user 2 -> user 2 should float to the top.
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: { message: { sender_id: 2, recipient_id: 1, body: 'fresh preview' } },
		});
		await flushMicrotasks();

		const html = root._listMount.innerHTML;
		const idxUser2 = html.indexOf('data-roster-user-id="2"');
		const idxUser1 = html.indexOf('data-roster-user-id="1"');
		expect(idxUser2).toBeGreaterThanOrEqual(0);
		expect(idxUser2).toBeLessThan(idxUser1);
		expect(html).toContain('fresh preview');
	});

	test('selection highlight is preserved across a live re-render', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const fetchRef = rosterFetch({ entries: ENTRIES });

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();

		// Select user 2 by clicking its row.
		const row = {
			getAttribute: (n) =>
				({
					'data-roster-user-id': '2',
					'data-roster-username': 'beta',
					'data-roster-online': 'false',
				})[n] ?? null,
			setAttribute: vi.fn(),
			classList: { add: vi.fn(), remove: vi.fn() },
			dispatchEvent: vi.fn(),
			closest: (sel) => (sel === '[data-roster-user-id]' ? row : null),
		};
		root.dispatch('click', { target: row });

		// A presence update triggers a re-render; selection must be re-applied
		// by querying the rebuilt row for user 2.
		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 1, isOnline: true },
		});

		const reselected = root._selectedRow(2);
		expect(reselected).toBeTruthy();
		expect(reselected.getAttribute('aria-pressed')).toBe('true');
		expect(reselected._classes.has('is-selected')).toBe(true);
	});
});
