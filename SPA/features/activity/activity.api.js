// SPA/features/activity/activity.api.js

import { API_BASE } from '../../core/api/constants.js';
import { buildImageRequestOptions } from '../../core/shared/utils.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 10;
const ALLOWED_PER_PAGE = new Set([5, 10, 20, 50]);
const ALLOWED_STATUS = new Set(['all', 'draft', 'published']);

function toPositiveInt(value) {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function coercePerPage(value) {
	const parsed = toPositiveInt(value);
	if (parsed && ALLOWED_PER_PAGE.has(parsed)) {
		return parsed;
	}
	return DEFAULT_PER_PAGE;
}

function coerceStatus(value) {
	const normalized = typeof value === 'string' ? value.toLowerCase() : '';
	return ALLOWED_STATUS.has(normalized) ? normalized : 'all';
}

export function getActivityQueryState(windowRef) {
	const params = new URLSearchParams(windowRef.location.search);

	return {
		page: toPositiveInt(params.get('page')) ?? DEFAULT_PAGE,
		perPage: coercePerPage(params.get('per_page')),
		status: coerceStatus(params.get('status')),
	};
}

function buildActivityPath(windowRef, { page, perPage, status }) {
	const params = new URLSearchParams();

	if (page > DEFAULT_PAGE) params.set('page', String(page));
	if (perPage !== DEFAULT_PER_PAGE) params.set('per_page', String(perPage));
	if (status && status !== 'all') params.set('status', status);

	const qs = params.toString();
	return qs ? `${windowRef.location.pathname}?${qs}` : windowRef.location.pathname;
}

export function setActivityQueryState(windowRef, state) {
	windowRef.history.replaceState({}, '', buildActivityPath(windowRef, state));
}

export async function loadActivity(fetchRef, windowRef, { page, perPage, status }) {
	const url = new URL(`${API_BASE}/users/activity`, windowRef.location.origin);

	url.searchParams.set('page', String(page));
	url.searchParams.set('per_page', String(perPage));

	if (status && status !== 'all') {
		url.searchParams.set('status', status);
	}

	try {
		const response = await fetchRef(url.toString(), {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			return { ok: false, status: response.status, data: null };
		}

		const payload = await response.json();
		return { ok: true, status: response.status, data: payload?.data ?? null };
	} catch {
		return { ok: false, status: 0, data: null };
	}
}

export async function getCurrentUserID(fetchRef) {
	try {
		const response = await fetchRef(`${API_BASE}/users/me`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) return 0;

		const payload = await response.json();
		const user = payload?.data ?? payload ?? {};
		const id = Number(user.id);
		return Number.isFinite(id) && id > 0 ? id : 0;
	} catch {
		return 0;
	}
}

export async function deleteActivityPost(fetchRef, postId) {
	try {
		const response = await fetchRef(`${API_BASE}/posts/${postId}`, {
			method: 'DELETE',
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}

export async function setActivityPostStatus(fetchRef, postId, status) {
	try {
		const response = await fetchRef(`${API_BASE}/posts/${postId}`, {
			method: 'PATCH',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({ status }),
		});
		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}

export async function deleteActivityComment(fetchRef, commentId) {
	try {
		const response = await fetchRef(`${API_BASE}/comments/${commentId}`, {
			method: 'DELETE',
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}

export async function updateActivityComment(
	fetchRef,
	commentId,
	{ body = '', imageFile = null, removeImage = false } = {},
) {
	try {
		const response = await fetchRef(
			`${API_BASE}/comments/${commentId}`,
			buildImageRequestOptions({
				method: 'PATCH',
				imageFile,
				buildMultipartBody: (file) => {
					const formData = new FormData();
					formData.append('body', body);
					formData.append('image', file);
					return formData;
				},
				jsonBody: { body, remove_image: removeImage && !imageFile },
				multipartHeaders: { Accept: 'application/json' },
				jsonHeaders: { Accept: 'application/json' },
			}),
		);

		return { ok: response.ok, status: response.status };
	} catch {
		return { ok: false, status: 0 };
	}
}
