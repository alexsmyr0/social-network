// The socket used to open exactly once. A laptop waking, a wifi blip or a
// backend restart left chat dead until the user happened to reload the page,
// with only a transient banner to say so. These pin the retry behaviour.
//
// The harness gives every connection its own listener set — unlike the shared
// one in chat-socket.test.js — because a reconnect is precisely the case where
// a superseded connection's handlers must not touch the live one.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createChatSocket, WS_EVENTS } from '../../../../core/realtime/chat-socket.js';

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

function createSocketFactory() {
	const instances = [];

	class FakeSocket {
		constructor(url) {
			this.url = url;
			this.readyState = 1;
			this.closed = false;
			this.sent = [];
			this._listeners = new Map();
			instances.push(this);
		}

		addEventListener(type, handler) {
			if (!this._listeners.has(type)) {
				this._listeners.set(type, []);
			}
			this._listeners.get(type).push(handler);
		}

		send(data) {
			this.sent.push(data);
		}

		close() {
			this.closed = true;
		}

		emit(type, event) {
			for (const handler of this._listeners.get(type) ?? []) {
				handler(event);
			}
		}

		// Models the browser: a dropped connection reports `close`, and its
		// readyState is no longer OPEN.
		drop() {
			this.readyState = 3;
			this.emit('close', {});
		}
	}

	return { FakeSocket, instances };
}

// A controllable timer queue so the backoff schedule is inspectable without
// waiting on wall-clock time.
function createTimers() {
	const scheduled = [];
	let nextId = 1;

	return {
		delays: () => scheduled.filter((t) => !t.cancelled).map((t) => t.delay),
		pending: () => scheduled.filter((t) => !t.cancelled && !t.fired).length,
		setTimeoutRef: vi.fn((fn, delay) => {
			const id = nextId++;
			scheduled.push({ id, fn, delay, cancelled: false, fired: false });
			return id;
		}),
		clearTimeoutRef: vi.fn((id) => {
			const entry = scheduled.find((t) => t.id === id);
			if (entry) {
				entry.cancelled = true;
			}
		}),
		runPending() {
			for (const entry of scheduled) {
				if (!entry.cancelled && !entry.fired) {
					entry.fired = true;
					entry.fn();
				}
			}
		},
	};
}

function createDocumentRef() {
	const events = [];
	return {
		events,
		errors: () => events.filter((e) => e.type === WS_EVENTS.ERROR),
		dispatchEvent(event) {
			events.push(event);
			return true;
		},
	};
}

function setup() {
	const { FakeSocket, instances } = createSocketFactory();
	const documentRef = createDocumentRef();
	const timers = createTimers();
	const socket = createChatSocket({
		documentRef,
		socketCtor: FakeSocket,
		url: 'ws://test/ws',
		setTimeoutRef: timers.setTimeoutRef,
		clearTimeoutRef: timers.clearTimeoutRef,
	});
	return { socket, documentRef, timers, instances };
}

describe('chat socket reconnect', () => {
	test('a dropped connection is retried', () => {
		const { socket, timers, instances } = setup();
		socket.open();
		expect(instances).toHaveLength(1);

		instances[0].drop();
		expect(timers.pending()).toBe(1);

		timers.runPending();
		expect(instances).toHaveLength(2);
		expect(instances[1].url).toBe('ws://test/ws');
	});

	test('repeated failures back off exponentially up to the cap', () => {
		const { socket, timers, instances } = setup();
		socket.open();

		// Each retry connects and immediately drops again without ever opening.
		for (let i = 0; i < 8; i += 1) {
			instances[instances.length - 1].drop();
			timers.runPending();
		}

		expect(timers.delays()).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
	});

	test('a connection that opens resets the backoff', () => {
		const { socket, timers, instances } = setup();
		socket.open();

		instances[0].drop();
		timers.runPending();
		instances[1].drop();
		timers.runPending();
		expect(timers.delays()).toEqual([1000, 2000]);

		// The third attempt succeeds, so a later blip starts from the bottom
		// of the schedule again rather than inheriting the previous backoff.
		instances[2].emit('open', {});
		instances[2].drop();

		expect(timers.delays()).toEqual([1000, 2000, 1000]);
	});

	test('a reconnected socket sends again', () => {
		const { socket, timers, instances } = setup();
		socket.open();

		instances[0].drop();
		expect(socket.isOpen()).toBe(false);
		expect(socket.send('dm.send', { recipient_id: 2 })).toBe(false);

		timers.runPending();
		instances[1].emit('open', {});

		expect(socket.isOpen()).toBe(true);
		expect(socket.send('dm.send', { recipient_id: 2 })).toBe(true);
		expect(instances[1].sent).toHaveLength(1);
	});

	test('frames from the reconnected socket are published', () => {
		const { socket, documentRef, timers, instances } = setup();
		socket.open();
		instances[0].drop();
		timers.runPending();

		instances[1].emit('message', {
			data: JSON.stringify({
				type: 'dm.message',
				payload: { id: 9, sender_id: 2, body: 'after reconnect' },
			}),
		});

		const dms = documentRef.events.filter((e) => e.type === WS_EVENTS.DM_MESSAGE);
		expect(dms).toHaveLength(1);
		expect(dms[0].detail.message.body).toBe('after reconnect');
	});

	test('close() is deliberate and stops the retries', () => {
		const { socket, timers, instances } = setup();
		socket.open();

		socket.close();
		expect(instances[0].closed).toBe(true);
		// The teardown's own close event must not schedule a reconnect.
		instances[0].emit('close', {});

		expect(timers.pending()).toBe(0);
		timers.runPending();
		expect(instances).toHaveLength(1);
	});

	test('close() cancels a retry that was already queued', () => {
		const { socket, timers, instances } = setup();
		socket.open();

		instances[0].drop();
		expect(timers.pending()).toBe(1);

		socket.close();
		expect(timers.clearTimeoutRef).toHaveBeenCalled();

		timers.runPending();
		expect(instances).toHaveLength(1);
	});

	test('one drop reports one disconnect, not one per transport event', () => {
		const { socket, documentRef, instances } = setup();
		socket.open();

		// The browser fires `error` and then `close` for a single failure.
		instances[0].emit('error', {});
		instances[0].drop();

		expect(documentRef.errors()).toHaveLength(1);
		expect(documentRef.errors()[0].detail.code).toBe('CONNECTION_ERROR');
	});

	test('a later drop reports again once the socket has recovered', () => {
		const { socket, documentRef, timers, instances } = setup();
		socket.open();

		instances[0].drop();
		expect(documentRef.errors()).toHaveLength(1);

		timers.runPending();
		instances[1].emit('open', {});
		instances[1].drop();

		expect(documentRef.errors()).toHaveLength(2);
	});

	test('a superseded connection cannot tear down the live one', () => {
		const { socket, timers, instances } = setup();
		socket.open();

		instances[0].drop();
		timers.runPending();
		instances[1].emit('open', {});

		// A late close from the dead first connection must be ignored.
		instances[0].emit('close', {});

		expect(socket.isOpen()).toBe(true);
		expect(timers.pending()).toBe(0);
	});
});

describe('notification frames', () => {
	test('notification.new is republished for the notification centre', () => {
		const { socket, documentRef, instances } = setup();
		socket.open();

		instances[0].emit('message', { data: JSON.stringify({ type: 'notification.new' }) });

		expect(documentRef.events.filter((e) => e.type === WS_EVENTS.NOTIFICATION)).toHaveLength(1);
	});
});
