// SPA/features/chat/chat.roster.logic.js
//
// Pure state transitions for the live roster. Each helper takes the current
// entries array and returns a NEW array (immutable updates via array-by-copy),
// so the page layer can diff/re-render without worrying about shared mutation.

function entryId(entry) {
	return Number(entry?.user_id ?? 0);
}

// Projects the store's presence slice (`core/state/presence.js`) onto the
// roster rows. Presence itself is NOT owned here any more (issue #76): this is
// only the render-time mapping from "set of online ids" to per-row is_online.
export function withPresence(entries, onlineIds) {
	if (!Array.isArray(entries)) {
		return [];
	}

	const online = onlineIds instanceof Set ? onlineIds : new Set();
	return entries.map((entry) => ({ ...entry, is_online: online.has(entryId(entry)) }));
}

// Whether a user id already has a row. Drives the refetch that admits users who
// registered after this roster was loaded (issue #50).
export function hasEntry(entries, userId) {
	const target = Number(userId ?? 0);
	return Array.isArray(entries) && entries.some((entry) => entryId(entry) === target);
}

// Roster preview text for a live DM frame: the trimmed body, or a "[image]"
// glyph for an image-only message (empty body + image attachment). Mirrors the
// C05 roster SQL so a live update and a refetch render the same preview.
export function previewForMessage(message) {
	const body = String(message?.body ?? '').trim();
	if (body.length > 0) {
		return body;
	}
	const imageUrl = message?.image_url;
	return typeof imageUrl === 'string' && imageUrl.length > 0 ? '[image]' : '';
}

// Message activity (sent or received) moves the conversation partner to the top
// of the roster and refreshes their last-message preview — mirroring the
// backend C05 ordering (most-recent-message first) without a refetch.
//
// `markUnread` adds one to that row's unread tally. It is set only for a
// message that ARRIVED for a thread the user is not currently reading; a
// message the user sent, or one landing in the open conversation, is already
// on screen and is not news.
export function moveToTopForMessage(entries, otherUserId, preview, markUnread = false) {
	if (!Array.isArray(entries)) {
		return [];
	}

	const target = Number(otherUserId ?? 0);
	const index = entries.findIndex((entry) => entryId(entry) === target);
	if (index === -1) {
		return entries.slice();
	}

	const current = entries[index];
	const updated = {
		...current,
		last_message_preview:
			typeof preview === 'string' && preview.length > 0 ? preview : current.last_message_preview,
		unread_count: markUnread ? unreadCount(current) + 1 : unreadCount(current),
	};

	return [updated, ...entries.slice(0, index), ...entries.slice(index + 1)];
}

// Reads a row's unread tally defensively: rows arriving from GET /chats carry
// no `unread_count` at all, and the count is client-owned.
export function unreadCount(entry) {
	const count = Number(entry?.unread_count ?? 0);
	return Number.isFinite(count) && count > 0 ? count : 0;
}

// Opening a conversation reads everything waiting in it.
export function clearUnread(entries, userId) {
	if (!Array.isArray(entries)) {
		return [];
	}

	const target = Number(userId ?? 0);
	let changed = false;
	const next = entries.map((entry) => {
		if (entryId(entry) !== target || unreadCount(entry) === 0) {
			return entry;
		}
		changed = true;
		return { ...entry, unread_count: 0 };
	});

	return changed ? next : entries;
}

// Total across the roster, for the always-visible badge on the panel heading.
// A row scrolled out of sight still has to be able to announce itself — that
// was the whole failure mode: an incoming DM only reordered rows, which is
// invisible unless you happen to be looking at the top of the list.
export function totalUnread(entries) {
	if (!Array.isArray(entries)) {
		return 0;
	}
	return entries.reduce((sum, entry) => sum + unreadCount(entry), 0);
}

// Carries client-owned unread tallies across a roster refetch, which returns
// server rows with no unread state. Without this, a refetch triggered by an
// unrelated stranger appearing would silently mark every conversation read.
export function preserveUnread(nextEntries, previousEntries) {
	if (!Array.isArray(nextEntries)) {
		return [];
	}
	if (!Array.isArray(previousEntries) || previousEntries.length === 0) {
		return nextEntries;
	}

	const carried = new Map();
	for (const entry of previousEntries) {
		const count = unreadCount(entry);
		if (count > 0) {
			carried.set(entryId(entry), count);
		}
	}
	if (carried.size === 0) {
		return nextEntries;
	}

	return nextEntries.map((entry) => {
		const count = carried.get(entryId(entry)) ?? 0;
		return count > 0 ? { ...entry, unread_count: count } : entry;
	});
}
