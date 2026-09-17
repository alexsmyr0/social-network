// SPA/features/notification/notification.api.js

import { API_BASE } from '../../core/api/constants.js';

const NOTIFICATIONS_PATH = `${API_BASE}/notifications`;

function asNotifications(payload) {
	const list = payload?.data?.notifications;
	return Array.isArray(list) ? list : [];
}

function asUnreadCount(payload) {
	const count = Number(payload?.data?.unread_count);
	return Number.isFinite(count) && count > 0 ? count : 0;
}

export async function loadNotifications(fetchRef) {
	try {
		const response = await fetchRef(NOTIFICATIONS_PATH, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			return { ok: false, status: response.status, notifications: [], unreadCount: 0 };
		}

		const payload = await response.json();
		return {
			ok: true,
			status: response.status,
			notifications: asNotifications(payload),
			unreadCount: asUnreadCount(payload),
		};
	} catch {
		return { ok: false, status: 0, notifications: [], unreadCount: 0 };
	}
}

export async function markNotificationRead(fetchRef, notificationId) {
	try {
		const response = await fetchRef(`${NOTIFICATIONS_PATH}/${notificationId}/read`, {
			method: 'PATCH',
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}

export async function markAllNotificationsRead(fetchRef) {
	try {
		const response = await fetchRef(`${NOTIFICATIONS_PATH}/read-all`, {
			method: 'PATCH',
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}
