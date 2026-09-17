// SPA/tests/unit/features/notification/notification.views.test.js

import { describe, expect, test } from 'vitest';
import {
	buildNotificationMessage,
	renderNotificationBell,
	renderNotificationDropdownHeader,
	renderNotificationItem,
} from '../../../../features/notification/notification.views.js';

describe('notification message formatting', () => {
	test('formats each notification type (preserving legacy copy)', () => {
		const base = { actor_username: 'bob', post_title: 'Title', comment_excerpt: 'snippet' };
		expect(buildNotificationMessage({ ...base, type: 'post_like' })).toContain('liked your post');
		expect(buildNotificationMessage({ ...base, type: 'post_dislike' })).toContain(
			'disliked your post',
		);
		expect(buildNotificationMessage({ ...base, type: 'comment' })).toContain('commented');
		expect(buildNotificationMessage({ ...base, type: 'comment_like' })).toContain(
			'liked your comment',
		);
		expect(buildNotificationMessage({ ...base, type: 'comment_dislike' })).toContain(
			'disliked your comment',
		);
		expect(buildNotificationMessage({ ...base, type: 'unknown' })).toBe('New notification 🔔');
	});

	test('escapes actor and title to prevent HTML injection', () => {
		const message = buildNotificationMessage({
			type: 'post_like',
			actor_username: '<script>',
			post_title: '<b>x</b>',
		});
		expect(message).not.toContain('<script>');
		expect(message).toContain('&lt;script&gt;');
	});

	test('truncates long titles at 20 characters', () => {
		const message = buildNotificationMessage({
			type: 'post_like',
			actor_username: 'bob',
			post_title: 'x'.repeat(50),
		});
		expect(message).toContain('…');
	});
});

describe('notification markup', () => {
	test('bell markup exposes the data hooks the page binds to', () => {
		const markup = renderNotificationBell();
		expect(markup).toContain('data-notification');
		expect(markup).toContain('data-notification-bell');
		expect(markup).toContain('data-notification-badge');
		expect(markup).toContain('data-notification-dropdown');
	});

	test('dropdown header shows mark-all only when there are unread items', () => {
		expect(renderNotificationDropdownHeader({ showMarkAll: true })).toContain(
			'data-notification-mark-all',
		);
		expect(renderNotificationDropdownHeader({ showMarkAll: false })).not.toContain(
			'data-notification-mark-all',
		);
	});

	test('unread items carry the unread modifier and id', () => {
		const markup = renderNotificationItem({
			id: 42,
			type: 'post_like',
			actor_username: 'bob',
			is_read: false,
		});
		expect(markup).toContain('notification__item--unread');
		expect(markup).toContain('data-notification-id="42"');

		const read = renderNotificationItem({ id: 7, type: 'post_like', is_read: true });
		expect(read).not.toContain('notification__item--unread');
	});
});
