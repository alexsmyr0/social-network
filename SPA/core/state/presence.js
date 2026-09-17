// SPA/core/state/presence.js
//
// Presence slice of the global store (SDS § 7.0, issue #76) and the fix for the
// frozen composer in issue #50.
//
// Presence used to exist only as `is_online` flags inside the roster's private
// entries array, so anything that was not the roster list — the open
// conversation's header and composer above all — could never learn that the
// other party had just come online or dropped off. Presence now lives in one
// store slot that every interested slice subscribes to.
//
// The slot holds a Set of online user ids and is REPLACED on every change (never
// mutated), because the store compares slots with `Object.is`.

import { WS_EVENTS } from '../realtime/chat-socket.js';
import { appState } from './app-state.js';

// One bridge per document. Both chat slices call `ensurePresenceBridge` during
// init so presence works regardless of which one mounts first, and the WeakSet
// keeps the second call a no-op instead of double-applying every frame.
const bridgedDocuments = new WeakSet();

function toUserId(value) {
	const id = Number(value ?? 0);
	return Number.isFinite(id) && id > 0 ? id : 0;
}

export function getOnlineUserIds() {
	return appState.get('onlineUserIds');
}

export function isUserOnline(userId) {
	const id = toUserId(userId);
	return id > 0 && getOnlineUserIds().has(id);
}

// presence.update — flips one user. A frame that repeats what we already know
// writes nothing, so subscribers are not woken for a no-op.
export function setUserPresence(userId, isOnline) {
	const id = toUserId(userId);
	if (id === 0) {
		return;
	}

	const current = getOnlineUserIds();
	const online = Boolean(isOnline);
	if (current.has(id) === online) {
		return;
	}

	const next = new Set(current);
	if (online) {
		next.add(id);
	} else {
		next.delete(id);
	}
	appState.state.onlineUserIds = next;
}

// presence.snapshot — the authoritative full list. Anyone absent is offline, so
// this REPLACES the slot rather than merging into it.
export function applyPresenceSnapshot(users) {
	// Recorded even when the set turns out to be unchanged: what matters
	// downstream is that the socket has spoken, not that anything moved.
	appState.state.hasPresenceSnapshot = true;

	const next = new Set(
		(Array.isArray(users) ? users : [])
			.filter((user) => Boolean(user?.is_online))
			.map((user) => toUserId(user?.user_id))
			.filter((id) => id > 0),
	);

	const current = getOnlineUserIds();
	if (current.size === next.size && [...next].every((id) => current.has(id))) {
		return;
	}
	appState.state.onlineUserIds = next;
}

// Seeds presence from a REST roster payload so the store is populated before
// the first WebSocket frame arrives.
//
// The GET /chats response carries the backend's presence registry as it was at
// query time, which the socket may already have moved on from. A presence
// snapshot is complete and authoritative, so once one has landed this payload is
// stale by definition and is ignored rather than allowed to resurrect a user who
// has since gone offline.
export function seedPresenceFromRoster(entries) {
	if (!Array.isArray(entries) || entries.length === 0 || appState.get('hasPresenceSnapshot')) {
		return;
	}

	const current = getOnlineUserIds();
	const next = new Set(current);
	for (const entry of entries) {
		const id = toUserId(entry?.user_id);
		if (id === 0) {
			continue;
		}
		if (entry?.is_online) {
			next.add(id);
		} else {
			next.delete(id);
		}
	}

	if (current.size === next.size && [...next].every((id) => current.has(id))) {
		return;
	}
	appState.state.onlineUserIds = next;
}

// Listener signature: (onlineUserIds, previousOnlineUserIds). Returns the
// unsubscribe function.
export function subscribePresence(listener) {
	return appState.subscribe('onlineUserIds', listener);
}

// Pipes the socket's presence DOM events into the store. This is the only place
// that translates transport frames into presence state — slices read the store.
export function ensurePresenceBridge(documentRef) {
	if (!documentRef || typeof documentRef.addEventListener !== 'function') {
		return false;
	}

	if (bridgedDocuments.has(documentRef)) {
		return false;
	}
	bridgedDocuments.add(documentRef);

	documentRef.addEventListener(WS_EVENTS.PRESENCE_SNAPSHOT, (event) => {
		applyPresenceSnapshot(event?.detail?.users);
	});

	documentRef.addEventListener(WS_EVENTS.PRESENCE_UPDATE, (event) => {
		const detail = event?.detail;
		if (!detail) {
			return;
		}
		setUserPresence(detail.userId, detail.isOnline);
	});

	return true;
}
