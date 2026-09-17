import { beforeEach, describe, expect, test, vi } from 'vitest';
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

function createActiveRoot() {
	const attrs = new Map();
	const listeners = new Map();

	return {
		innerHTML: '',
		_listeners: listeners,
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		setAttribute(name, value) {
			attrs.set(name, String(value));
		},
		removeAttribute(name) {
			attrs.delete(name);
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

// Minimal stand-in for the roster panel so the conversation page can toggle
// its `hidden` attribute when swapping between the list and an open thread.
function createRosterRoot() {
	const attrs = new Map();
	return {
		getAttribute(name) {
			return attrs.has(name) ? attrs.get(name) : null;
		},
		setAttribute(name, value) {
			attrs.set(name, String(value));
		},
		removeAttribute(name) {
			attrs.delete(name);
		},
	};
}

function createDocumentRef(activeRoot, rosterRoot = null) {
	const listeners = new Map();
	return {
		_listeners: listeners,
		querySelector(selector) {
			if (selector === '[data-chat-active]') {
				return activeRoot;
			}
			if (selector === '[data-chat-roster]') {
				return rosterRoot;
			}
			return null;
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

function createWindowRef({ splitLayout = false } = {}) {
	return {
		matchMedia: vi.fn(() => ({ matches: splitLayout })),
	};
}

function makeFetch({ meId = 1, messages = [], hasMore = false } = {}) {
	return vi.fn(async (url) => {
		if (String(url).endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: { messages, has_more: hasMore } }),
		};
	});
}

describe('initChatConversation', () => {
	test('returns null when [data-chat-active] is absent', () => {
		const documentRef = createDocumentRef(null);
		const result = initChatConversation({ windowRef: {}, documentRef, fetchRef: vi.fn() });
		expect(result).toBeNull();
	});

	test('returns null when documentRef lacks addEventListener', () => {
		const result = initChatConversation({
			windowRef: {},
			documentRef: { querySelector: () => createActiveRoot() },
			fetchRef: vi.fn(),
		});
		expect(result).toBeNull();
	});

	test('binds once; a second init on the same root is a no-op', () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch();

		const first = initChatConversation({ windowRef: {}, documentRef, fetchRef });
		expect(first).not.toBeNull();
		expect(activeRoot.getAttribute('data-conversation-bound')).toBe('true');

		const second = initChatConversation({ windowRef: {}, documentRef, fetchRef });
		expect(second).toBeNull();
	});

	test('selecting a user renders that conversation with sender and timestamp', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({
			meId: 1,
			messages: [
				{
					id: 5,
					sender_id: 2,
					sender_username: 'bob',
					body: 'yo',
					created_at: '2026-01-01T00:00:00Z',
				},
			],
		});

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 2, username: 'bob', isOnline: true },
		});
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toContain('bob');
		expect(activeRoot.innerHTML).toContain('yo');
		expect(activeRoot.innerHTML).toContain('data-conversation-composer');
		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/chats/2/messages',
			expect.objectContaining({ credentials: 'include' }),
		);
	});

	test('selecting a user shows the conversation and hides the roster; back reverses it', async () => {
		const activeRoot = createActiveRoot();
		const rosterRoot = createRosterRoot();
		// Shell renders the conversation panel hidden by default.
		activeRoot.setAttribute('hidden', '');
		const documentRef = createDocumentRef(activeRoot, rosterRoot);
		const fetchRef = makeFetch({ meId: 1, messages: [] });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 2, username: 'bob', isOnline: true },
		});
		await flushMicrotasks();

		// Conversation shown, roster hidden.
		expect(activeRoot.getAttribute('hidden')).toBeNull();
		expect(rosterRoot.getAttribute('hidden')).toBe('');

		// Click the in-header back arrow.
		activeRoot.dispatch('click', {
			target: { closest: (sel) => (sel === '[data-conversation-back]' ? {} : null) },
		});

		// Roster shown again, conversation hidden.
		expect(activeRoot.getAttribute('hidden')).toBe('');
		expect(rosterRoot.getAttribute('hidden')).toBeNull();
	});

	test('desktop split layout keeps both roster and conversation panels visible', async () => {
		const activeRoot = createActiveRoot();
		const rosterRoot = createRosterRoot();
		activeRoot.setAttribute('hidden', '');
		const documentRef = createDocumentRef(activeRoot, rosterRoot);
		const fetchRef = makeFetch({ meId: 1, messages: [] });

		initChatConversation({
			windowRef: createWindowRef({ splitLayout: true }),
			documentRef,
			fetchRef,
		});

		expect(activeRoot.getAttribute('hidden')).toBeNull();
		expect(rosterRoot.getAttribute('hidden')).toBeNull();

		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 2, username: 'bob', isOnline: true },
		});
		await flushMicrotasks();

		expect(activeRoot.getAttribute('hidden')).toBeNull();
		expect(rosterRoot.getAttribute('hidden')).toBeNull();

		activeRoot.dispatch('click', {
			target: { closest: (sel) => (sel === '[data-conversation-back]' ? {} : null) },
		});

		expect(activeRoot.getAttribute('hidden')).toBeNull();
		expect(rosterRoot.getAttribute('hidden')).toBeNull();
	});

	test('selecting a user with no history renders the empty state', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ messages: [] });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 3, username: 'sam', isOnline: true },
		});
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toContain('data-conversation-empty');
	});

	test('selecting an offline user disables the composer but still shows history', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({
			meId: 1,
			messages: [
				{
					id: 9,
					sender_id: 4,
					sender_username: 'kim',
					body: 'older',
					created_at: '2026-01-01T00:00:00Z',
				},
			],
		});

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 4, username: 'kim', isOnline: false },
		});
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toContain('older');
		expect(activeRoot.innerHTML).toContain('disabled');
		expect(activeRoot.innerHTML).toContain('data-conversation-offline');
	});

	test('ignores selection events without a valid user id', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch();

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 0, username: 'x', isOnline: true },
		});
		await flushMicrotasks();

		expect(activeRoot.innerHTML).toBe('');
		expect(fetchRef).not.toHaveBeenCalled();
	});

	test('fetches the current user id only once across selections', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 2, username: 'a', isOnline: true },
		});
		await flushMicrotasks();
		documentRef.dispatch('chat:user-selected', {
			detail: { userId: 3, username: 'b', isOnline: true },
		});
		await flushMicrotasks();

		const meCalls = fetchRef.mock.calls.filter(([url]) => String(url).endsWith('/users/me'));
		expect(meCalls).toHaveLength(1);
	});

	test('composer submit is prevented from navigating', () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch();

		initChatConversation({ windowRef: {}, documentRef, fetchRef });

		const preventDefault = vi.fn();
		activeRoot.dispatch('submit', {
			target: { closest: (sel) => (sel === '[data-conversation-composer]' ? {} : null) },
			preventDefault,
		});
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});
});
