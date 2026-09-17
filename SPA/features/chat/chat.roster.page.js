import { WS_EVENTS } from '../../core/realtime/chat-socket.js';
import {
	ensurePresenceBridge,
	getOnlineUserIds,
	seedPresenceFromRoster,
	subscribePresence,
} from '../../core/state/presence.js';
import { ensureCurrentUserId, getCurrentUserId } from '../../core/state/session.js';
import { CONVERSATION_CLOSED_EVENT } from './chat.conversation.page.js';
import { fetchRoster } from './chat.roster.api.js';
import {
	clearUnread,
	hasEntry,
	moveToTopForMessage,
	preserveUnread,
	previewForMessage,
	withPresence,
} from './chat.roster.logic.js';
import { renderRosterList, renderRosterUnreadBadge } from './chat.roster.views.js';

const ROSTER_BOUND_ATTR = 'data-roster-bound';
const ROSTER_ROOT_SELECTOR = '[data-chat-roster]';
const ROSTER_LIST_ID = 'roster-list';
const ROW_SELECTOR = '[data-roster-user-id]';
const UNREAD_SLOT_SELECTOR = '[data-roster-unread-slot]';

// A user who registered after this roster was fetched has no row, so presence
// and dm frames about them would otherwise be dropped on the floor (issue #50).
// The refetch is debounced because a burst of frames (a fresh presence snapshot
// listing several strangers) must cost one request, not one per stranger.
const UNKNOWN_USER_REFETCH_MS = 400;

function clearSelection(rosterRoot) {
	if (typeof rosterRoot.querySelectorAll !== 'function') {
		return;
	}
	for (const node of rosterRoot.querySelectorAll('[aria-pressed="true"]')) {
		node.setAttribute('aria-pressed', 'false');
		node.classList?.remove('is-selected');
	}
}

function markSelected(row) {
	row.setAttribute('aria-pressed', 'true');
	row.classList?.add('is-selected');
}

function emitSelection(row) {
	const userId = Number(row.getAttribute('data-roster-user-id') ?? 0);
	const username = row.getAttribute('data-roster-username') ?? '';
	const isOnline = row.getAttribute('data-roster-online') === 'true';

	row.dispatchEvent(
		new CustomEvent('chat:user-selected', {
			detail: { userId, username, isOnline },
			bubbles: true,
		}),
	);

	return userId;
}

export function initChatRoster(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const fetchRef = options.fetchRef ?? (typeof fetch === 'function' ? fetch : null);

	if (
		!windowRef ||
		!documentRef ||
		typeof fetchRef !== 'function' ||
		typeof documentRef.querySelector !== 'function'
	) {
		return null;
	}

	const rosterRoot = documentRef.querySelector(ROSTER_ROOT_SELECTOR);
	if (!rosterRoot) {
		return null;
	}

	if (rosterRoot.getAttribute(ROSTER_BOUND_ATTR) === 'true') {
		return null;
	}

	rosterRoot.setAttribute(ROSTER_BOUND_ATTR, 'true');

	const setTimeoutRef =
		options.setTimeoutRef ??
		(typeof windowRef.setTimeout === 'function'
			? windowRef.setTimeout.bind(windowRef)
			: typeof setTimeout === 'function'
				? setTimeout
				: null);

	// Rows and their ordering are owned here; is_online is NOT — that is
	// projected from the presence store at render time (issue #76).
	//
	// `openUserId` is the conversation actually on screen, which is not the same
	// as `selectedUserId`: closing the thread with the back arrow leaves the row
	// selected but stops it being read, so a message arriving afterwards must
	// still count as unread.
	const state = { entries: [], selectedUserId: 0, openUserId: 0 };

	// Presence frames name user ids, not roster rows. Ids we have already tried
	// (and failed) to resolve stay suppressed so a viewer's own id — which is
	// online but deliberately absent from their own roster — cannot spin the
	// refetch forever.
	const attemptedUnknownIds = new Set();
	let refetchTimer = null;

	// Re-applies the active selection after innerHTML rebuilds the rows, looking
	// the row up by id since the previously selected element no longer exists.
	function reapplySelection() {
		clearSelection(rosterRoot);
		if (!state.selectedUserId) {
			return;
		}
		const selected = rosterRoot.querySelector?.(`[data-roster-user-id="${state.selectedUserId}"]`);
		if (selected) {
			markSelected(selected);
		}
	}

	function renderRoster() {
		const unreadSlot = rosterRoot.querySelector?.(UNREAD_SLOT_SELECTOR);
		if (unreadSlot) {
			unreadSlot.innerHTML = renderRosterUnreadBadge(state.entries);
		}

		const listMount = rosterRoot.querySelector?.(`#${ROSTER_LIST_ID}`);
		if (!listMount) {
			return;
		}
		listMount.innerHTML = renderRosterList(withPresence(state.entries, getOnlineUserIds()));
		reapplySelection();
	}

	async function reloadRoster() {
		const entries = await fetchRoster(fetchRef);
		if (entries.length === 0) {
			// A failed or empty refetch must not wipe the rows already on screen.
			return;
		}
		// Server rows carry no unread state, so a refetch triggered by an
		// unrelated stranger appearing would otherwise mark everything read.
		state.entries = preserveUnread(entries, state.entries);
		seedPresenceFromRoster(entries);
		// Anyone the refetch actually admitted becomes eligible again; ids still
		// missing stay suppressed so they cannot re-trigger the debounce.
		for (const id of [...attemptedUnknownIds]) {
			if (hasEntry(state.entries, id)) {
				attemptedUnknownIds.delete(id);
			}
		}
		renderRoster();
	}

	// Schedules the debounced refetch when `userId` has no row yet.
	function admitUnknownUser(userId) {
		const id = Number(userId ?? 0);
		if (!Number.isFinite(id) || id <= 0) {
			return;
		}

		// Until GET /users/me resolves, the viewer's own id is indistinguishable
		// from a stranger's — and the viewer is online but never in their own
		// roster, so guessing wrong costs a refetch on every page load. Frames
		// seen during that window are replayed once identity is known.
		const me = getCurrentUserId();
		if (me === 0 || id === me) {
			return;
		}

		if (hasEntry(state.entries, id) || attemptedUnknownIds.has(id)) {
			return;
		}

		attemptedUnknownIds.add(id);
		if (typeof setTimeoutRef !== 'function' || refetchTimer !== null) {
			return;
		}

		refetchTimer = setTimeoutRef(() => {
			refetchTimer = null;
			void reloadRoster();
		}, UNKNOWN_USER_REFETCH_MS);
	}

	function selectFromRow(row) {
		if (!row) {
			return;
		}
		clearSelection(rosterRoot);
		markSelected(row);
		state.selectedUserId = emitSelection(row);
		state.openUserId = state.selectedUserId;

		// Opening the thread reads it. Only repaint when something was actually
		// waiting, so a plain selection does not rebuild every row.
		const cleared = clearUnread(state.entries, state.openUserId);
		if (cleared !== state.entries) {
			state.entries = cleared;
			renderRoster();
		}
	}

	rosterRoot.addEventListener('click', (event) => {
		selectFromRow(event.target?.closest?.(ROW_SELECTOR));
	});

	rosterRoot.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') {
			return;
		}
		const row = event.target?.closest?.(ROW_SELECTOR);
		if (!row) {
			return;
		}
		event.preventDefault?.();
		selectFromRow(row);
	});

	// --- Live WebSocket-driven updates (D04) ---------------------------------
	// Presence frames land in the store via the shared bridge; the roster just
	// repaints from it and asks for a refetch when a stranger shows up.
	ensurePresenceBridge(documentRef);

	subscribePresence((onlineIds, previousOnlineIds) => {
		// Either direction names a user worth having a row for, so both the ids
		// that appeared and the ids that dropped out are candidates.
		for (const id of onlineIds) {
			if (!previousOnlineIds?.has?.(id)) {
				admitUnknownUser(id);
			}
		}
		for (const id of previousOnlineIds ?? []) {
			if (!onlineIds.has(id)) {
				admitUnknownUser(id);
			}
		}
		renderRoster();
	});

	if (typeof documentRef.addEventListener === 'function') {
		documentRef.addEventListener(WS_EVENTS.DM_MESSAGE, (event) => {
			const message = event?.detail?.message;
			if (!message) {
				return;
			}
			void ensureCurrentUserId(fetchRef).then((me) => {
				const senderId = Number(message.sender_id ?? 0);
				const recipientId = Number(message.recipient_id ?? 0);
				const otherUserId = senderId === me ? recipientId : senderId;
				// A DM from someone who is not in the roster yet is the other way
				// a new user can appear (issue #50).
				admitUnknownUser(otherUserId);

				// Unread means: it arrived (the backend echoes our own sends back
				// through the same frame) AND its thread is not the one on screen.
				const isIncoming = senderId !== me;
				const isUnread = isIncoming && otherUserId !== state.openUserId;

				state.entries = moveToTopForMessage(
					state.entries,
					otherUserId,
					previewForMessage(message),
					isUnread,
				);
				renderRoster();
			});
		});

		// Closing the thread with the back arrow leaves the row selected but no
		// longer being read, so later messages have to count as unread again.
		documentRef.addEventListener(CONVERSATION_CLOSED_EVENT, () => {
			state.openUserId = 0;
		});
	}

	void (async () => {
		// The current user id is resolved eagerly so `admitUnknownUser` can tell
		// the viewer's own presence apart from a genuine stranger's.
		const [, entries] = await Promise.all([ensureCurrentUserId(fetchRef), fetchRoster(fetchRef)]);
		state.entries = entries;
		seedPresenceFromRoster(entries);
		renderRoster();

		// Replay whatever presence already arrived: frames that landed before the
		// identity and the roster were known were deliberately not acted on.
		for (const id of getOnlineUserIds()) {
			admitUnknownUser(id);
		}
	})();

	return { rosterRoot };
}
