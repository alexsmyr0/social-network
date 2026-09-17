import { API_BASE } from '../../core/api/constants.js';

export async function fetchRoster(fetchRef) {
	if (typeof fetchRef !== 'function') {
		return [];
	}

	try {
		const response = await fetchRef(`${API_BASE}/chats`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response?.ok) {
			return [];
		}

		const payload = await response.json();
		return Array.isArray(payload?.data) ? payload.data : [];
	} catch {
		return [];
	}
}
