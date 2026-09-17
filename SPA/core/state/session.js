// SPA/core/state/session.js
//
// Session/auth slice of the global store (SDS § 7.0, issue #76).
//
// Before this slice, `isAuthenticated` lived in a `create-app.js` closure and
// the signed-in user id was resolved independently — and cached independently —
// by both `chat.roster.page.js` and `chat.conversation.page.js`, so a single
// page load issued two GET /users/me requests. Both now read one slot.

import { fetchCurrentUserId } from '../api/session.api.js';
import { appState, onAppStateReset } from './app-state.js';

// Deduplicates concurrent resolutions: the roster and the conversation both ask
// for the current user id during the same tick on first paint.
let inFlightUserId = null;

onAppStateReset(() => {
	inFlightUserId = null;
});

export function isAuthenticated() {
	return Boolean(appState.get('isAuthenticated'));
}

export function setAuthenticated(value) {
	appState.state.isAuthenticated = Boolean(value);
}

// 0 until GET /users/me has resolved. Callers that need to await it use
// `ensureCurrentUserId`; this is for synchronous reads that tolerate 0.
export function getCurrentUserId() {
	return appState.get('currentUserId');
}

// Resolves (and caches) the signed-in user id. A failed lookup is NOT cached —
// it clears the in-flight slot so the next caller retries rather than being
// permanently stuck with an unknown identity.
export function ensureCurrentUserId(fetchRef) {
	const known = getCurrentUserId();
	if (known > 0) {
		return Promise.resolve(known);
	}

	if (!inFlightUserId) {
		inFlightUserId = fetchCurrentUserId(fetchRef).then((id) => {
			inFlightUserId = null;
			const resolved = Number.isFinite(id) ? Number(id) : 0;
			if (resolved > 0) {
				appState.state.currentUserId = resolved;
				return resolved;
			}
			return null;
		});
	}

	return inFlightUserId;
}

// Logout / 401: drop the identity and the auth flag together so nothing keeps
// rendering the previous user's messages as "own".
export function clearSession() {
	inFlightUserId = null;
	appState.set({ isAuthenticated: false, currentUserId: 0 });
}

export function subscribeAuth(listener) {
	return appState.subscribe('isAuthenticated', listener);
}
