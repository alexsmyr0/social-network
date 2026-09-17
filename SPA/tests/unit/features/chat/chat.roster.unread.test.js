// Audit Q16 — "did the other user receive a notification?"
//
// A DM used to announce itself only by sliding its row to the top of a roster
// that lists every registered user, which is invisible unless you happen to be
// looking at the top of the list. These cover the unread state that now backs
// the badge on the row and the tally beside the panel heading.

import { describe, expect, test } from 'vitest';
import {
	clearUnread,
	moveToTopForMessage,
	preserveUnread,
	totalUnread,
	unreadCount,
	withPresence,
} from '../../../../features/chat/chat.roster.logic.js';
import {
	renderRosterItem,
	renderRosterList,
	renderRosterUnreadBadge,
} from '../../../../features/chat/chat.roster.views.js';

function roster() {
	return [
		{ user_id: 1, username: 'alpha', is_online: false, last_message_preview: 'hi' },
		{ user_id: 2, username: 'beta', is_online: true, last_message_preview: null },
		{ user_id: 3, username: 'gamma', is_online: false, last_message_preview: 'yo' },
	];
}

describe('unreadCount', () => {
	test('a row from GET /chats carries no unread state and counts as zero', () => {
		expect(unreadCount({ user_id: 1 })).toBe(0);
	});

	test('nonsense values do not leak into the count', () => {
		expect(unreadCount({ unread_count: -3 })).toBe(0);
		expect(unreadCount({ unread_count: 'lots' })).toBe(0);
		expect(unreadCount(null)).toBe(0);
		expect(unreadCount({ unread_count: 4 })).toBe(4);
	});
});

describe('moveToTopForMessage unread flag', () => {
	test('an arriving message for a closed thread increments that row', () => {
		const result = moveToTopForMessage(roster(), 3, 'new one', true);

		expect(result[0].user_id).toBe(3);
		expect(result[0].unread_count).toBe(1);
		// Nobody else is touched.
		expect(result.slice(1).map((e) => unreadCount(e))).toEqual([0, 0]);
	});

	test('successive messages accumulate', () => {
		let entries = roster();
		entries = moveToTopForMessage(entries, 3, 'one', true);
		entries = moveToTopForMessage(entries, 3, 'two', true);
		entries = moveToTopForMessage(entries, 3, 'three', true);

		expect(entries[0].unread_count).toBe(3);
	});

	test('a message that is already on screen does not count as unread', () => {
		const result = moveToTopForMessage(roster(), 3, 'visible', false);

		expect(result[0].user_id).toBe(3);
		expect(unreadCount(result[0])).toBe(0);
	});

	test('reordering without a new message preserves an existing tally', () => {
		const withUnread = moveToTopForMessage(roster(), 3, 'one', true);
		const reordered = moveToTopForMessage(withUnread, 3, 'two', false);

		expect(reordered[0].unread_count).toBe(1);
	});

	test('the input array is never mutated', () => {
		const entries = roster();
		moveToTopForMessage(entries, 3, 'new one', true);

		expect(entries.map((e) => e.user_id)).toEqual([1, 2, 3]);
		expect(entries[2].unread_count).toBeUndefined();
	});
});

describe('clearUnread', () => {
	test('opening a thread zeroes only that row', () => {
		let entries = moveToTopForMessage(roster(), 3, 'a', true);
		entries = moveToTopForMessage(entries, 1, 'b', true);

		const cleared = clearUnread(entries, 3);

		expect(unreadCount(cleared.find((e) => e.user_id === 3))).toBe(0);
		expect(unreadCount(cleared.find((e) => e.user_id === 1))).toBe(1);
	});

	test('returns the same array when there was nothing to clear', () => {
		const entries = roster();
		expect(clearUnread(entries, 2)).toBe(entries);
	});
});

describe('totalUnread', () => {
	test('sums every row so a scrolled-out thread still announces itself', () => {
		let entries = moveToTopForMessage(roster(), 3, 'a', true);
		entries = moveToTopForMessage(entries, 3, 'b', true);
		entries = moveToTopForMessage(entries, 1, 'c', true);

		expect(totalUnread(entries)).toBe(3);
	});

	test('is zero for a fresh roster', () => {
		expect(totalUnread(roster())).toBe(0);
		expect(totalUnread(null)).toBe(0);
	});
});

describe('preserveUnread', () => {
	// A refetch is triggered by an unrelated stranger appearing (issue #50), and
	// server rows carry no unread state — without this it would silently mark
	// every waiting conversation as read.
	test('carries tallies across a refetch', () => {
		const before = moveToTopForMessage(roster(), 3, 'a', true);
		const fromServer = roster();

		const merged = preserveUnread(fromServer, before);

		expect(unreadCount(merged.find((e) => e.user_id === 3))).toBe(1);
	});

	test('rows that disappeared from the roster are simply dropped', () => {
		const before = moveToTopForMessage(roster(), 3, 'a', true);
		const fromServer = [{ user_id: 1, username: 'alpha' }];

		expect(preserveUnread(fromServer, before)).toHaveLength(1);
	});

	test('returns the server rows untouched when nothing was unread', () => {
		const fromServer = roster();
		expect(preserveUnread(fromServer, roster())).toBe(fromServer);
	});
});

describe('unread state survives the presence projection', () => {
	test('withPresence keeps the tally on the row', () => {
		const entries = moveToTopForMessage(roster(), 3, 'a', true);
		const projected = withPresence(entries, new Set([3]));

		expect(projected[0].is_online).toBe(true);
		expect(projected[0].unread_count).toBe(1);
	});
});

describe('rendering', () => {
	test('an unread row carries a visible badge, a count attribute and a modifier', () => {
		const html = renderRosterItem({ user_id: 3, username: 'gamma', unread_count: 2 });

		expect(html).toContain('data-roster-unread');
		expect(html).toContain('data-roster-unread-count="2"');
		expect(html).toContain('chat-roster__item--unread');
		expect(html).toContain('>2</span>');
		expect(html).toContain('aria-label="2 unread messages"');
	});

	test('a read row renders no badge at all', () => {
		const html = renderRosterItem({ user_id: 3, username: 'gamma' });

		expect(html).not.toContain('data-roster-unread"');
		expect(html).toContain('data-roster-unread-count="0"');
		expect(html).not.toContain('chat-roster__item--unread');
	});

	test('one waiting message reads as singular', () => {
		expect(renderRosterItem({ user_id: 3, username: 'gamma', unread_count: 1 })).toContain(
			'aria-label="1 unread message"',
		);
	});

	test('a long-ignored thread caps its badge instead of stretching the row', () => {
		expect(renderRosterItem({ user_id: 3, username: 'gamma', unread_count: 214 })).toContain(
			'>9+</span>',
		);
	});

	test('the roster-wide badge totals every row', () => {
		let entries = moveToTopForMessage(roster(), 3, 'a', true);
		entries = moveToTopForMessage(entries, 1, 'b', true);

		const badge = renderRosterUnreadBadge(entries);

		expect(badge).toContain('data-roster-unread-total');
		expect(badge).toContain('>2</span>');
	});

	test('the roster-wide badge is empty when nothing is waiting', () => {
		expect(renderRosterUnreadBadge(roster())).toBe('');
	});

	test('a username cannot break out of the badge markup', () => {
		const html = renderRosterList([
			{ user_id: 1, username: '<img src=x onerror=alert(1)>', unread_count: 1 },
		]);

		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});
});
