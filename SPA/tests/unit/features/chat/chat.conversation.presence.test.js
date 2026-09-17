import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import { initChatConversation } from '../../../../features/chat/chat.conversation.page.js';

// Issue #50 — "Composer not reactive to presence". The open conversation used to
// freeze `isOnline` at the value the roster row carried when it was clicked, so
// a partner coming online left the composer disabled (and one going offline left
// it enabled) until the user reselected them.

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

function createBadge() {
	const attrs = new Map();
	return {
		textContent: '',
		setAttribute: (name, value) => attrs.set(name, String(value)),
		getAttribute: (name) => attrs.get(name) ?? null,
	};
}

// The composer region is the node the page swaps when presence flips, so the
// test reads its innerHTML to see the composer that was painted.
function createComposerRegion() {
	return { innerHTML: '' };
}

function createInput() {
	return { value: '' };
}

function createActiveRoot({ input }) {
	const attrs = new Map();
	const listeners = new Map();
	const badge = createBadge();
	const region = createComposerRegion();
	const scroll = { innerHTML: '', scrollHeight: 100, scrollTop: 0, querySelector: () => null };
	const errorBanner = {
		textContent: '',
		setAttribute: () => {},
		removeAttribute: () => {},
	};

	return {
		innerHTML: '',
		_badge: badge,
		_region: region,
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		setAttribute: (name, value) => attrs.set(name, String(value)),
		removeAttribute: (name) => attrs.delete(name),
		addEventListener(type, handler) {
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		},
		querySelector(selector) {
			if (selector === '[data-conversation-presence]') return badge;
			if (selector === '[data-conversation-composer-region]') return region;
			if (selector === '[data-conversation-input]') return input;
			if (selector === '[data-conversation-scroll]') return scroll;
			if (selector === '[data-conversation-error]') return errorBanner;
			return null;
		},
		dispatch(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		},
	};
}

function createDocumentRef(activeRoot) {
	const listeners = new Map();
	return {
		dispatched: [],
		querySelector: (selector) => (selector === '[data-chat-active]' ? activeRoot : null),
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
		dispatchEvent(event) {
			this.dispatched.push(event);
			return true;
		},
	};
}

function makeFetch({ meId = 1, onConversation } = {}) {
	return vi.fn(async (url) => {
		if (String(url).endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		onConversation?.();
		return {
			ok: true,
			status: 200,
			json: async () => ({ data: { messages: [], has_more: false } }),
		};
	});
}

async function mount({ onConversation } = {}) {
	const input = createInput();
	const activeRoot = createActiveRoot({ input });
	const documentRef = createDocumentRef(activeRoot);
	const fetchRef = makeFetch({ onConversation });

	initChatConversation({ windowRef: {}, documentRef, fetchRef });
	return { activeRoot, documentRef, fetchRef, input };
}

async function selectUser(documentRef, userId, isOnline) {
	documentRef.dispatch('chat:user-selected', {
		detail: { userId, username: `user-${userId}`, isOnline },
	});
	await flushMicrotasks();
}

describe('open conversation follows live presence (#50)', () => {
	test('a partner coming online enables the composer and flips the badge', async () => {
		const { activeRoot, documentRef } = await mount();
		await selectUser(documentRef, 2, false);

		expect(activeRoot._badge.textContent).toBe('');

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 2, isOnline: true },
		});

		expect(activeRoot._badge.textContent).toBe('online');
		expect(activeRoot._badge.getAttribute('class')).toContain(
			'chat-conversation__presence--online',
		);
		expect(activeRoot._region.innerHTML).toContain('data-conversation-composer');
		expect(activeRoot._region.innerHTML).not.toContain('disabled');
		expect(activeRoot._region.innerHTML).not.toContain('data-conversation-offline');
	});

	test('a partner going offline disables the composer and shows the offline note', async () => {
		const { activeRoot, documentRef } = await mount();
		await selectUser(documentRef, 2, true);

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 2, isOnline: false },
		});

		expect(activeRoot._badge.textContent).toBe('offline');
		expect(activeRoot._badge.getAttribute('class')).toContain(
			'chat-conversation__presence--offline',
		);
		expect(activeRoot._region.innerHTML).toContain('disabled');
		expect(activeRoot._region.innerHTML).toContain('data-conversation-offline');
	});

	test('a presence snapshot drives the open conversation too', async () => {
		const { activeRoot, documentRef } = await mount();
		await selectUser(documentRef, 2, false);

		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 2, is_online: true }] },
		});

		expect(activeRoot._badge.textContent).toBe('online');
	});

	test('text already typed survives the composer swap', async () => {
		const { activeRoot, documentRef, input } = await mount();
		await selectUser(documentRef, 2, true);
		input.value = 'half-written thought';

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 2, isOnline: false },
		});

		expect(input.value).toBe('half-written thought');
		expect(activeRoot._region.innerHTML).toContain('disabled');
	});

	test('a presence change for a different user leaves the open thread alone', async () => {
		const { activeRoot, documentRef } = await mount();
		await selectUser(documentRef, 2, true);

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 9, isOnline: false },
		});

		expect(activeRoot._badge.textContent).toBe('');
		expect(activeRoot._region.innerHTML).toBe('');
	});

	test('a repeated presence frame does not re-render the composer', async () => {
		const { activeRoot, documentRef } = await mount();
		await selectUser(documentRef, 2, true);

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 2, isOnline: true },
		});

		expect(activeRoot._region.innerHTML).toBe('');
	});

	test('presence frames before any selection are ignored', async () => {
		const { activeRoot, documentRef } = await mount();

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 2, isOnline: true },
		});

		expect(activeRoot._region.innerHTML).toBe('');
		expect(activeRoot._badge.textContent).toBe('');
	});

	test('a frame landing while history is in flight wins over the click-time snapshot', async () => {
		let documentRef = null;
		// Fired from inside the history fetch, i.e. after the click but before the
		// conversation is painted — exactly the window the seed must not clobber.
		const mounted = await mount({
			onConversation: () => {
				documentRef?.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
					detail: { userId: 2, isOnline: false },
				});
			},
		});
		documentRef = mounted.documentRef;

		await selectUser(documentRef, 2, true);

		expect(mounted.activeRoot.innerHTML).toContain('chat-conversation__presence--offline');
		expect(mounted.activeRoot.innerHTML).toContain('data-conversation-offline');
	});
});
