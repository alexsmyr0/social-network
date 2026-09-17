// SPA/features/notification/notification.views.js

import { escapeHTML } from '../../core/utils/html.js';

function truncate(value, length = 20) {
	const text = typeof value === 'string' ? value : '';
	if (!text) return '';
	return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function buildNotificationMessage(notification) {
	const actor = escapeHTML(notification?.actor_username ?? 'Someone');
	const title = `<strong>${escapeHTML(truncate(notification?.post_title))}</strong>`;
	const excerpt = `<em>${escapeHTML(truncate(notification?.comment_excerpt))}</em>`;

	switch (notification?.type) {
		case 'post_like':
			return `${actor} liked your post: ${title} 👍`;
		case 'post_dislike':
			return `${actor} disliked your post: ${title} 👎`;
		case 'comment':
			return `${actor} commented ${excerpt} on ${title} 💬`;
		case 'comment_like':
			return `${actor} liked your comment: ${excerpt} 👍`;
		case 'comment_dislike':
			return `${actor} disliked your comment: ${excerpt} 👎`;
		default:
			return 'New notification 🔔';
	}
}

export function renderNotificationBell() {
	return `
		<div class="notification" data-notification>
			<button
				class="notification__bell"
				type="button"
				data-notification-bell
				aria-haspopup="true"
				aria-expanded="false"
				aria-label="Notifications"
			>
				<img class="notification__bell-icon" src="/assets/img/bell.png" alt="" aria-hidden="true" />
				<span class="notification__badge hidden" data-notification-badge aria-hidden="true"></span>
			</button>
			<div class="notification__dropdown hidden" data-notification-dropdown role="menu" hidden></div>
		</div>
	`;
}

export function renderNotificationDropdownHeader({ showMarkAll }) {
	const markAll = showMarkAll
		? '<button class="notification__mark-all" type="button" data-notification-mark-all>Mark all as read</button>'
		: '';

	return `
		<div class="notification__header">
			<span class="notification__header-title">Notifications</span>
			${markAll}
		</div>
	`;
}

export function renderNotificationEmpty() {
	return '<div class="notification__empty">No notifications yet.</div>';
}

function dataAttr(name, value) {
	if (value === null || value === undefined || value === '') {
		return '';
	}
	return `${name}="${escapeHTML(String(value))}"`;
}

export function renderNotificationItem(notification) {
	const isUnread = !notification?.is_read;
	const unreadClass = isUnread ? ' notification__item--unread' : '';
	const id = escapeHTML(String(notification?.id ?? ''));
	const type = dataAttr('data-notification-type', notification?.type);
	const postId = dataAttr('data-notification-post-id', notification?.post_id);
	const commentId = dataAttr('data-notification-comment-id', notification?.comment_id);

	return `
		<div
			class="notification__item${unreadClass}"
			data-notification-item
			data-notification-id="${id}"
			${type}
			${postId}
			${commentId}
			role="menuitem"
			tabindex="0"
		>
			${buildNotificationMessage(notification)}
		</div>
	`;
}
