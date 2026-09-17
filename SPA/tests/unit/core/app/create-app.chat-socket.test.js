import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../../../core/app/create-app.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import { SEND_MESSAGE_EVENT } from '../../../../features/chat/chat.conversation.page.js';
import { createMockBrowser } from '../../helpers/browser-mock.js';

// The session/presence slices are one module-level store shared by every slice
// (issue #76), so each case starts from a clean slot set rather than inheriting
// the previous one's identity and presence.
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
	vi.restoreAllMocks();
});

function createMockSocket() {
	return {
		open: vi.fn(),
		close: vi.fn(),
		send: vi.fn(() => true),
		isOpen: vi.fn(() => true),
	};
}

describe('create-app chat socket wiring (D04)', () => {
	test('authenticated boot opens the chat socket', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();

		expect(chatSocket.open).toHaveBeenCalledTimes(1);
		expect(chatSocket.close).not.toHaveBeenCalled();
	});

	test('unauthenticated boot does not open the chat socket', async () => {
		const browser = createMockBrowser('/login');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();

		expect(chatSocket.open).not.toHaveBeenCalled();
	});

	test('logout closes the chat socket', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		browser.clickLogout();
		await Promise.resolve();
		await Promise.resolve();

		expect(chatSocket.close).toHaveBeenCalled();
	});

	test('app stop closes the chat socket', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		app.stop();

		expect(chatSocket.close).toHaveBeenCalled();
	});

	test('SEND_MESSAGE_EVENT forwards a dm.send frame through the socket', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		browser.dispatchDocument(SEND_MESSAGE_EVENT, {
			type: SEND_MESSAGE_EVENT,
			detail: { recipientId: 3, body: 'hi there' },
		});

		expect(chatSocket.send).toHaveBeenCalledWith('dm.send', { recipient_id: 3, body: 'hi there' });
	});

	test('SEND_MESSAGE_EVENT forwards image_url when an attachment is present (D08)', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		browser.dispatchDocument(SEND_MESSAGE_EVENT, {
			type: SEND_MESSAGE_EVENT,
			detail: { recipientId: 3, body: 'see this', imageUrl: '/static/uploads/dm/p.png' },
		});

		expect(chatSocket.send).toHaveBeenCalledWith('dm.send', {
			recipient_id: 3,
			body: 'see this',
			image_url: '/static/uploads/dm/p.png',
		});
	});

	test('SEND_MESSAGE_EVENT forwards an image-only frame with an empty body (D08)', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		browser.dispatchDocument(SEND_MESSAGE_EVENT, {
			type: SEND_MESSAGE_EVENT,
			detail: { recipientId: 3, body: '', imageUrl: '/static/uploads/dm/p.png' },
		});

		expect(chatSocket.send).toHaveBeenCalledWith('dm.send', {
			recipient_id: 3,
			body: '',
			image_url: '/static/uploads/dm/p.png',
		});
	});

	test('SEND_MESSAGE_EVENT with neither body nor image is dropped', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		browser.dispatchDocument(SEND_MESSAGE_EVENT, {
			type: SEND_MESSAGE_EVENT,
			detail: { recipientId: 3, body: '   ' },
		});

		expect(chatSocket.send).not.toHaveBeenCalled();
	});

	test('a failed send dispatches a chat:error NOT_CONNECTED event', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = createMockSocket();
		chatSocket.send = vi.fn(() => false);

		// Capture chat:error CustomEvents the app dispatches on the document.
		const errors = [];
		browser.documentRef.dispatchEvent = (event) => {
			errors.push(event);
			return true;
		};

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		browser.dispatchDocument(SEND_MESSAGE_EVENT, {
			type: SEND_MESSAGE_EVENT,
			detail: { recipientId: 3, body: 'hi there' },
		});

		expect(chatSocket.send).toHaveBeenCalled();
		const chatErrors = errors.filter((e) => e.type === 'chat:error');
		expect(chatErrors).toHaveLength(1);
		expect(chatErrors[0].detail.code).toBe('NOT_CONNECTED');
	});

	test('login onSuccess opens the chat socket', async () => {
		const browser = createMockBrowser('/login');
		const chatSocket = createMockSocket();
		const authHandlers = await import('../../../../features/auth/auth.handlers.js');
		vi.spyOn(authHandlers, 'canHandleAuthForm').mockImplementation(
			(form) => form?.id === 'login-form',
		);
		vi.spyOn(authHandlers, 'handleAuthFormSubmit').mockImplementation(
			async ({ navigate, onSuccess }) => {
				onSuccess?.({ kind: 'login' });
				navigate?.('/', { replace: true });
				return { handled: true, ok: true, kind: 'login' };
			},
		);

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			notificationCenter: { start: vi.fn(), stop: vi.fn() },
			chatSocket,
		});

		await app.boot();
		expect(chatSocket.open).not.toHaveBeenCalled();

		browser.submitForm('login-form');
		expect(chatSocket.open).toHaveBeenCalledTimes(1);
	});
});
