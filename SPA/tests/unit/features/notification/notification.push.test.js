// The notification centre used to poll every 5 seconds, so an idle page with an
// idle WebSocket already open still issued twelve requests a minute to be told
// nothing had happened. The backend now pushes `notification.new` down that
// socket, and the interval survives only as a safety net.

import { describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { createNotificationCenter } from '../../../../features/notification/notification.page.js';

function node() {
	return {
		classList: {
			set: new Set(),
			add(...n) {
				for (const x of n) this.set.add(x);
			},
			remove(...n) {
				for (const x of n) this.set.delete(x);
			},
			toggle(name, force) {
				const next = force ?? !this.set.has(name);
				if (next) this.set.add(name);
				else this.set.delete(name);
				return next;
			},
			contains(n) {
				return this.set.has(n);
			},
		},
		dataset: {},
		hidden: false,
		textContent: '',
		innerHTML: '',
		scrollTop: 0,
		setAttribute() {},
		getAttribute() {
			return null;
		},
		removeAttribute() {},
		addEventListener() {},
		insertAdjacentHTML(_pos, markup) {
			this.innerHTML += markup;
		},
		querySelector() {
			return null;
		},
		querySelectorAll() {
			return [];
		},
	};
}

function createDocument() {
	const listeners = new Map();
	const bell = node();
	const badge = node();
	const dropdown = node();
	const root = node();
	root.querySelector = (selector) => {
		if (selector === '[data-notification-bell]') return bell;
		if (selector === '[data-notification-badge]') return badge;
		if (selector === '[data-notification-dropdown]') return dropdown;
		return null;
	};

	const documentRef = {
		hidden: false,
		querySelector: (selector) => (selector === '[data-notification]' ? root : null),
		addEventListener(type, handler) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const handlers = listeners.get(type);
			if (!handlers) return;
			const index = handlers.indexOf(handler);
			if (index !== -1) handlers.splice(index, 1);
		},
		dispatch(type, event = {}) {
			for (const handler of listeners.get(type) ?? []) handler(event);
		},
	};

	return { documentRef, badge };
}

function emptyResponse() {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: { notifications: [], unread_count: 0 } }),
	};
}

// Captures the interval callback so a test can run one tick by hand.
function timerControls() {
	let tick = null;
	return {
		runTick: () => tick?.(),
		setIntervalRef: vi.fn((fn) => {
			tick = fn;
			return 1;
		}),
		clearIntervalRef: vi.fn(),
	};
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

function setup() {
	const dom = createDocument();
	const fetchRef = vi.fn(async () => emptyResponse());
	const timers = timerControls();
	const center = createNotificationCenter({
		documentRef: dom.documentRef,
		fetchRef,
		...timers,
	});
	return { center, fetchRef, timers, documentRef: dom.documentRef };
}

describe('push-driven notification refresh', () => {
	test('a notification.new frame refetches immediately', async () => {
		const { center, fetchRef, documentRef } = setup();
		center.start();
		await flush();

		const before = fetchRef.mock.calls.length;
		documentRef.dispatch(WS_EVENTS.NOTIFICATION, { detail: {} });
		await flush();

		expect(fetchRef.mock.calls.length).toBe(before + 1);
	});

	test('a frame arriving after stop() is ignored', async () => {
		const { center, fetchRef, documentRef } = setup();
		center.start();
		await flush();
		center.stop();

		const before = fetchRef.mock.calls.length;
		documentRef.dispatch(WS_EVENTS.NOTIFICATION, { detail: {} });
		await flush();

		// A stray frame after logout must not resurrect the badge.
		expect(fetchRef.mock.calls.length).toBe(before);
	});

	test('the frame listener is bound once across start/stop cycles', async () => {
		const { center, fetchRef, documentRef } = setup();
		center.start();
		await flush();
		center.stop();
		center.start();
		await flush();

		const before = fetchRef.mock.calls.length;
		documentRef.dispatch(WS_EVENTS.NOTIFICATION, { detail: {} });
		await flush();

		// One refetch, not one per completed start() cycle.
		expect(fetchRef.mock.calls.length).toBe(before + 1);
	});
});

describe('visibility-aware polling', () => {
	test('the safety-net tick is skipped while the tab is hidden', async () => {
		const { center, fetchRef, timers, documentRef } = setup();
		center.start();
		await flush();

		documentRef.hidden = true;
		const before = fetchRef.mock.calls.length;
		timers.runTick();
		await flush();

		expect(fetchRef.mock.calls.length).toBe(before);
	});

	test('the tick still runs while the tab is visible', async () => {
		const { center, fetchRef, timers } = setup();
		center.start();
		await flush();

		const before = fetchRef.mock.calls.length;
		timers.runTick();
		await flush();

		expect(fetchRef.mock.calls.length).toBe(before + 1);
	});

	test('coming back to a visible tab refreshes right away', async () => {
		const { center, fetchRef, documentRef } = setup();
		center.start();
		await flush();

		documentRef.hidden = true;
		documentRef.dispatch('visibilitychange', {});
		await flush();
		const whileHidden = fetchRef.mock.calls.length;

		documentRef.hidden = false;
		documentRef.dispatch('visibilitychange', {});
		await flush();

		expect(fetchRef.mock.calls.length).toBe(whileHidden + 1);
	});
});
