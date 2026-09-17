import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import { initChatRoster } from '../../../../features/chat/chat.roster.page.js';

// Issue #50 — "New users never enter a loaded roster". Presence and dm frames
// name user ids; a user who registered after this roster was fetched has no row,
// and the pure helpers deliberately leave unknown ids untouched. Without a
// refetch such a user stayed invisible until a full page reload.

const originalCustomEvent = globalThis.CustomEvent;

async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

beforeEach(() => {
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
});

function createRosterRoot() {
	const attrs = new Map();
	const listeners = new Map();
	const listMount = { innerHTML: '' };

	return {
		_listMount: listMount,
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		setAttribute: (name, value) => attrs.set(name, String(value)),
		addEventListener(type, handler) {
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		},
		querySelector: (selector) => (selector === '#roster-list' ? listMount : null),
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

// Captures the debounce callback instead of running it, so a test controls
// exactly when (and how often) the refetch fires.
function createDeferredTimer() {
	const pending = [];
	const setTimeoutRef = vi.fn((callback) => {
		pending.push(callback);
		return pending.length;
	});
	return {
		setTimeoutRef,
		scheduled: () => pending.length,
		flush() {
			const queued = pending.splice(0, pending.length);
			for (const callback of queued) {
				callback();
			}
		},
	};
}

const INITIAL = [{ user_id: 1, username: 'alpha', is_online: false, last_message_preview: null }];
const WITH_NEWCOMER = [
	...INITIAL,
	{ user_id: 7, username: 'newcomer', is_online: true, last_message_preview: null },
];

// Serves `/chats` from a queue of payloads, repeating the last one once drained.
function rosterFetch({ pages = [INITIAL], meId = 1 } = {}) {
	const queue = [...pages];
	return vi.fn(async (url) => {
		if (String(url).endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		const data = queue.length > 1 ? queue.shift() : queue[0];
		return { ok: true, status: 200, json: async () => ({ data }) };
	});
}

async function mount({ pages, meId = 1 } = {}) {
	const root = createRosterRoot();
	const documentRef = createDocumentRef(root);
	const fetchRef = rosterFetch({ pages, meId });
	const timer = createDeferredTimer();

	initChatRoster({ windowRef: {}, documentRef, fetchRef, setTimeoutRef: timer.setTimeoutRef });
	await flushMicrotasks();

	const rosterCalls = () =>
		fetchRef.mock.calls.filter(([url]) => String(url).endsWith('/chats')).length;

	return { root, documentRef, fetchRef, timer, rosterCalls };
}

describe('admitting users who are not in the loaded roster (#50)', () => {
	test('a presence frame for an unknown user refetches and paints their row', async () => {
		const { root, documentRef, timer, rosterCalls } = await mount({
			pages: [INITIAL, WITH_NEWCOMER],
		});

		expect(root._listMount.innerHTML).not.toContain('data-roster-user-id="7"');

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 7, isOnline: true } });
		expect(timer.scheduled()).toBe(1);

		timer.flush();
		await flushMicrotasks();

		expect(rosterCalls()).toBe(2);
		expect(root._listMount.innerHTML).toContain('data-roster-user-id="7"');
		expect(root._listMount.innerHTML).toContain('newcomer');
	});

	test('a dm from an unknown user also admits them', async () => {
		const { root, documentRef, timer } = await mount({ pages: [INITIAL, WITH_NEWCOMER] });

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: { message: { sender_id: 7, recipient_id: 1, body: 'hello stranger' } },
		});
		await flushMicrotasks();

		timer.flush();
		await flushMicrotasks();

		expect(root._listMount.innerHTML).toContain('data-roster-user-id="7"');
	});

	test('a burst of unknown users costs exactly one refetch', async () => {
		const { documentRef, timer, rosterCalls } = await mount({ pages: [INITIAL, WITH_NEWCOMER] });

		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: {
				users: [
					{ user_id: 7, is_online: true },
					{ user_id: 8, is_online: true },
					{ user_id: 9, is_online: true },
				],
			},
		});

		expect(timer.scheduled()).toBe(1);
		timer.flush();
		await flushMicrotasks();

		expect(rosterCalls()).toBe(2);
	});

	test('a user who already has a row never triggers a refetch', async () => {
		const { documentRef, timer, rosterCalls } = await mount();

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 1, isOnline: true } });

		expect(timer.scheduled()).toBe(0);
		expect(rosterCalls()).toBe(1);
	});

	test("the viewer's own presence never triggers a refetch", async () => {
		// The viewer is online but is deliberately absent from their own roster,
		// so treating them as a stranger would refetch forever.
		const { documentRef, timer, rosterCalls } = await mount({ meId: 5 });

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 5, isOnline: true } });

		expect(timer.scheduled()).toBe(0);
		expect(rosterCalls()).toBe(1);
	});

	test('an id still missing after a refetch does not schedule another one', async () => {
		const { documentRef, timer, rosterCalls } = await mount({ pages: [INITIAL] });

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 7, isOnline: true } });
		timer.flush();
		await flushMicrotasks();
		expect(rosterCalls()).toBe(2);

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 7, isOnline: false } });
		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 7, isOnline: true } });

		expect(timer.scheduled()).toBe(0);
		expect(rosterCalls()).toBe(2);
	});

	test('a failed refetch leaves the painted rows alone', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const timer = createDeferredTimer();
		let rosterCalls = 0;
		const fetchRef = vi.fn(async (url) => {
			if (String(url).endsWith('/users/me')) {
				return { ok: true, status: 200, json: async () => ({ data: { id: 1 } }) };
			}
			rosterCalls += 1;
			if (rosterCalls === 1) {
				return { ok: true, status: 200, json: async () => ({ data: INITIAL }) };
			}
			return { ok: false, status: 500, json: async () => ({}) };
		});

		initChatRoster({ windowRef: {}, documentRef, fetchRef, setTimeoutRef: timer.setTimeoutRef });
		await flushMicrotasks();

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, { detail: { userId: 7, isOnline: true } });
		timer.flush();
		await flushMicrotasks();

		expect(rosterCalls).toBe(2);
		expect(root._listMount.innerHTML).toContain('data-roster-user-id="1"');
	});

	test('an unknown user dropping offline is admitted too', async () => {
		const { root, documentRef, timer } = await mount({ pages: [INITIAL, WITH_NEWCOMER] });

		// Online first (admitted), then offline again — the second frame must not
		// be the only one that ever names them.
		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 7, is_online: true }] },
		});
		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, { detail: { users: [] } });

		timer.flush();
		await flushMicrotasks();

		expect(root._listMount.innerHTML).toContain('data-roster-user-id="7"');
	});
});

describe('presence seen before the viewer is identified (#50)', () => {
	// GET /users/me and GET /chats race on boot. Until the identity lands, the
	// viewer's OWN id looks exactly like a stranger's — and the viewer is online
	// but deliberately absent from their own roster, so acting on that guess
	// would cost a pointless refetch on every single page load.
	function createSlowIdentity({ meId = 5 } = {}) {
		let releaseIdentity = null;
		const identity = new Promise((resolve) => {
			releaseIdentity = () =>
				resolve({ ok: true, status: 200, json: async () => ({ data: { id: meId } }) });
		});

		const fetchRef = vi.fn(async (url) => {
			if (String(url).endsWith('/users/me')) {
				return await identity;
			}
			return { ok: true, status: 200, json: async () => ({ data: INITIAL }) };
		});

		return { fetchRef, release: () => releaseIdentity() };
	}

	test("the viewer's own presence during that window never schedules a refetch", async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const timer = createDeferredTimer();
		const { fetchRef, release } = createSlowIdentity({ meId: 5 });

		initChatRoster({ windowRef: {}, documentRef, fetchRef, setTimeoutRef: timer.setTimeoutRef });
		await flushMicrotasks();

		// The snapshot lists the viewer (5) while their identity is still pending.
		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 5, is_online: true }] },
		});
		expect(timer.scheduled()).toBe(0);

		release();
		await flushMicrotasks();

		// Replaying the known presence after identity resolves still skips self.
		expect(timer.scheduled()).toBe(0);
		expect(fetchRef.mock.calls.filter(([url]) => String(url).endsWith('/chats'))).toHaveLength(1);
	});

	test('a stranger seen during that window is replayed once identity resolves', async () => {
		const root = createRosterRoot();
		const documentRef = createDocumentRef(root);
		const timer = createDeferredTimer();
		const { fetchRef, release } = createSlowIdentity({ meId: 5 });

		initChatRoster({ windowRef: {}, documentRef, fetchRef, setTimeoutRef: timer.setTimeoutRef });
		await flushMicrotasks();

		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 7, is_online: true }] },
		});
		// Deferred, not dropped: the identity is not known yet.
		expect(timer.scheduled()).toBe(0);

		release();
		await flushMicrotasks();

		expect(timer.scheduled()).toBe(1);
	});
});
