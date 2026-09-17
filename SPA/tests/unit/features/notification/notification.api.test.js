// SPA/tests/unit/features/notification/notification.api.test.js

import { describe, expect, test, vi } from 'vitest';
import {
	loadNotifications,
	markAllNotificationsRead,
	markNotificationRead,
} from '../../../../features/notification/notification.api.js';

describe('notification api', () => {
	test('loadNotifications returns notifications and unread count', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { notifications: [{ id: 1 }], unread_count: 3 } }),
		}));

		const result = await loadNotifications(fetchRef);

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications',
			expect.objectContaining({ credentials: 'include' }),
		);
		expect(result).toEqual({ ok: true, status: 200, notifications: [{ id: 1 }], unreadCount: 3 });
	});

	test('loadNotifications surfaces non-ok status without throwing', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
		const result = await loadNotifications(fetchRef);
		expect(result).toEqual({ ok: false, status: 401, notifications: [], unreadCount: 0 });
	});

	test('loadNotifications handles network errors gracefully', async () => {
		const fetchRef = vi.fn(async () => {
			throw new Error('offline');
		});
		const result = await loadNotifications(fetchRef);
		expect(result).toEqual({ ok: false, status: 0, notifications: [], unreadCount: 0 });
	});

	test('markNotificationRead PATCHes the per-id endpoint', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const result = await markNotificationRead(fetchRef, 9);

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications/9/read',
			expect.objectContaining({ method: 'PATCH', credentials: 'include' }),
		);
		expect(result).toEqual({ ok: true, status: 204 });
	});

	test('markAllNotificationsRead PATCHes the read-all endpoint', async () => {
		const fetchRef = vi.fn(async () => ({ ok: true, status: 204 }));
		const result = await markAllNotificationsRead(fetchRef);

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/notifications/read-all',
			expect.objectContaining({ method: 'PATCH', credentials: 'include' }),
		);
		expect(result).toEqual({ ok: true, status: 204 });
	});
});
