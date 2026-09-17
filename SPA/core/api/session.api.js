import { API_BASE } from './constants.js';

// GET /api/v1/users/me — the signed-in user's identity.
//
// Lives in core rather than a feature slice because more than one slice needs
// it (chat renders own/incoming messages differently, and `core/state/session`
// caches the result app-wide). Returns null on any failure so callers can tell
// "not resolved" from a real id.
export async function fetchCurrentUserId(fetchRef) {
	if (typeof fetchRef !== 'function') {
		return null;
	}

	try {
		const response = await fetchRef(`${API_BASE}/users/me`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response?.ok) {
			return null;
		}

		const payload = await response.json();
		const id = payload?.data?.id;
		return Number.isFinite(id) ? Number(id) : null;
	} catch {
		return null;
	}
}
