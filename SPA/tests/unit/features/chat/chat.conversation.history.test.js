import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetAppState } from '../../../../core/state/app-state.js';
import { initChatConversation } from '../../../../features/chat/chat.conversation.page.js';

// The session/presence slices are one module-level store shared by every slice
// (issue #76), so each case starts from a clean slot set rather than inheriting
// the previous one's identity and presence.
beforeEach(() => {
	resetAppState();
});

async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) {
		await Promise.resolve();
	}
}

// A real element clamps scrollTop to [0, scrollHeight - clientHeight]. The mock
// used to store whatever it was given, which hid the case that matters here: a
// thread too short to overflow has a maximum scrollTop of 0, so it cannot be
// scrolled and cannot be pinned to its bottom either. clientHeight defaults to
// 0, i.e. "freely scrollable", which is what most cases below want.
function createScrollEl({ scrollHeight = 1000, scrollTop = 0, clientHeight = 0 } = {}) {
	const listeners = new Map();
	let top = scrollTop;
	return {
		scrollHeight,
		clientHeight,
		get scrollTop() {
			const max = Math.max(0, this.scrollHeight - this.clientHeight);
			return Math.min(Math.max(top, 0), max);
		},
		set scrollTop(value) {
			top = value;
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

// List mock: prepending grows the scroll container, like real prepended nodes.
function createListEl(scrollEl, growthPerPrepend = 300) {
	return {
		chunks: [],
		insertAdjacentHTML(position, html) {
			this.chunks.push({ position, html });
			scrollEl.scrollHeight += growthPerPrepend;
		},
	};
}

function createActiveRoot(scrollEl, listEl) {
	const attrs = new Map();
	const listeners = new Map();
	return {
		innerHTML: '',
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
			if (selector === '[data-conversation-scroll]') {
				return scrollEl;
			}
			if (selector === '[data-conversation-messages]') {
				return listEl;
			}
			return null;
		},
	};
}

function createDocumentRef(activeRoot) {
	const listeners = new Map();
	return {
		querySelector(selector) {
			return selector === '[data-chat-active]' ? activeRoot : null;
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

function msg(id) {
	return {
		id,
		sender_id: 2,
		sender_username: 'bob',
		body: `m${id}`,
		created_at: '2026-01-01T00:00:00Z',
	};
}

function makePagingFetch({ meId = 1, initial, older }) {
	return vi.fn(async (url) => {
		const u = String(url);
		if (u.endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		if (u.includes('before_id=')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: { messages: older.messages, has_more: older.hasMore } }),
			};
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: { messages: initial.messages, has_more: initial.hasMore } }),
		};
	});
}

async function selectUser(documentRef, { userId = 2, username = 'bob', isOnline = true } = {}) {
	documentRef.dispatch('chat:user-selected', { detail: { userId, username, isOnline } });
	await flushMicrotasks();
}

// A thread opens pinned to its NEWEST message, so reaching older history always
// means scrolling up first. These cases used to dispatch a bare `scroll` on a
// container left at scrollTop 0, which quietly encoded the bug: in a real
// browser a container already at the top emits no scroll event at all, so
// incremental loading was unreachable. Drive the scroll-up explicitly.
function scrollUpTo(scrollEl, scrollTop = 0) {
	scrollEl.scrollTop = scrollTop;
	scrollEl.dispatch('scroll');
}

// An upward wheel over the thread. This is the only signal available when the
// batch is too short to overflow the panel, because a container that cannot
// move emits no `scroll` event at all.
function wheelUp(scrollEl) {
	scrollEl.dispatch('wheel', { deltaY: -120 });
}

describe('incremental history loading', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// The defect this guards: the thread rendered but was never scrolled, so it
	// opened at scrollTop 0 showing the OLDEST of the 10. A container already at
	// the top cannot scroll up, so it never emitted a `scroll` event and older
	// history was unreachable by normal use. Every case below depends on this.
	test('opens pinned to the newest message so scrolling up is possible', async () => {
		const scrollEl = createScrollEl({ scrollHeight: 1000, scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: [], hasMore: false };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		expect(scrollEl.scrollTop).toBe(scrollEl.scrollHeight);
	});

	// The panel is taller than 10 short messages on any large screen, so
	// scrollHeight === clientHeight and no `scroll` event is ever emitted.
	// Measured on a 1080p viewport: 772px of content in a 772px box. Without a
	// wheel fallback, older history is unreachable no matter how hard the user
	// scrolls — it only started working once enough messages arrived to overflow.
	test('an upward wheel pages history even when the thread cannot scroll', async () => {
		// scrollHeight === clientHeight: nothing to scroll.
		const scrollEl = createScrollEl({ scrollHeight: 772, scrollTop: 0, clientHeight: 772 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: false };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		// No scroll event is possible here, so only the wheel can drive paging.
		wheelUp(scrollEl);
		await flushMicrotasks();

		const olderCall = fetchRef.mock.calls.find(([url]) => String(url).includes('before_id='));
		expect(olderCall?.[0]).toBe('/api/v1/chats/2/messages?before_id=11');
		expect(listEl.chunks).toHaveLength(1);
		expect(listEl.chunks[0].html.match(/data-message-id/g)).toHaveLength(10);
	});

	test('a downward wheel does not page history', async () => {
		const scrollEl = createScrollEl({ scrollHeight: 772, scrollTop: 0, clientHeight: 772 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: true };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		// Reading downwards must not drag in older history, and in a thread that
		// cannot scroll every wheel sees scrollTop 0, so direction is the only
		// thing separating the two gestures.
		scrollEl.dispatch('wheel', { deltaY: 120 });
		await flushMicrotasks();

		const olderCalls = fetchRef.mock.calls.filter(([url]) => String(url).includes('before_id='));
		expect(olderCalls).toHaveLength(0);
	});

	test('a scroll and a wheel from one gesture cost a single request', async () => {
		const scrollEl = createScrollEl({ scrollHeight: 1000, scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: true };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		// A real wheel-up over a scrollable thread fires both events; the shared
		// throttle must coalesce them rather than paging twice. The user has
		// already reached the top, which is when paging is armed.
		scrollEl.scrollTop = 0;
		for (let i = 0; i < 10; i += 1) {
			wheelUp(scrollEl);
			scrollEl.dispatch('scroll');
		}
		await flushMicrotasks();

		const olderCalls = fetchRef.mock.calls.filter(([url]) => String(url).includes('before_id='));
		expect(olderCalls).toHaveLength(1);
	});

	test('scrolling to the top loads the next batch of 10 with before_id', async () => {
		const scrollEl = createScrollEl({ scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: false };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		scrollUpTo(scrollEl);
		await flushMicrotasks();

		// Oldest rendered id was 11, so the older page must be requested with before_id=11.
		const olderCall = fetchRef.mock.calls.find(([url]) => String(url).includes('before_id='));
		expect(olderCall?.[0]).toBe('/api/v1/chats/2/messages?before_id=11');
		expect(listEl.chunks).toHaveLength(1);
		expect(listEl.chunks[0].position).toBe('afterbegin');
		// 10 prepended items.
		expect(listEl.chunks[0].html.match(/data-message-id/g)).toHaveLength(10);
	});

	test('repeated scroll events do not cause burst requests', async () => {
		const scrollEl = createScrollEl({ scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: true };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		for (let i = 0; i < 25; i += 1) {
			scrollUpTo(scrollEl);
		}
		await flushMicrotasks();

		const olderCalls = fetchRef.mock.calls.filter(([url]) => String(url).includes('before_id='));
		expect(olderCalls).toHaveLength(1);
	});

	test('preserves scroll position when older history is prepended', async () => {
		const scrollEl = createScrollEl({ scrollHeight: 1000, scrollTop: 5 });
		const listEl = createListEl(scrollEl, 300);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: false };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		scrollUpTo(scrollEl, 5);
		await flushMicrotasks();

		// previousTop(5) + (newHeight 1300 - previousHeight 1000) = 305
		expect(scrollEl.scrollTop).toBe(305);
	});

	test('does not request older history when the backend reports none', async () => {
		const scrollEl = createScrollEl({ scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: [msg(1), msg(2)], hasMore: false };
		const older = { messages: [], hasMore: false };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		scrollUpTo(scrollEl);
		await flushMicrotasks();

		const olderCalls = fetchRef.mock.calls.filter(([url]) => String(url).includes('before_id='));
		expect(olderCalls).toHaveLength(0);
	});

	test('does not load when the viewport is not near the top', async () => {
		const scrollEl = createScrollEl({ scrollHeight: 1000, scrollTop: 500 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: true };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		// Mid-thread, out of the 80px threshold's reach.
		scrollUpTo(scrollEl, 500);
		await flushMicrotasks();

		const olderCalls = fetchRef.mock.calls.filter(([url]) => String(url).includes('before_id='));
		expect(olderCalls).toHaveLength(0);
	});

	// #52: before the fix, fetchConversation returned { messages: [], hasMore:
	// false } for a transient failure too, so the first failed older-history
	// fetch set hasMore=false and froze all future scroll-up loads. Now a
	// transient failure leaves hasMore intact so a later scroll retries.
	test('a transient older-history failure does not permanently block scroll-up', async () => {
		const scrollEl = createScrollEl({ scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: false };

		let olderCalls = 0;
		const fetchRef = vi.fn(async (url) => {
			const u = String(url);
			if (u.endsWith('/users/me')) {
				return { ok: true, status: 200, json: async () => ({ data: { id: 1 } }) };
			}
			if (u.includes('before_id=')) {
				olderCalls += 1;
				if (olderCalls === 1) {
					// First attempt fails transiently (server error).
					return { ok: false, status: 500, json: async () => ({}) };
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ data: { messages: older.messages, has_more: older.hasMore } }),
				};
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: { messages: initial.messages, has_more: initial.hasMore } }),
			};
		});

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		// First scroll: older fetch fails; nothing prepended, but paging stays enabled.
		scrollUpTo(scrollEl);
		await flushMicrotasks();
		expect(listEl.chunks).toHaveLength(0);

		// Let the throttle cooldown lapse, then scroll again: the retry succeeds.
		vi.advanceTimersByTime(500);
		await flushMicrotasks();
		scrollUpTo(scrollEl);
		await flushMicrotasks();

		expect(olderCalls).toBe(2);
		expect(listEl.chunks).toHaveLength(1);
	});

	// Issue #50 — "Orphaned isLoading on conversation switch". Switching threads
	// while an older-history request is in flight must not leak the abandoned
	// batch into the new thread, nor leave the new thread wedged as "loading".
	test('switching conversations mid-load discards the in-flight batch and keeps paging alive', async () => {
		// Each render swaps in a fresh scroll/list pair, the way the real
		// innerHTML replacement does, so the two threads cannot share nodes.
		const panels = [];
		function newPanel() {
			const scrollEl = createScrollEl({ scrollTop: 0 });
			const panel = { scrollEl, listEl: createListEl(scrollEl) };
			panels.push(panel);
			return panel;
		}

		let panel = newPanel();
		const attrs = new Map();
		const listeners = new Map();
		const activeRoot = {
			get innerHTML() {
				return '';
			},
			set innerHTML(_value) {
				panel = newPanel();
			},
			getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
			setAttribute: (name, value) => attrs.set(name, String(value)),
			addEventListener(type, handler) {
				if (!listeners.has(type)) {
					listeners.set(type, []);
				}
				listeners.get(type).push(handler);
			},
			querySelector(selector) {
				if (selector === '[data-conversation-scroll]') return panel.scrollEl;
				if (selector === '[data-conversation-messages]') return panel.listEl;
				return null;
			},
		};
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		let releaseFirstOlder = null;
		let olderCalls = 0;

		const fetchRef = vi.fn(async (url) => {
			const u = String(url);
			if (u.endsWith('/users/me')) {
				return { ok: true, status: 200, json: async () => ({ data: { id: 1 } }) };
			}
			if (u.includes('before_id=')) {
				olderCalls += 1;
				const body = {
					ok: true,
					status: 200,
					json: async () => ({ data: { messages: [msg(1)], has_more: true } }),
				};
				if (olderCalls === 1) {
					// Held open so the conversation switch happens mid-flight.
					return await new Promise((resolve) => {
						releaseFirstOlder = () => resolve(body);
					});
				}
				return body;
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: { messages: initial.messages, has_more: initial.hasMore } }),
			};
		});

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, { userId: 2 });

		const first = panel;
		scrollUpTo(first.scrollEl);
		await flushMicrotasks();
		expect(olderCalls).toBe(1);

		// Switch threads while that batch is still pending, then let it land.
		vi.advanceTimersByTime(500);
		await selectUser(documentRef, { userId: 3, username: 'carol' });
		const second = panel;
		expect(second).not.toBe(first);

		releaseFirstOlder();
		await flushMicrotasks();

		// The abandoned batch went nowhere near the newly opened thread.
		expect(second.listEl.chunks).toHaveLength(0);

		// And the new thread is not wedged: scrolling up still pages.
		vi.advanceTimersByTime(500);
		scrollUpTo(second.scrollEl);
		await flushMicrotasks();

		expect(olderCalls).toBe(2);
		expect(second.listEl.chunks).toHaveLength(1);
	});

	test('stops paging once a batch reports has_more=false', async () => {
		const scrollEl = createScrollEl({ scrollTop: 0 });
		const listEl = createListEl(scrollEl);
		const activeRoot = createActiveRoot(scrollEl, listEl);
		const documentRef = createDocumentRef(activeRoot);

		const initial = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 11)), hasMore: true };
		const older = { messages: Array.from({ length: 10 }, (_, i) => msg(i + 1)), hasMore: false };
		const fetchRef = makePagingFetch({ initial, older });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef);

		// First scroll consumes the only older batch (has_more=false afterwards).
		scrollUpTo(scrollEl);
		await flushMicrotasks();
		// Let the throttle cooldown lapse so a later scroll is a fresh leading call.
		vi.advanceTimersByTime(500);
		await flushMicrotasks();

		scrollUpTo(scrollEl);
		await flushMicrotasks();

		const olderCalls = fetchRef.mock.calls.filter(([url]) => String(url).includes('before_id='));
		expect(olderCalls).toHaveLength(1);
	});
});
