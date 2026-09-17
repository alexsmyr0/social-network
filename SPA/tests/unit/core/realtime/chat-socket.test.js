import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	createChatSocket,
	resolveSocketURL,
	WS_EVENTS,
} from '../../../../core/realtime/chat-socket.js';

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

// A minimal stand-in for the native WebSocket: records the url, captures the
// listeners createChatSocket attaches, and lets the test drive inbound frames
// and transport errors by hand.
function createFakeSocket() {
	const listeners = new Map();
	const sent = [];

	const instances = [];

	class FakeSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 1; // OPEN by default
			this.sent = sent;
			this.closed = false;
			instances.push(this);
		}

		addEventListener(type, handler) {
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		}

		send(data) {
			sent.push(data);
		}

		close() {
			this.closed = true;
		}

		emit(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		}
	}

	return { FakeSocket, sent, instances, emit: (type, event) => instances[0]?.emit(type, event) };
}

function createDocumentRef() {
	const events = [];
	return {
		events,
		dispatchEvent(event) {
			events.push(event);
			return true;
		},
	};
}

describe('resolveSocketURL', () => {
	test('builds a ws:// URL for http origins', () => {
		expect(resolveSocketURL({ protocol: 'http:', host: 'localhost:3000' })).toBe(
			'ws://localhost:3000/ws',
		);
	});

	test('builds a wss:// URL for https origins', () => {
		expect(resolveSocketURL({ protocol: 'https:', host: 'forum.test' })).toBe(
			'wss://forum.test/ws',
		);
	});

	test('falls back to ws:// with empty host when location is missing', () => {
		expect(resolveSocketURL(null)).toBe('ws:///ws');
		expect(resolveSocketURL(undefined)).toBe('ws:///ws');
	});
});

describe('createChatSocket inbound frames', () => {
	function setup() {
		const { FakeSocket, sent, emit } = createFakeSocket();
		const documentRef = createDocumentRef();
		const socket = createChatSocket({
			documentRef,
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		socket.open();
		return { socket, documentRef, sent, emit };
	}

	function frame(type, payload) {
		return { data: JSON.stringify({ type, payload }) };
	}

	test('presence.snapshot dispatches chat:presence-snapshot with users', () => {
		const { documentRef, emit } = setup();
		const users = [{ user_id: 1, is_online: true }];
		emit('message', frame('presence.snapshot', { users }));

		expect(documentRef.events).toHaveLength(1);
		expect(documentRef.events[0].type).toBe(WS_EVENTS.PRESENCE_SNAPSHOT);
		expect(documentRef.events[0].detail).toEqual({ users });
	});

	test('presence.snapshot with non-array users normalizes to []', () => {
		const { documentRef, emit } = setup();
		emit('message', frame('presence.snapshot', { users: 'nope' }));

		expect(documentRef.events[0].detail).toEqual({ users: [] });
	});

	test('presence.update dispatches chat:presence-update with userId/isOnline', () => {
		const { documentRef, emit } = setup();
		emit('message', frame('presence.update', { user_id: 7, is_online: true }));

		expect(documentRef.events[0].type).toBe(WS_EVENTS.PRESENCE_UPDATE);
		expect(documentRef.events[0].detail).toEqual({ userId: 7, isOnline: true });
	});

	test('dm.message dispatches chat:dm-message with the message payload', () => {
		const { documentRef, emit } = setup();
		const payload = { id: 9, sender_id: 2, recipient_id: 1, body: 'hi' };
		emit('message', frame('dm.message', payload));

		expect(documentRef.events[0].type).toBe(WS_EVENTS.DM_MESSAGE);
		expect(documentRef.events[0].detail).toEqual({ message: payload });
	});

	test('chat.error dispatches chat:error with code/message', () => {
		const { documentRef, emit } = setup();
		emit('message', frame('chat.error', { code: 'RATE_LIMIT', message: 'Slow down' }));

		expect(documentRef.events[0].type).toBe(WS_EVENTS.ERROR);
		expect(documentRef.events[0].detail).toEqual({ code: 'RATE_LIMIT', message: 'Slow down' });
	});

	test('chat.error supplies defaults for missing code/message', () => {
		const { documentRef, emit } = setup();
		emit('message', frame('chat.error', {}));

		expect(documentRef.events[0].detail).toEqual({
			code: 'UNKNOWN',
			message: 'Something went wrong.',
		});
	});

	test('malformed JSON frames are ignored and do not crash', () => {
		const { documentRef, emit } = setup();
		expect(() => emit('message', { data: '{ not json' })).not.toThrow();
		expect(documentRef.events).toHaveLength(0);
	});

	test('unknown frame types are ignored', () => {
		const { documentRef, emit } = setup();
		emit('message', frame('something.else', { a: 1 }));
		expect(documentRef.events).toHaveLength(0);
	});

	test('a transport error event dispatches a chat:error', () => {
		const { documentRef, emit } = setup();
		emit('error', {});

		expect(documentRef.events).toHaveLength(1);
		expect(documentRef.events[0].type).toBe(WS_EVENTS.ERROR);
		expect(documentRef.events[0].detail.code).toBe('CONNECTION_ERROR');
	});
});

describe('createChatSocket outbound + lifecycle', () => {
	test('send serializes the {type, payload} envelope when open', () => {
		const { FakeSocket, sent } = createFakeSocket();
		const socket = createChatSocket({
			documentRef: createDocumentRef(),
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		socket.open();

		const ok = socket.send('dm.send', { recipient_id: 3, body: 'yo' });
		expect(ok).toBe(true);
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0])).toEqual({
			type: 'dm.send',
			payload: { recipient_id: 3, body: 'yo' },
		});
	});

	test('send returns false and writes nothing when the socket is not open', () => {
		const { FakeSocket, sent, instances } = createFakeSocket();
		const socket = createChatSocket({
			documentRef: createDocumentRef(),
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		socket.open();
		instances[0].readyState = 0; // CONNECTING

		const ok = socket.send('dm.send', { recipient_id: 3, body: 'yo' });
		expect(ok).toBe(false);
		expect(sent).toHaveLength(0);
	});

	test('send returns false before open() is ever called', () => {
		const { FakeSocket } = createFakeSocket();
		const socket = createChatSocket({
			documentRef: createDocumentRef(),
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		expect(socket.send('dm.send', {})).toBe(false);
	});

	test('open() opens the socket against the resolved url', () => {
		const { FakeSocket, instances } = createFakeSocket();
		const socket = createChatSocket({
			documentRef: createDocumentRef(),
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		socket.open();

		expect(instances).toHaveLength(1);
		expect(instances[0].url).toBe('ws://test/ws');
		expect(socket.isOpen()).toBe(true);
	});

	test('open() is idempotent — a second call does not create a new socket', () => {
		const { FakeSocket, instances } = createFakeSocket();
		const socket = createChatSocket({
			documentRef: createDocumentRef(),
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		socket.open();
		socket.open();
		expect(instances).toHaveLength(1);
	});

	test('open() no-ops without a WebSocket constructor', () => {
		const documentRef = createDocumentRef();
		const socket = createChatSocket({ documentRef, socketCtor: null, url: 'ws://test/ws' });
		expect(socket.open()).toBeNull();
		expect(socket.isOpen()).toBe(false);
		expect(socket.send('dm.send', {})).toBe(false);
	});

	test('close() closes the underlying socket and isOpen flips to false', () => {
		const { FakeSocket, instances } = createFakeSocket();
		const socket = createChatSocket({
			documentRef: createDocumentRef(),
			socketCtor: FakeSocket,
			url: 'ws://test/ws',
		});
		socket.open();
		socket.close();

		expect(instances[0].closed).toBe(true);
		expect(socket.isOpen()).toBe(false);
	});
});

// Issue #50 (cleanup) — the socket used to expose a `[Symbol.dispose]` that
// nothing could ever trigger: explicit resource management needs a `using`
// declaration, and the SPA has none. `close()` is the whole teardown API.
describe('chat socket public surface (#50)', () => {
	test('exposes exactly open/close/send/isOpen', () => {
		const { FakeSocket } = createFakeSocket();
		const socket = createChatSocket({ socketCtor: FakeSocket, documentRef: createDocumentRef() });

		expect(Object.keys(socket).sort()).toEqual(['close', 'isOpen', 'open', 'send']);
	});

	test('does not carry an unreachable Symbol.dispose hook', () => {
		const { FakeSocket } = createFakeSocket();
		const socket = createChatSocket({ socketCtor: FakeSocket, documentRef: createDocumentRef() });

		expect(socket[Symbol.dispose]).toBeUndefined();
		expect(Object.getOwnPropertySymbols(socket)).toEqual([]);
	});
});
