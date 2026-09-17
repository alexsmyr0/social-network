import { API_BASE } from '../../core/api/constants.js';

// `ok` distinguishes a successful fetch (even one that legitimately returns no
// messages) from a transient failure (bad args, non-ok response, network
// throw). Callers paging history MUST NOT treat a transient failure as
// end-of-history, or scroll-up loading dead-ends permanently.
const FAILED_CONVERSATION = { ok: false, messages: [], hasMore: false };

// C03 history endpoint: GET /api/v1/chats/:id/messages -> chronological batch of 10.
// Pass { beforeId } to page backwards: returns the 10 messages older than that id.
export async function fetchConversation(fetchRef, userId, { beforeId } = {}) {
	if (typeof fetchRef !== 'function' || !Number.isFinite(userId) || userId <= 0) {
		return { ...FAILED_CONVERSATION };
	}

	let path = `${API_BASE}/chats/${userId}/messages`;
	if (Number.isFinite(beforeId) && beforeId > 0) {
		path += `?before_id=${beforeId}`;
	}

	try {
		const response = await fetchRef(path, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response?.ok) {
			return { ...FAILED_CONVERSATION };
		}

		const payload = await response.json();
		const data = payload?.data ?? {};
		return {
			ok: true,
			messages: Array.isArray(data.messages) ? data.messages : [],
			hasMore: Boolean(data.has_more),
		};
	} catch {
		return { ...FAILED_CONVERSATION };
	}
}

// C09 upload endpoint: POST /api/v1/chats/:id/images with a single `image`
// multipart field. Returns the saved image URL the caller then attaches to a
// dm.send frame, or '' on any failure so the composer can surface the error.
export async function uploadDMImage(fetchRef, userId, file) {
	if (typeof fetchRef !== 'function' || !Number.isFinite(userId) || userId <= 0 || !file) {
		return '';
	}

	const formData = new FormData();
	formData.append('image', file);

	try {
		const response = await fetchRef(`${API_BASE}/chats/${userId}/images`, {
			method: 'POST',
			credentials: 'include',
			headers: { Accept: 'application/json' },
			body: formData,
		});

		if (!response?.ok) {
			return '';
		}

		const payload = await response.json();
		const url = payload?.data?.image_url;
		return typeof url === 'string' ? url : '';
	} catch {
		return '';
	}
}
