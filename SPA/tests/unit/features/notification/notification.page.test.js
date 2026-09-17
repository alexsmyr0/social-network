// SPA/tests/unit/features/notification/notification.page.test.js

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	createNotificationCenter,
	resolveNotificationDestination,
} from '../../../../features/notification/notification.page.js';

// Minimal DOM modelling the subset of the API the notification center touches.
class FakeClassList {
	constructor() {
		this.set = new Set();
	}
	add(...names) {
		for (const name of names) this.set.add(name);
	}
	remove(...names) {
		for (const name of names) this.set.delete(name);
	}
	toggle(name, force) {
		const next = force ?? !this.set.has(name);
		if (next) this.set.add(name);
		else this.set.delete(name);
		return next;
	}
	contains(name) {
		return this.set.has(name);
	}
}

class FakeNode {
	constructor(selectorName = '') {
		this.selectorName = selectorName;
		this.classList = new FakeClassList();
		this.dataset = {};
		this.attributes = new Map();
		this.hidden = false;
		this.textContent = '';
		this.innerHTML = '';
		this.scrollTop = 0;
		this.listeners = new Map();
		this.childMatches = [];
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	removeAttribute(name) {
		this.attributes.delete(name);
	}
	addEventListener(type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(handler);
	}
	dispatch(type, event = {}) {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}
	insertAdjacentHTML(_position, markup) {
		this.innerHTML += markup;
	}
	querySelector() {
		return null;
	}
	querySelectorAll() {
		return this.childMatches;
	}
	closest(selector) {
		return selector === '[data-notification]' ? (this.notificationRoot ?? null) : null;
	}
	contains() {
		return false;
	}
}

function makeRootTriple() {
	const bell = new FakeNode('bell');
	const badge = new FakeNode('badge');
	const dropdown = new FakeNode('dropdown');
	const root = new FakeNode('root');
	bell.notificationRoot = root;
	root.querySelector = (selector) => {
		if (selector === '[data-notification-bell]') return bell;
		if (selector === '[data-notification-badge]') return badge;
		if (selector === '[data-notification-dropdown]') return dropdown;
		return null;
	};
	return { root, bell, badge, dropdown };
}

function createDocument({ withRoot = true } = {}) {
	let current = makeRootTriple();

	const documentListeners = new Map();

	const documentRef = {
		querySelector(selector) {
			if (!withRoot) return null;
			if (selector === '[data-notification]') return current.root;
			return null;
		},
		addEventListener(type, handler) {
			if (!documentListeners.has(type)) documentListeners.set(type, []);
			documentListeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const handlers = documentListeners.get(type);
			if (!handlers) return;
			const index = handlers.indexOf(handler);
			if (index !== -1) handlers.splice(index, 1);
		},
		dispatch(type, event = {}) {
			for (const handler of documentListeners.get(type) ?? []) handler(event);
		},
		listenerCount(type) {
			return (documentListeners.get(type) ?? []).length;
		},
	};

	// Simulate the shell (and bell DOM) being rebuilt, e.g. on a logout->login cycle.
	const swapRoot = () => {
		current = makeRootTriple();
		return current;
	};

	return {
		documentRef,
		get root() {
			return current.root;
		},
		get bell() {
			return current.bell;
		},
		get badge() {
			return current.badge;
		},
		get dropdown() {
			return current.dropdown;
		},
		swapRoot,
	};
}

function notificationsResponse(notifications, unreadCount) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: { notifications, unread_count: unreadCount } }),
	};
}

function timerControls() {
	let nextId = 1;
	const setIntervalRef = vi.fn(() => nextId++);
	const clearIntervalRef = vi.fn();
	return { setIntervalRef, clearIntervalRef };
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('notification center runtime', () => {
	test('start polls notifications and renders badge + dropdown', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () =>
			notificationsResponse(
				[{ id: 1, type: 'post_like', actor_username: 'alice', post_title: 'Hi', is_read: false }],
				1,
			),
		);
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		await flush();

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications',
			expect.objectContaining({ credentials: 'include' }),
		);
		expect(dom.badge.textContent).toBe('1');
		expect(dom.badge.classList.contains('hidden')).toBe(false);
		expect(dom.dropdown.innerHTML).toContain('alice liked your post');
		expect(dom.dropdown.innerHTML).toContain('notification__item--unread');
	});

	test('start uses the 60s safety-net interval and prevents duplicates', () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		center.start();
		center.start();

		expect(timers.setIntervalRef).toHaveBeenCalledTimes(1);
		expect(timers.setIntervalRef).toHaveBeenCalledWith(expect.any(Function), 60000);
		expect(center.isPolling()).toBe(true);
	});

	test('stop clears the interval', () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		center.stop();

		expect(timers.clearIntervalRef).toHaveBeenCalledTimes(1);
		expect(center.isPolling()).toBe(false);
	});

	test('401 response stops polling', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		await flush();

		expect(center.isPolling()).toBe(false);
		expect(timers.clearIntervalRef).toHaveBeenCalled();
	});

	test('zero unread hides the badge and renders empty state', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		await flush();

		expect(dom.badge.classList.contains('hidden')).toBe(true);
		expect(dom.badge.textContent).toBe('');
		expect(dom.dropdown.innerHTML).toContain('notification__empty');
	});

	test('bell click toggles the dropdown open and closed', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		await flush();

		dom.bell.dispatch('click', { stopPropagation() {} });
		expect(dom.dropdown.hidden).toBe(false);
		expect(dom.bell.getAttribute('aria-expanded')).toBe('true');

		dom.bell.dispatch('click', { stopPropagation() {} });
		expect(dom.dropdown.hidden).toBe(true);
		expect(dom.bell.getAttribute('aria-expanded')).toBe('false');
	});

	test('outside click closes the dropdown', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		await flush();

		dom.bell.dispatch('click', { stopPropagation() {} });
		expect(dom.dropdown.hidden).toBe(false);

		dom.documentRef.dispatch('click', { target: { closest: () => null } });
		expect(dom.dropdown.hidden).toBe(true);
	});

	test('returns null when the bell is not in the DOM', () => {
		const dom = createDocument({ withRoot: false });
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();

		expect(timers.setIntervalRef).not.toHaveBeenCalled();
		expect(center.isPolling()).toBe(false);
	});

	test('re-binds to a rebuilt bell after the shell is replaced (logout -> login)', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 2));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });

		// First session: badge renders against the original bell.
		center.start();
		await flush();
		expect(dom.badge.textContent).toBe('2');

		// Logout clears the interval; the shell (and bell DOM) is then rebuilt.
		center.stop();
		const stale = dom.badge;
		dom.swapRoot();

		// Re-login: polling should update the NEW bell, not the detached old one.
		center.start();
		await flush();

		expect(dom.badge).not.toBe(stale);
		expect(dom.badge.textContent).toBe('2');
		expect(stale.textContent).toBe('2'); // old node was set once, now detached/untouched

		// The outside-click listener from the first session must not leak: stop()
		// removes it, so after a re-bind there is exactly one document handler.
		expect(dom.documentRef.listenerCount('click')).toBe(1);
	});

	test('does not accumulate document-click listeners across repeated re-binds', async () => {
		const dom = createDocument();
		const fetchRef = vi.fn(async () => notificationsResponse([], 0));
		const timers = timerControls();

		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });

		for (let i = 0; i < 3; i += 1) {
			center.start();
			await flush();
			center.stop();
			dom.swapRoot();
		}

		// stop() tears down each session's listener before the next bind.
		expect(dom.documentRef.listenerCount('click')).toBe(0);
	});
});

// Builds a notification item node wired so target.closest() resolves it.
function makeItem(id, { unread = true, type, postId, commentId } = {}) {
	const item = new FakeNode('item');
	item.dataset.notificationId = String(id);
	if (type !== undefined) item.dataset.notificationType = String(type);
	if (postId !== undefined) item.dataset.notificationPostId = String(postId);
	if (commentId !== undefined) item.dataset.notificationCommentId = String(commentId);
	if (unread) item.classList.add('notification__item--unread');
	item.closest = (selector) => (selector === '[data-notification-item]' ? item : null);
	return item;
}

describe('notification read actions', () => {
	function setup({ fetchRef, badgeCount = '2' } = {}) {
		const dom = createDocument();
		const timers = timerControls();
		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		// Seed a known badge value as if a prior poll rendered it.
		dom.badge.textContent = badgeCount;
		dom.badge.classList.remove('hidden');
		return { dom, timers, center };
	}

	test('single read PATCHes the per-id endpoint and updates state immediately', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const { dom } = setup({ fetchRef, badgeCount: '2' });

		const item = makeItem(11);
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications/11/read',
			expect.objectContaining({ method: 'PATCH', credentials: 'include' }),
		);
		// local state cleared immediately
		expect(item.classList.contains('notification__item--unread')).toBe(false);
		// badge + count decremented immediately
		expect(dom.badge.textContent).toBe('1');
		expect(dom.badge.classList.contains('hidden')).toBe(false);
	});

	test('single read on an already-read item is a no-op (no request)', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const { dom } = setup({ fetchRef, badgeCount: '2' });
		fetchRef.mockClear();

		const item = makeItem(12, { unread: false });
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(fetchRef).not.toHaveBeenCalled();
		expect(dom.badge.textContent).toBe('2');
	});

	test('single read failure leaves local state untouched for the next poll to reconcile', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 500 }));
		const { dom } = setup({ fetchRef, badgeCount: '2' });

		const item = makeItem(13);
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		// optimistic update is NOT applied on failure
		expect(item.classList.contains('notification__item--unread')).toBe(true);
		expect(dom.badge.textContent).toBe('2');
	});

	test('single read decrements toward zero and hides the badge at zero', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const { dom } = setup({ fetchRef, badgeCount: '1' });

		const item = makeItem(14);
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(dom.badge.textContent).toBe('');
		expect(dom.badge.classList.contains('hidden')).toBe(true);
	});

	test('mark all PATCHes read-all, clears unread state, and zeroes the badge', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const { dom } = setup({ fetchRef, badgeCount: '3' });

		const unreadItems = [makeItem(1), makeItem(2), makeItem(3)];
		dom.dropdown.childMatches = unreadItems;
		const markAllBtn = new FakeNode('mark-all');
		dom.dropdown.querySelector = (selector) =>
			selector === '[data-notification-mark-all]' ? markAllBtn : null;
		markAllBtn.remove = vi.fn();

		const target = {
			closest: (selector) => (selector === '[data-notification-mark-all]' ? markAllBtn : null),
		};
		dom.dropdown.dispatch('click', { target, stopPropagation() {} });
		await flush();

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications/read-all',
			expect.objectContaining({ method: 'PATCH', credentials: 'include' }),
		);
		for (const item of unreadItems) {
			expect(item.classList.contains('notification__item--unread')).toBe(false);
		}
		expect(dom.badge.textContent).toBe('');
		expect(dom.badge.classList.contains('hidden')).toBe(true);
		expect(markAllBtn.remove).toHaveBeenCalled();
	});

	test('mark all failure leaves unread state for the next poll to reconcile', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 500 }));
		const { dom } = setup({ fetchRef, badgeCount: '3' });

		const unreadItems = [makeItem(1), makeItem(2)];
		dom.dropdown.childMatches = unreadItems;

		const target = {
			closest: (selector) =>
				selector === '[data-notification-mark-all]' ? new FakeNode('mark-all') : null,
		};
		dom.dropdown.dispatch('click', { target, stopPropagation() {} });
		await flush();

		for (const item of unreadItems) {
			expect(item.classList.contains('notification__item--unread')).toBe(true);
		}
		expect(dom.badge.textContent).toBe('3');
	});

	test('a 401 during single read stops polling', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		const { dom, center } = setup({ fetchRef, badgeCount: '2' });

		const item = makeItem(15);
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(center.isPolling()).toBe(false);
	});

	test('next poll reconciles local optimistic state from server truth', async () => {
		let phase = 'idle';
		const fetchRef = vi.fn(async (url) => {
			if (url === '/api/v1/notifications/16/read') {
				return { ok: true, status: 204 };
			}
			// list endpoint: server still reports the item unread until reconciled
			return notificationsResponse(
				phase === 'after'
					? [{ id: 16, type: 'post_like', actor_username: 'a', is_read: true }]
					: [{ id: 16, type: 'post_like', actor_username: 'a', is_read: false }],
				phase === 'after' ? 0 : 1,
			);
		});
		const dom = createDocument();
		const timers = timerControls();
		const center = createNotificationCenter({ documentRef: dom.documentRef, fetchRef, ...timers });
		center.start();
		await flush(); // let the initial poll render (unread_count: 1)
		expect(dom.badge.textContent).toBe('1');

		const item = makeItem(16);
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();
		// optimistic decrement applied immediately
		expect(dom.badge.textContent).toBe('');

		// server has now persisted the read; a subsequent poll re-renders from truth
		phase = 'after';
		await center.refresh();
		expect(dom.badge.classList.contains('hidden')).toBe(true);
		expect(dom.dropdown.innerHTML).not.toContain('notification__item--unread');
	});
});

describe('resolveNotificationDestination', () => {
	test('comment type highlights the newest comment', () => {
		expect(resolveNotificationDestination({ type: 'comment', post_id: 5 })).toBe(
			'/posts/5?highlight=last',
		);
	});

	test('a notification with a comment id highlights that comment', () => {
		expect(
			resolveNotificationDestination({ type: 'comment_like', post_id: 5, comment_id: 9 }),
		).toBe('/posts/5?highlight=9');
	});

	test('a post-only notification opens the post with no highlight', () => {
		expect(resolveNotificationDestination({ type: 'post_like', post_id: 5 })).toBe('/posts/5');
	});

	test('no post id yields no destination', () => {
		expect(resolveNotificationDestination({ type: 'post_like' })).toBeNull();
		expect(resolveNotificationDestination({ type: 'post_like', post_id: 0 })).toBeNull();
	});
});

describe('notification click navigation', () => {
	function setup({ fetchRef, navigate }) {
		const dom = createDocument();
		const timers = timerControls();
		const center = createNotificationCenter({
			documentRef: dom.documentRef,
			fetchRef,
			navigate,
			...timers,
		});
		center.start();
		dom.badge.textContent = '1';
		dom.badge.classList.remove('hidden');
		return { dom, center };
	}

	test('clicking a comment notification marks read then navigates via the router', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const navigate = vi.fn();
		const { dom } = setup({ fetchRef, navigate });

		const item = makeItem(1, { type: 'comment', postId: 7 });
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications/1/read',
			expect.objectContaining({ method: 'PATCH' }),
		);
		expect(navigate).toHaveBeenCalledWith('/posts/7?highlight=last');
		expect(dom.dropdown.hidden).toBe(true);
	});

	test('clicking a comment-reaction notification deep-links to that comment', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const navigate = vi.fn();
		const { dom } = setup({ fetchRef, navigate });

		const item = makeItem(2, { type: 'comment_like', postId: 7, commentId: 42 });
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(navigate).toHaveBeenCalledWith('/posts/7?highlight=42');
	});

	test('clicking a post notification opens the post with no highlight', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const navigate = vi.fn();
		const { dom } = setup({ fetchRef, navigate });

		const item = makeItem(3, { type: 'post_like', postId: 7 });
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(navigate).toHaveBeenCalledWith('/posts/7');
	});

	test('an already-read notification still navigates (no PATCH)', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const navigate = vi.fn();
		const { dom } = setup({ fetchRef, navigate });
		fetchRef.mockClear();

		const item = makeItem(4, { unread: false, type: 'post_like', postId: 7 });
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(fetchRef).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith('/posts/7');
	});

	test('navigation defaults to history.pushState (never location.href)', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const pushState = vi.fn();
		const dispatchEvent = vi.fn();
		const assign = vi.fn();
		const windowRef = {
			history: { pushState },
			dispatchEvent,
			location: {
				href: 'https://x.test/',
				get assign() {
					return assign;
				},
			},
			PopStateEvent: class {
				constructor(type) {
					this.type = type;
				}
			},
		};

		const dom = createDocument();
		const timers = timerControls();
		const center = createNotificationCenter({
			windowRef,
			documentRef: dom.documentRef,
			fetchRef,
			...timers,
		});
		center.start();

		const item = makeItem(5, { type: 'post_like', postId: 8 });
		dom.dropdown.dispatch('click', { target: item, stopPropagation() {} });
		await flush();

		expect(pushState).toHaveBeenCalledWith({}, '', '/posts/8');
		expect(dispatchEvent).toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});
});
