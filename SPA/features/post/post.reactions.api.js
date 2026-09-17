import { API_BASE } from '../../core/api/constants.js';

export async function getCurrentUser(fetchRef) {
	try {
		const response = await fetchRef(`${API_BASE}/users/me`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			return null;
		}

		const payload = await response.json();
		return payload?.data ?? {};
	} catch {
		return null;
	}
}

export async function postReaction(fetchRef, { type, postId, commentId }) {
	const url = postId
		? `${API_BASE}/posts/${postId}/${type}`
		: `${API_BASE}/comments/${commentId}/${type}`;

	try {
		return await fetchRef(url, {
			method: 'POST',
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
	} catch {
		return null;
	}
}
