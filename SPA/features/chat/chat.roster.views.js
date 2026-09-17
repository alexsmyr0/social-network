// SPA/features/chat/chat.roster.views.js
//
// Markup for the persistent chat roster (D01).
//
// Each entry renders two SIBLING interactive elements inside the <li>:
//   1. `.chat-roster__item` — the DM-open button, carrying the
//      `data-roster-user-id` hook that `chat.roster.page.js` binds to.
//   2. `.chat-roster__profile` — a `data-link` anchor to the user's profile
//      (A07 / issue #68).
//
// They MUST stay siblings rather than nesting the anchor inside the row. A
// nested anchor is matched by BOTH the roster row handler and the global
// `a[data-link]` router handler in `core/app/create-app.js`, so a single click
// opened the conversation and then immediately routed away to the profile.
// Keeping them apart means `closest('[data-roster-user-id]')` misses clicks on
// the profile link and `closest('a[data-link]')` misses clicks on the row, so
// each affordance does exactly one thing. It also keeps the focusable anchor
// out of the `role="button"` subtree, which ARIA forbids.

import { escapeHTML } from '../../core/utils/html.js';
import { totalUnread, unreadCount } from './chat.roster.logic.js';

// Counts above this render as "9+" so a long-ignored thread cannot stretch the
// row or the heading badge.
const UNREAD_DISPLAY_CAP = 9;

function unreadLabel(count) {
	return count > UNREAD_DISPLAY_CAP ? `${UNREAD_DISPLAY_CAP}+` : String(count);
}

const PROFILE_GLYPH = `
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
		<circle cx="8" cy="5.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.5" />
		<path d="M2.75 14a5.25 5.25 0 0 1 10.5 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
	</svg>
`;

export function renderRosterItem(entry) {
	const userId = Number(entry?.user_id ?? 0);
	const username = String(entry?.username ?? '');
	const isOnline = Boolean(entry?.is_online);
	const presenceLabel = isOnline ? 'online' : 'offline';
	const presenceClass = isOnline
		? 'chat-roster__presence chat-roster__presence--online'
		: 'chat-roster__presence chat-roster__presence--offline';
	const itemClass = isOnline
		? 'chat-roster__item chat-roster__item--online'
		: 'chat-roster__item chat-roster__item--offline';

	const rawPreview = entry?.last_message_preview;
	const previewMarkup =
		typeof rawPreview === 'string' && rawPreview.length > 0
			? `<span class="chat-roster__preview">${escapeHTML(rawPreview)}</span>`
			: '';

	// Unread badge (audit Q16). A DM used to announce itself only by reordering
	// the roster, which is invisible in a list this long — the row now carries a
	// count, and the row itself is marked so it can be styled as unread.
	const unread = unreadCount(entry);
	const unreadMarkup = unread
		? `<span class="chat-roster__unread" data-roster-unread aria-label="${unread} unread ${unread === 1 ? 'message' : 'messages'}">${unreadLabel(unread)}</span>`
		: '';
	const unreadClass = unread ? ' chat-roster__item--unread' : '';

	return `
		<li class="chat-roster__entry">
			<div class="${itemClass}${unreadClass}"
				data-roster-user-id="${userId}"
				data-roster-username="${escapeHTML(username)}"
				data-roster-online="${isOnline ? 'true' : 'false'}"
				data-roster-unread-count="${unread}"
				tabindex="0"
				role="button"
				aria-pressed="false">
				<span class="${presenceClass}" aria-label="${presenceLabel}"></span>
				<span class="chat-roster__name">${escapeHTML(username)}</span>
				${previewMarkup}
				${unreadMarkup}
			</div>
			<a class="chat-roster__profile profile-link"
				data-link
				href="/profile/${userId}"
				data-roster-profile-link
				title="View profile"
				aria-label="View ${escapeHTML(username)}'s profile">${PROFILE_GLYPH}</a>
		</li>
	`;
}

export function renderRosterList(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		return '<p class="chat-panel__empty">No other users yet</p>';
	}

	const items = entries.map((entry) => renderRosterItem(entry)).join('');
	return `<ul class="chat-roster" data-roster-list>${items}</ul>`;
}

// The roster-wide tally, rendered next to the panel heading. The per-row badge
// is useless on its own here: the roster lists every registered user, so the
// row that just went unread is very often scrolled out of view.
export function renderRosterUnreadBadge(entries) {
	const total = totalUnread(entries);
	if (total === 0) {
		return '';
	}

	return `<span class="chat-panel__unread" data-roster-unread-total aria-label="${total} unread ${total === 1 ? 'message' : 'messages'}">${unreadLabel(total)}</span>`;
}
