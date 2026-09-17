import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import {
	initChatConversation,
	SEND_MESSAGE_EVENT,
} from '../../../../features/chat/chat.conversation.page.js';

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

// A messages-list stub that records appended HTML so live appends are visible.
function createMessagesList() {
	return {
		appended: [],
		insertAdjacentHTML(_position, html) {
			this.appended.push(html);
		},
	};
}

// Scroll region wrapping the messages list, with a scrollHeight/scrollTop pair
// so the page's "pin to bottom" behaviour can be asserted.
function createScroll(messagesList) {
	return {
		innerHTML: '',
		scrollHeight: 500,
		scrollTop: 0,
		querySelector(selector) {
			return selector === '[data-conversation-messages]' ? messagesList : null;
		},
	};
}

function createErrorBanner() {
	const attrs = new Map([['hidden', '']]);
	return {
		textContent: '',
		setAttribute: (n, v) => attrs.set(n, String(v)),
		removeAttribute: (n) => attrs.delete(n),
		isHidden: () => attrs.has('hidden'),
	};
}

function createActiveRoot() {
	const attrs = new Map();
	const listeners = new Map();
	const messagesList = createMessagesList();
	const scroll = createScroll(messagesList);
	const errorBanner = createErrorBanner();

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
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		},
		querySelector(selector) {
			if (selector === '[data-conversation-scroll]') {
				return scroll;
			}
			if (selector === '[data-conversation-error]') {
				return errorBanner;
			}
			return null;
		},
		dispatch(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		},
	};

	return root;
}

function createDocumentRef(activeRoot) {
	const listeners = new Map();
	return {
		dispatched: [],
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
		dispatchEvent(event) {
			this.dispatched.push(event);
			// A real document runs its listeners synchronously during dispatch.
			// The composer depends on that: the app shell's send listener flips
			// `detail.accepted` before the composer decides whether it is safe to
			// clear what the user typed.
			for (const handler of listeners.get(event?.type) ?? []) {
				handler(event);
			}
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

function makeFetch({ meId = 1, messages = [] } = {}) {
	return vi.fn(async (url) => {
		if (String(url).endsWith('/users/me')) {
			return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
		}
		return { ok: true, status: 200, json: async () => ({ data: { messages, has_more: false } }) };
	});
}

async function selectUser(documentRef, userId, username = 'bob', isOnline = true) {
	documentRef.dispatch('chat:user-selected', { detail: { userId, username, isOnline } });
	await flushMicrotasks();
}

describe('conversation composer submit (D04)', () => {
	test('submit dispatches chat:send-message with {recipientId, body} and clears the input', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		acceptSends(documentRef);
		await selectUser(documentRef, 2);

		const input = { value: '  hello there  ' };
		const composer = {
			querySelector: (sel) => (sel === '[data-conversation-input]' ? input : null),
		};
		const preventDefault = vi.fn();
		activeRoot.dispatch('submit', {
			target: { closest: (sel) => (sel === '[data-conversation-composer]' ? composer : null) },
			preventDefault,
		});

		expect(preventDefault).toHaveBeenCalledTimes(1);
		const sendEvents = documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT);
		expect(sendEvents).toHaveLength(1);
		expect(sendEvents[0].detail).toEqual({ recipientId: 2, body: 'hello there', accepted: true });
		expect(input.value).toBe('');
	});

	// The composer used to clear itself the instant it dispatched, before
	// anything knew whether the frame had left the client. A closed socket
	// therefore destroyed what the user had typed and left them nothing to
	// retry with.
	test('a rejected send keeps the typed message so it can be retried', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		acceptSends(documentRef, false);
		await selectUser(documentRef, 2);

		const input = { value: 'this must survive' };
		const composer = {
			querySelector: (sel) => (sel === '[data-conversation-input]' ? input : null),
		};
		activeRoot.dispatch('submit', {
			target: { closest: (sel) => (sel === '[data-conversation-composer]' ? composer : null) },
			preventDefault: vi.fn(),
		});

		expect(documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT)).toHaveLength(1);
		expect(input.value).toBe('this must survive');
	});

	test('submit with an empty body does not dispatch and leaves nothing sent', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, 2);

		const input = { value: '   ' };
		const composer = {
			querySelector: (sel) => (sel === '[data-conversation-input]' ? input : null),
		};
		activeRoot.dispatch('submit', {
			target: { closest: (sel) => (sel === '[data-conversation-composer]' ? composer : null) },
			preventDefault: vi.fn(),
		});

		expect(documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT)).toHaveLength(0);
	});
});

describe('conversation composer image attachment (D08)', () => {
	const imageFile = new File(['bytes'], 'p.png', { type: 'image/png' });

	function makeImageFetch({
		meId = 1,
		imageUrl = '/static/uploads/dm/p.png',
		uploadOk = true,
	} = {}) {
		return vi.fn(async (url) => {
			if (String(url).endsWith('/users/me')) {
				return { ok: true, status: 200, json: async () => ({ data: { id: meId } }) };
			}
			if (String(url).endsWith('/images')) {
				return {
					ok: uploadOk,
					status: uploadOk ? 200 : 500,
					json: async () => ({ data: uploadOk ? { image_url: imageUrl } : {} }),
				};
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: { messages: [], has_more: false } }),
			};
		});
	}

	function composerWith(input, files) {
		return {
			querySelector: (sel) => {
				if (sel === '[data-conversation-input]') return input;
				if (sel === '[data-conversation-image-input]') return { files };
				return null;
			},
		};
	}

	test('uploads the attachment and forwards its image_url with the message', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeImageFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		acceptSends(documentRef);
		await selectUser(documentRef, 2);

		const input = { value: 'look at this' };
		activeRoot.dispatch('submit', {
			target: {
				closest: (sel) =>
					sel === '[data-conversation-composer]' ? composerWith(input, [imageFile]) : null,
			},
			preventDefault: vi.fn(),
		});
		await flushMicrotasks();

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/chats/2/images',
			expect.objectContaining({ method: 'POST', credentials: 'include' }),
		);
		const sends = documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT);
		expect(sends).toHaveLength(1);
		expect(sends[0].detail).toEqual({
			recipientId: 2,
			body: 'look at this',
			imageUrl: '/static/uploads/dm/p.png',
			accepted: true,
		});
		expect(input.value).toBe('');
	});

	test('a failed upload surfaces an error and sends nothing', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeImageFetch({ meId: 1, uploadOk: false });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, 2);

		const input = { value: 'with broken image' };
		activeRoot.dispatch('submit', {
			target: {
				closest: (sel) =>
					sel === '[data-conversation-composer]' ? composerWith(input, [imageFile]) : null,
			},
			preventDefault: vi.fn(),
		});
		await flushMicrotasks();

		expect(documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT)).toHaveLength(0);
		expect(activeRoot._error.isHidden()).toBe(false);
		// The composer text is preserved so the user can retry.
		expect(input.value).toBe('with broken image');
	});

	test('an image with no message body uploads and sends an image-only message', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeImageFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		acceptSends(documentRef);
		await selectUser(documentRef, 2);

		const input = { value: '   ' };
		activeRoot.dispatch('submit', {
			target: {
				closest: (sel) =>
					sel === '[data-conversation-composer]' ? composerWith(input, [imageFile]) : null,
			},
			preventDefault: vi.fn(),
		});
		await flushMicrotasks();

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/chats/2/images',
			expect.objectContaining({ method: 'POST', credentials: 'include' }),
		);
		const sends = documentRef.dispatched.filter((e) => e.type === SEND_MESSAGE_EVENT);
		expect(sends).toHaveLength(1);
		expect(sends[0].detail).toEqual({
			recipientId: 2,
			body: '',
			imageUrl: '/static/uploads/dm/p.png',
			accepted: true,
		});
		expect(input.value).toBe('');
	});
});

describe('conversation live dm.message (D04)', () => {
	test('incoming message for the active thread is appended live', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, 2);

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: {
				message: { id: 7, sender_id: 2, recipient_id: 1, sender_username: 'bob', body: 'live!' },
			},
		});
		await flushMicrotasks();

		expect(activeRoot._messages.appended).toHaveLength(1);
		expect(activeRoot._messages.appended[0]).toContain('live!');
		// Viewport pinned to the latest message.
		expect(activeRoot._scroll.scrollTop).toBe(activeRoot._scroll.scrollHeight);
	});

	test('a message for a different thread does NOT append', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, 2);

		// Message from user 9 while the open thread is user 2.
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: {
				message: { id: 8, sender_id: 9, recipient_id: 1, sender_username: 'zoe', body: 'nope' },
			},
		});
		await flushMicrotasks();

		expect(activeRoot._messages.appended).toHaveLength(0);
	});

	test('an own echoed message for the active thread appends', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, 2);

		// Backend echoes the sender's own message: sender_id === me, recipient is 2.
		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: {
				message: { id: 9, sender_id: 1, recipient_id: 2, sender_username: 'me', body: 'echo' },
			},
		});
		await flushMicrotasks();

		expect(activeRoot._messages.appended).toHaveLength(1);
		expect(activeRoot._messages.appended[0]).toContain('echo');
	});

	test('dm.message before any selection is ignored', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });

		documentRef.dispatch(WS_EVENTS.DM_MESSAGE, {
			detail: { message: { sender_id: 2, recipient_id: 1, body: 'orphan' } },
		});
		await flushMicrotasks();

		expect(activeRoot._messages.appended).toHaveLength(0);
	});
});

describe('conversation chat:error banner (D04)', () => {
	test('chat:error reveals the banner with the error message', async () => {
		const activeRoot = createActiveRoot();
		const documentRef = createDocumentRef(activeRoot);
		const fetchRef = makeFetch({ meId: 1 });

		initChatConversation({ windowRef: {}, documentRef, fetchRef });
		await selectUser(documentRef, 2);

		documentRef.dispatch(WS_EVENTS.ERROR, {
			detail: { code: 'NOT_CONNECTED', message: 'Not connected. Your message was not sent.' },
		});

		expect(activeRoot._error.isHidden()).toBe(false);
		expect(activeRoot._error.textContent).toBe('Not connected. Your message was not sent.');
	});
});
