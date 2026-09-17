// SPA/features/post/post.api.js

import { API_BASE } from '../../core/api/constants.js';
import { buildImageRequestOptions, buildPostMultipartFormData } from '../../core/shared/utils.js';

async function readJson(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function getNormalizedPayload(response) {
	if (!response.ok) {
		return null;
	}

	const payload = await readJson(response);
	if (Array.isArray(payload)) {
		return payload;
	}

	return payload?.data ?? payload ?? null;
}

function normalizeCategoryIDs(categories = []) {
	return categories
		.map((category) => {
			if (typeof category === 'number' || typeof category === 'string') {
				return Number(category);
			}

			return Number(category?.id);
		})
		.filter((id) => Number.isFinite(id) && id > 0)
		.sort((a, b) => a - b);
}

async function performRequest(fetchRef, url, options) {
	try {
		const response = await fetchRef(url, options);
		const payload = await readJson(response);
		return {
			ok: response.ok,
			status: response.status,
			data: Array.isArray(payload) ? payload : (payload?.data ?? payload ?? null),
			payload,
		};
	} catch {
		return { ok: false, status: 0, data: null, payload: null };
	}
}

export async function loadPostCategories(fetchRef) {
	try {
		const response = await fetchRef(`${API_BASE}/categories`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		return await getNormalizedPayload(response);
	} catch {
		return [];
	}
}

export async function getPostById(fetchRef, postId) {
	try {
		const response = await fetchRef(`${API_BASE}/posts/${postId}`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		return await getNormalizedPayload(response);
	} catch {
		return null;
	}
}

export async function loadEditablePost(fetchRef, postId) {
	const result = await performRequest(fetchRef, `${API_BASE}/posts/${postId}`, {
		credentials: 'include',
		headers: { Accept: 'application/json' },
	});

	if (!result.ok || !result.data) {
		return result;
	}

	return {
		...result,
		data: {
			...result.data,
			category_ids: normalizeCategoryIDs(result.data.categories || []),
			image_url:
				typeof result.data.image_url === 'string' && result.data.image_url.trim()
					? result.data.image_url.trim()
					: null,
		},
	};
}

export async function getPostComments(fetchRef, postId) {
	try {
		const response = await fetchRef(`${API_BASE}/posts/${postId}/comments`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});

		return await getNormalizedPayload(response);
	} catch {
		return null;
	}
}

export async function createPost(
	fetchRef,
	{
		title = '',
		body = '',
		categoryIds = [],
		imageFile = null,
		imageURL = null,
		status = null,
	} = {},
) {
	const normalizedCategoryIDs = normalizeCategoryIDs(categoryIds);
	// Only send a status when the caller explicitly asks for one (e.g. a draft
	// save). Omitting it lets the backend apply its default ("published").
	const normalizedStatus = status === 'draft' || status === 'published' ? status : null;

	return performRequest(
		fetchRef,
		`${API_BASE}/posts`,
		buildImageRequestOptions({
			method: 'POST',
			imageFile,
			buildMultipartBody: (file) =>
				buildPostMultipartFormData({
					title,
					body,
					categoryIds: normalizedCategoryIDs,
					imageFile: file,
					imageURL,
					status: normalizedStatus,
				}),
			jsonBody: {
				title,
				body,
				image_url: imageURL,
				category_ids: normalizedCategoryIDs,
				...(normalizedStatus ? { status: normalizedStatus } : {}),
			},
			multipartHeaders: { Accept: 'application/json' },
			jsonHeaders: { Accept: 'application/json' },
		}),
	);
}

export async function updatePost(
	fetchRef,
	postId,
	{ title = '', body = '', categoryIds = [], imageFile = null, removeImage = false } = {},
) {
	const normalizedCategoryIDs = normalizeCategoryIDs(categoryIds);

	return performRequest(
		fetchRef,
		`${API_BASE}/posts/${postId}`,
		buildImageRequestOptions({
			method: 'PATCH',
			imageFile,
			buildMultipartBody: (file) =>
				buildPostMultipartFormData({
					title,
					body,
					categoryIds: normalizedCategoryIDs,
					imageFile: file,
					removeImage,
				}),
			jsonBody: {
				title,
				body,
				category_ids: normalizedCategoryIDs,
				remove_image: Boolean(removeImage),
			},
			multipartHeaders: { Accept: 'application/json' },
			jsonHeaders: { Accept: 'application/json' },
		}),
	);
}

export async function loadPostForEdit(fetchRef, postId) {
	return loadEditablePost(fetchRef, postId);
}

export async function createPostComment(fetchRef, postId, { body = '', imageFile = null } = {}) {
	try {
		const response = await fetchRef(
			`${API_BASE}/posts/${postId}/comments`,
			buildImageRequestOptions({
				method: 'POST',
				imageFile,
				buildMultipartBody: (file) => {
					const formData = new FormData();
					formData.append('body', body);
					formData.append('image', file);
					return formData;
				},
				jsonBody: { body },
				multipartHeaders: { Accept: 'application/json' },
				jsonHeaders: { Accept: 'application/json' },
			}),
		);

		return {
			ok: response.ok,
			status: response.status,
			data: await getNormalizedPayload(response),
		};
	} catch {
		return { ok: false, status: 0, data: null };
	}
}

export { normalizeCategoryIDs };
