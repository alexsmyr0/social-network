// SPA/features/notification/notification.page.js

import { WS_EVENTS } from '../../core/realtime/chat-socket.js';
import {
	loadNotifications,
	markAllNotificationsRead,
	markNotificationRead,
} from './notification.api.js';
import {
	renderNotificationDropdownHeader,
	renderNotificationEmpty,
	renderNotificationItem,
} from './notification.views.js';

const NOTIFICATION_BOUND_ATTR = 'data-notification-bound';

// The centre used to poll every 5 seconds, which meant an idle page with an
// idle WebSocket already open still issued twelve requests a minute to be told
// nothing had happened. The backend now pushes a `notification.new` frame down
// that socket when a row is created, so a refresh happens when there is
// something to refresh for.
//
// The interval survives as a safety net, not as the delivery mechanism: it
// covers a notification created while the socket was down, and reconciles the
// optimistic mark-as-read updates. It is also skipped entirely while the tab is
// hidden — a backgrounded tab has nobody to show a badge to, and it refreshes
// on the way back to visible.
const POLL_INTERVAL_MS = 60000;

// Resolve a notification's deep-link destination, preserving legacy semantics:
//   comment           -> highlight the newest comment ("last")
//   has comment_id     -> highlight that specific comment
//   otherwise          -> open the post with no highlight
// Returns null when there is no post to navigate to.
export function resolveNotificationDestination(notification) {
	const postId = Number(notification?.post_id);
	if (!Number.isFinite(postId) || postId <= 0) {
		return null;
	}

	if (notification?.type === 'comment') {
		return `/posts/${postId}?highlight=last`;
	}

	const commentId = Number(notification?.comment_id);
	if (Number.isFinite(commentId) && commentId > 0) {
		return `/posts/${postId}?highlight=${commentId}`;
	}

	return `/posts/${postId}`;
}

function resolveElements(root) {
	const bell = root.querySelector('[data-notification-bell]');
	const badge = root.querySelector('[data-notification-badge]');
	const dropdown = root.querySelector('[data-notification-dropdown]');

	if (!bell || !badge || !dropdown) {
		return null;
	}

	return { bell, badge, dropdown };
}

function updateBadge(badge, count) {
	if (count > 0) {
		badge.textContent = String(count);
		badge.classList.remove('hidden');
		badge.removeAttribute('aria-hidden');
	} else {
		badge.textContent = '';
		badge.classList.add('hidden');
		badge.setAttribute('aria-hidden', 'true');
	}
}

function renderDropdown(dropdown, notifications) {
	const hasUnread = notifications.some((notification) => !notification.is_read);

	dropdown.innerHTML = renderNotificationDropdownHeader({ showMarkAll: hasUnread });
	dropdown.scrollTop = 0;

	if (notifications.length === 0) {
		dropdown.insertAdjacentHTML('beforeend', renderNotificationEmpty());
		return;
	}

	const items = notifications.map((notification) => renderNotificationItem(notification)).join('');
	dropdown.insertAdjacentHTML('beforeend', items);
}

function bindNotificationCenter({ documentRef, fetchRef, elements, onUnauthorized, navigate }) {
	const { bell, badge, dropdown } = elements;

	const setDropdownOpen = (open) => {
		dropdown.classList.toggle('hidden', !open);
		dropdown.hidden = !open;
		bell.setAttribute('aria-expanded', String(open));
	};

	const closeDropdown = () => setDropdownOpen(false);

	const refresh = async () => {
		const result = await loadNotifications(fetchRef);

		if (!result.ok) {
			if (result.status === 401) {
				onUnauthorized();
			}
			return result;
		}

		updateBadge(badge, result.unreadCount);
		renderDropdown(dropdown, result.notifications);
		return result;
	};

	const markOne = async (item) => {
		const notificationId = item?.dataset?.notificationId;
		if (!notificationId || !item.classList.contains('notification__item--unread')) {
			return;
		}

		const result = await markNotificationRead(fetchRef, notificationId);
		if (!result.ok) {
			if (result.status === 401) {
				onUnauthorized();
			}
			return;
		}

		item.classList.remove('notification__item--unread');

		const current = Number(badge.textContent) || 0;
		updateBadge(badge, Math.max(current - 1, 0));
	};

	const destinationFromItem = (item) =>
		resolveNotificationDestination({
			type: item?.dataset?.notificationType,
			post_id: item?.dataset?.notificationPostId,
			comment_id: item?.dataset?.notificationCommentId,
		});

	// Clicking a notification marks it read (if unread) and navigates to its
	// destination via the SPA router. Navigation happens regardless of read state.
	const handleItemClick = async (item) => {
		await markOne(item);

		const destination = destinationFromItem(item);
		closeDropdown();

		if (destination) {
			navigate(destination);
		}
	};

	const markAll = async () => {
		const result = await markAllNotificationsRead(fetchRef);
		if (!result.ok) {
			if (result.status === 401) {
				onUnauthorized();
			}
			return;
		}

		for (const unread of dropdown.querySelectorAll('.notification__item--unread')) {
			unread.classList.remove('notification__item--unread');
		}

		updateBadge(badge, 0);

		const markAllButton = dropdown.querySelector('[data-notification-mark-all]');
		if (markAllButton) {
			markAllButton.remove();
		}
	};

	bell.addEventListener('click', (event) => {
		event.stopPropagation();
		setDropdownOpen(dropdown.hidden);
	});

	dropdown.addEventListener('click', (event) => {
		const target = event.target;
		if (!target || typeof target.closest !== 'function') {
			return;
		}

		if (target.closest('[data-notification-mark-all]')) {
			event.stopPropagation?.();
			void markAll();
			return;
		}

		const item = target.closest('[data-notification-item]');
		if (item) {
			void handleItemClick(item);
		}
	});

	// Bell and dropdown listeners live on nodes that are replaced when the shell
	// is rebuilt, so they don't leak. The document listener does — it must be
	// removed explicitly on teardown/re-bind (see teardown below).
	const handleDocumentClick = (event) => {
		const target = event.target;
		const insideNotification =
			target && typeof target.closest === 'function' && target.closest('[data-notification]');
		if (insideNotification) {
			return;
		}
		closeDropdown();
	};

	documentRef.addEventListener('click', handleDocumentClick);

	// Establish a known closed state on mount (the markup starts hidden).
	closeDropdown();

	const teardown = () => {
		documentRef.removeEventListener('click', handleDocumentClick);
	};

	return { refresh, close: closeDropdown, teardown };
}

export function createNotificationCenter(options = {}) {
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const fetchRef =
		options.fetchRef ?? (typeof fetch === 'function' ? fetch.bind(windowRef ?? undefined) : null);
	const setIntervalRef =
		typeof options.setIntervalRef === 'function'
			? options.setIntervalRef
			: windowRef?.setInterval?.bind(windowRef);
	const clearIntervalRef =
		typeof options.clearIntervalRef === 'function'
			? options.clearIntervalRef
			: windowRef?.clearInterval?.bind(windowRef);

	// SPA navigation only — never window.location.href. Prefer the router's
	// navigate; fall back to history.pushState + popstate so the SPA router
	// still picks up the change without a full page reload.
	const navigate =
		typeof options.navigate === 'function'
			? options.navigate
			: (path) => {
					if (!windowRef?.history?.pushState) {
						return;
					}
					windowRef.history.pushState({}, '', path);
					windowRef.dispatchEvent(new windowRef.PopStateEvent('popstate'));
				};

	if (
		!documentRef ||
		typeof fetchRef !== 'function' ||
		typeof setIntervalRef !== 'function' ||
		typeof clearIntervalRef !== 'function'
	) {
		return null;
	}

	let pollHandle = null;
	let controller = null;
	let boundRoot = null;
	let live = false;

	const stop = () => {
		live = false;

		if (pollHandle !== null) {
			clearIntervalRef(pollHandle);
			pollHandle = null;
		}

		// Tear down the bound controller so its document-click listener is removed
		// and the next start()/ensureMounted() re-binds cleanly instead of holding
		// a reference to a detached dropdown.
		controller?.teardown?.();
		controller = null;
		boundRoot = null;
	};

	const ensureMounted = () => {
		if (typeof documentRef.querySelector !== 'function') {
			return null;
		}

		const root = documentRef.querySelector('[data-notification]');
		if (!root) {
			return null;
		}

		// Re-bind if the shell (and therefore the bell DOM) was rebuilt — e.g. a
		// logout -> login cycle replaces the node, leaving a stale controller bound
		// to detached elements.
		if (controller && root === boundRoot) {
			return controller;
		}

		const elements = resolveElements(root);
		if (!elements) {
			return null;
		}

		// The shell was rebuilt: drop the previous controller's document-click
		// listener before binding a new one so listeners don't accumulate per
		// re-bind (e.g. across logout -> login cycles).
		controller?.teardown?.();

		root.setAttribute(NOTIFICATION_BOUND_ATTR, 'true');

		boundRoot = root;
		controller = bindNotificationCenter({
			documentRef,
			fetchRef,
			elements,
			onUnauthorized: stop,
			navigate,
		});

		return controller;
	};

	const refresh = async () => {
		const active = ensureMounted();
		if (!active) {
			return null;
		}
		return active.refresh();
	};

	// A push frame or a return to visibility only refreshes while the centre is
	// running, so a stray event after logout cannot resurrect the badge.
	const refreshIfLive = () => {
		if (!live) {
			return;
		}
		void refresh();
	};

	// Bound once for the lifetime of the app, not per start(), because a
	// logout -> login cycle calls start() again and per-start listeners would
	// accumulate. `live` is what gates them.
	if (typeof documentRef.addEventListener === 'function') {
		documentRef.addEventListener(WS_EVENTS.NOTIFICATION, refreshIfLive);
		documentRef.addEventListener('visibilitychange', () => {
			if (documentRef.hidden !== true) {
				refreshIfLive();
			}
		});
	}

	const start = () => {
		if (!ensureMounted()) {
			return;
		}

		live = true;
		void refresh();

		if (pollHandle !== null) {
			return;
		}

		pollHandle = setIntervalRef(() => {
			// A hidden tab has nobody to show the badge to; it refreshes on the
			// visibilitychange back to visible instead.
			if (documentRef.hidden === true) {
				return;
			}
			void refresh();
		}, POLL_INTERVAL_MS);
	};

	const close = () => {
		controller?.close?.();
	};

	const isPolling = () => pollHandle !== null;

	return { start, stop, refresh, close, isPolling };
}
