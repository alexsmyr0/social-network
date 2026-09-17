// SPA/core/state/app-state.js
//
// The single application-wide store instance (SDS § 7.0, issue #76).
//
// Slots live here; the behaviour that reads and writes them lives in the slice
// modules next door (`session.js`, `presence.js`). Keeping the instance in its
// own module means the slices can import it without importing each other.
//
// Slot contract:
//   isAuthenticated — has the session cookie been accepted by GET /users/me
//   currentUserId   — the signed-in user's id, 0 until resolved
//   onlineUserIds   — Set of user ids currently online, REPLACED never mutated,
//                     so the store's Object.is check sees the change
//   hasPresenceSnapshot — whether a presence.snapshot frame has been applied;
//                     once it has, the REST roster's is_online is stale data

import { createStore } from './store.js';

// Shared empty seed. Never mutated — presence writes always swap in a new Set —
// so reset() can safely hand this exact instance back out.
const NO_ONLINE_USERS = new Set();

export const appState = createStore({
	isAuthenticated: false,
	currentUserId: 0,
	onlineUserIds: NO_ONLINE_USERS,
	hasPresenceSnapshot: false,
});

// Slices that keep a cache the store cannot see (an in-flight request, say)
// register a teardown here so `resetAppState()` stays the one reset entry point.
const resetHooks = new Set();

export function onAppStateReset(hook) {
	if (typeof hook !== 'function') {
		return () => {};
	}
	resetHooks.add(hook);
	return () => resetHooks.delete(hook);
}

// Rolls every slot back to its construction-time value and clears slice caches.
// Production uses this on logout/401; tests use it to stop one case's state
// leaking into the next.
export function resetAppState() {
	appState.reset();
	for (const hook of [...resetHooks]) {
		hook();
	}
}
