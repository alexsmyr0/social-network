import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

function createRow({ userId, username, isOnline }) {
	const attrs = new Map();
	attrs.set('data-roster-user-id', String(userId));
	attrs.set('data-roster-username', username);
	attrs.set('data-roster-online', isOnline ? 'true' : 'false');
	attrs.set('aria-pressed', 'false');

	const classList = new Set();

	const row = {
		_attrs: attrs,
		classList: {
			add: (cls) => classList.add(cls),
			remove: (cls) => classList.delete(cls),
			has: (cls) => classList.has(cls),
		},
		dispatched: [],
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		setAttribute(name, value) {
			attrs.set(name, String(value));
		},
		closest(selector) {
			if (selector === '[data-roster-user-id]') {
				return row;
			}
			return null;
		},
		dispatchEvent(event) {
			row.dispatched.push(event);
			return true;
		},
	};

	return row;
}

function createRosterRoot(rows = []) {
	const attrs = new Map();
	const listeners = new Map();

	const listMount = { innerHTML: '' };

	const root = {
		_attrs: attrs,
		_listeners: listeners,
		_rows: rows,
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
			return null;
		},
		querySelectorAll(selector) {
			if (selector === '[aria-pressed="true"]') {
				return rows.filter((r) => r.getAttribute('aria-pressed') === 'true');
			}
			return [];
		},
		dispatch(type, event) {
			const handlers = listeners.get(type) ?? [];
			for (const handler of handlers) {
				handler(event);
			}
		},
	};

	return root;
}

function createDocumentRef(rosterRoot) {
	return {
		querySelector(selector) {
			if (selector === '[data-chat-roster]') {
				return rosterRoot;
			}
			return null;
		},
	};
}

const baseRefs = () => ({
	windowRef: {},
	documentRef: null,
	fetchRef: null,
});

describe('initChatRoster', () => {
	test('returns null when [data-chat-roster] is absent', () => {
		const refs = baseRefs();
		refs.documentRef = createDocumentRef(null);
		refs.fetchRef = vi.fn();

		const result = initChatRoster(refs);
		expect(result).toBeNull();
		expect(refs.fetchRef).not.toHaveBeenCalled();
	});

	test('returns null when documentRef is missing querySelector', () => {
		const refs = baseRefs();
		refs.documentRef = {};
		refs.fetchRef = vi.fn();

		const result = initChatRoster(refs);
		expect(result).toBeNull();
		expect(refs.fetchRef).not.toHaveBeenCalled();
	});

	test('first call sets data-roster-bound, fetches the roster once, paints; second call is a no-op', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				data: [
					{
						user_id: 1,
						username: 'alpha',
						is_online: true,
						last_message_preview: null,
					},
				],
			}),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();

		// The roster also resolves the signed-in user id (shared session slice), so
		// count roster requests specifically rather than every call.
		const rosterCalls = () =>
			fetchRef.mock.calls.filter(([url]) => String(url).endsWith('/chats')).length;

		expect(root.getAttribute('data-roster-bound')).toBe('true');
		expect(rosterCalls()).toBe(1);
		expect(root._listMount.innerHTML).toContain('data-roster-user-id="1"');

		const second = initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();
		expect(second).toBeNull();
		expect(rosterCalls()).toBe(1);
	});

	test('paints the empty-state paragraph when the roster is empty', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		await flushMicrotasks();

		expect(root._listMount.innerHTML).toContain('No other users yet');
		expect(root._listMount.innerHTML).not.toContain('<li');
	});

	test('clicking an offline row emits chat:user-selected with isOnline:false', () => {
		const offlineRow = createRow({ userId: 21, username: 'sam', isOnline: false });
		const root = createRosterRoot([offlineRow]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		root.dispatch('click', { target: offlineRow });

		expect(offlineRow.dispatched).toHaveLength(1);
		const event = offlineRow.dispatched[0];
		expect(event.type).toBe('chat:user-selected');
		expect(event.detail).toEqual({ userId: 21, username: 'sam', isOnline: false });
		expect(event.bubbles).toBe(true);
	});

	test('clicking an online row emits chat:user-selected with isOnline:true', () => {
		const onlineRow = createRow({ userId: 12, username: 'maria', isOnline: true });
		const root = createRosterRoot([onlineRow]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		root.dispatch('click', { target: onlineRow });

		expect(onlineRow.dispatched).toHaveLength(1);
		expect(onlineRow.dispatched[0].detail).toEqual({
			userId: 12,
			username: 'maria',
			isOnline: true,
		});
	});

	test('keyboard Enter on a focused row emits the selection event', () => {
		const row = createRow({ userId: 5, username: 'kim', isOnline: true });
		const root = createRosterRoot([row]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });

		const preventDefault = vi.fn();
		root.dispatch('keydown', { key: 'Enter', target: row, preventDefault });

		expect(row.dispatched).toHaveLength(1);
		expect(row.dispatched[0].detail.userId).toBe(5);
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	test('keyboard Space on a focused row emits the selection event', () => {
		const row = createRow({ userId: 6, username: 'lou', isOnline: false });
		const root = createRosterRoot([row]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		root.dispatch('keydown', { key: ' ', target: row, preventDefault: vi.fn() });

		expect(row.dispatched).toHaveLength(1);
	});

	test('keyboard keys other than Enter/Space do not emit selection events', () => {
		const row = createRow({ userId: 7, username: 'noemi', isOnline: true });
		const root = createRosterRoot([row]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });
		root.dispatch('keydown', { key: 'Tab', target: row, preventDefault: vi.fn() });

		expect(row.dispatched).toHaveLength(0);
	});

	test('aria-pressed flips on selected row and clears on siblings', () => {
		const a = createRow({ userId: 1, username: 'a', isOnline: true });
		const b = createRow({ userId: 2, username: 'b', isOnline: true });
		const root = createRosterRoot([a, b]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });

		root.dispatch('click', { target: a });
		expect(a.getAttribute('aria-pressed')).toBe('true');
		expect(a.classList.has('is-selected')).toBe(true);
		expect(b.getAttribute('aria-pressed')).toBe('false');
		expect(b.classList.has('is-selected')).toBe(false);

		root.dispatch('click', { target: b });
		expect(a.getAttribute('aria-pressed')).toBe('false');
		expect(a.classList.has('is-selected')).toBe(false);
		expect(b.getAttribute('aria-pressed')).toBe('true');
		expect(b.classList.has('is-selected')).toBe(true);
	});

	test('clicks on non-row elements are ignored', () => {
		const root = createRosterRoot([]);
		const documentRef = createDocumentRef(root);
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		initChatRoster({ windowRef: {}, documentRef, fetchRef });

		const stray = {
			closest(selector) {
				if (selector === '[data-roster-user-id]') {
					return null;
				}
				return null;
			},
		};

		expect(() => root.dispatch('click', { target: stray })).not.toThrow();
	});
});
