import { isValidId } from './social.js';

const API = '/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
// Private media is served through the checked media route. Images sent before
// Phase 5 may still carry the legacy upload path; both are read with the
// session and shown from a local object URL. Anything else is dropped.
const MEDIA_PATH =
	/^\/(api\/v1\/media\/[1-9]\d*|static\/uploads\/dm\/[A-Za-z0-9._-]+\.(jpg|png|gif))$/u;

export function safeMediaUrl(value) {
	return typeof value === 'string' && MEDIA_PATH.test(value) ? value : null;
}

export const MESSAGE_PAGE = 30;
export const ROSTER_PAGE = 50;

async function readPayload(response) {
	return response.json().catch(() => null);
}

function fieldsOf(payload) {
	const fields = payload?.error?.fields;
	return fields && typeof fields === 'object' ? { ...fields } : {};
}

// Maps a chat error response to the outcomes the UI branches on. A lost or
// malformed response is "unavailable": for a send that means the outcome is
// unknown, so callers keep the same retry nonce instead of minting a new one.
function failure(response, payload) {
	const code = payload?.error?.code;
	if (response.status === 401) return { status: 'unauthenticated' };
	if (response.status === 404) return { status: 'not-found' };
	if (response.status === 409 && code === 'MESSAGE_CONFLICT') return { status: 'conflict' };
	if (response.status === 413) return { status: 'too-large' };
	if (response.status === 422 && code === 'INVALID_IMAGE') return { status: 'invalid-image' };
	if ([400, 403, 405, 415].includes(response.status) && code) {
		return { status: 'rejected', code, fields: fieldsOf(payload) };
	}
	return { status: 'unavailable' };
}

async function send(path, { method = 'GET', json, form } = {}, fetchRef = globalThis.fetch) {
	const headers = { Accept: 'application/json' };
	const init = { method, headers, credentials: 'include' };
	if (method !== 'GET') headers['X-Requested-With'] = 'XMLHttpRequest';
	if (json !== undefined) {
		headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(json);
	} else if (form !== undefined) {
		// The browser sets the multipart boundary itself.
		init.body = form;
	}
	let response;
	try {
		response = await fetchRef(`${API}${path}`, init);
	} catch {
		return { status: 'unavailable' };
	}
	if (response.status === 204) return { status: 'ok', http: 204, data: null, meta: null };
	const payload = await readPayload(response);
	if (!response.ok) return failure(response, payload);
	if (!payload || payload.data === undefined) return { status: 'unavailable' };
	return { status: 'ok', http: response.status, data: payload.data, meta: payload.meta ?? null };
}

function text(value) {
	return typeof value === 'string' ? value : null;
}

function count(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validInstant(value) {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// A roster row is a display name and an ID only. Whatever else a response
// carries (profile, email, avatar) is dropped, and `is_online` exists only when
// the server found the viewer allowed to see presence: absence means "hidden",
// never "offline".
export function normalizeRosterEntry(value) {
	if (!value || !isValidId(value.user_id) || text(value.username) === null) return null;
	const unread = count(value.unread_count);
	const readThrough = count(value.read_through_id);
	if (unread === null || readThrough === null || typeof value.can_send !== 'boolean') return null;
	const last = [value.last_message_at, value.last_message_preview, value.last_sender_id];
	const empty = last.every((item) => item === null);
	if (!empty) {
		if (
			!validInstant(value.last_message_at) ||
			text(value.last_message_preview) === null ||
			!isValidId(value.last_sender_id)
		)
			return null;
	}
	if (value.is_online !== undefined && typeof value.is_online !== 'boolean') return null;
	const entry = {
		user_id: value.user_id,
		name: value.username,
		last_message_at: empty ? null : value.last_message_at,
		preview: empty ? null : value.last_message_preview,
		last_sender_id: empty ? null : value.last_sender_id,
		can_send: value.can_send,
		unread_count: unread,
		read_through_id: readThrough,
	};
	if (typeof value.is_online === 'boolean') entry.is_online = value.is_online;
	return entry;
}

// A message is shown only when it is between two different accounts, has a
// checked media URL (if any) and a valid retry nonce (legacy rows carry null).
export function normalizeMessage(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!isValidId(value.sender_id) ||
		!isValidId(value.recipient_id) ||
		value.sender_id === value.recipient_id ||
		text(value.sender_username) === null ||
		text(value.body) === null ||
		!validInstant(value.created_at)
	)
		return null;
	if (
		value.client_id !== null &&
		!(typeof value.client_id === 'string' && UUID.test(value.client_id))
	)
		return null;
	const message = {
		id: value.id,
		sender_id: value.sender_id,
		recipient_id: value.recipient_id,
		sender_username: value.sender_username,
		body: value.body,
		created_at: value.created_at,
		client_id: value.client_id,
	};
	if (value.image_url !== undefined) {
		const url = safeMediaUrl(value.image_url);
		if (!url) return null;
		message.image_url = url;
	}
	return message;
}

function normalizePagination(meta) {
	const page = meta?.pagination;
	if (!page) return null;
	const values = [page.page, page.per_page, page.total, page.total_pages].map(count);
	if (values.includes(null)) return null;
	const [current, perPage, total, totalPages] = values;
	return { page: current, per_page: perPage, total, total_pages: totalPages };
}

function pageQuery({ page = 1, perPage } = {}) {
	const params = new URLSearchParams();
	if (page !== 1) params.set('page', String(page));
	if (perPage) params.set('per_page', String(perPage));
	const result = params.toString();
	return result ? `?${result}` : '';
}

export async function fetchRoster(options, fetchRef) {
	const result = await send(`/chats${pageQuery(options)}`, {}, fetchRef);
	if (result.status !== 'ok') return result;
	if (!Array.isArray(result.data)) return { status: 'unavailable' };
	const entries = result.data.map(normalizeRosterEntry);
	const pagination = normalizePagination(result.meta);
	const ids = new Set(entries.map((entry) => entry?.user_id));
	// The contract always sends pagination; one row per partner.
	if (entries.includes(null) || !pagination || ids.size !== entries.length)
		return { status: 'unavailable' };
	return { status: 'ok', entries, pagination };
}

// `beforeId` is an exclusive upper bound. The page is the newest `limit`
// messages below it, in ascending order. Every message must be between the
// same two people, one of whom is the partner the route names.
export async function fetchMessages(userId, { beforeId, limit } = {}, fetchRef) {
	const params = new URLSearchParams();
	if (limit !== undefined) params.set('limit', String(limit));
	if (beforeId !== undefined) params.set('before_id', String(beforeId));
	const query = params.toString();
	const result = await send(`/chats/${userId}/messages${query ? `?${query}` : ''}`, {}, fetchRef);
	if (result.status !== 'ok') return result;
	const { data } = result;
	if (!data || !Array.isArray(data.messages) || typeof data.has_more !== 'boolean')
		return { status: 'unavailable' };
	const messages = data.messages.map(normalizeMessage);
	if (messages.includes(null)) return { status: 'unavailable' };
	const ascending = messages.every(
		(message, index) => index === 0 || message.id > messages[index - 1].id,
	);
	const others = new Set(
		messages.map((message) =>
			message.sender_id === userId ? message.recipient_id : message.sender_id,
		),
	);
	const pair = messages.every(
		(message) => message.sender_id === userId || message.recipient_id === userId,
	);
	const expectedNext = data.has_more && messages.length > 0 ? messages[0].id : null;
	if (!ascending || !pair || others.size > 1 || data.next_before_id !== expectedNext)
		return { status: 'unavailable' };
	return {
		status: 'ok',
		messages,
		hasMore: data.has_more,
		nextBeforeId: data.next_before_id,
	};
}

// `clientId` is the retry nonce. A lost response is retried with the same one,
// so an exact replay returns the original message (HTTP 200) instead of a
// duplicate; a changed payload under the same nonce is `conflict`.
export async function sendMessage(userId, { clientId, body, imageUrl }, fetchRef) {
	const json = { client_id: clientId, body };
	if (imageUrl) json.image_url = imageUrl;
	const result = await send(`/chats/${userId}/messages`, { method: 'POST', json }, fetchRef);
	if (result.status !== 'ok') return result;
	const message = normalizeMessage(result.data);
	// A reply that is not this account's own message to this partner is never
	// presented as the result of the send.
	if (!message || message.recipient_id !== userId || message.client_id !== clientId)
		return { status: 'unavailable' };
	return { status: 'ok', message, duplicate: result.http === 200 };
}

export async function uploadImage(userId, file, fetchRef) {
	const form = new FormData();
	form.append('image', file);
	const result = await send(`/chats/${userId}/images`, { method: 'POST', form }, fetchRef);
	if (result.status !== 'ok') return result;
	const imageUrl = safeMediaUrl(result.data?.image_url);
	return imageUrl ? { status: 'ok', imageUrl } : { status: 'unavailable' };
}

export async function markRead(userId, throughId, fetchRef) {
	const result = await send(
		`/chats/${userId}/read`,
		{ method: 'PUT', json: { through_id: throughId } },
		fetchRef,
	);
	if (result.status !== 'ok') return result;
	const through = count(result.data?.through_id);
	const unread = count(result.data?.unread_count);
	return through === null || unread === null
		? { status: 'unavailable' }
		: { status: 'ok', throughId: through, unreadCount: unread };
}

export async function fetchUnread(fetchRef) {
	const result = await send('/chats/unread', {}, fetchRef);
	if (result.status !== 'ok') return result;
	const unread = count(result.data?.unread_count);
	return unread === null ? { status: 'unavailable' } : { status: 'ok', unreadCount: unread };
}

// Private images are read with the session, then shown from a local object URL
// that the message state revokes when the account changes.
export async function fetchImage(url, fetchRef = globalThis.fetch) {
	const path = safeMediaUrl(url);
	if (!path) return { status: 'unavailable' };
	let response;
	try {
		response = await fetchRef(path, { credentials: 'include', headers: { Accept: 'image/*' } });
	} catch {
		return { status: 'unavailable' };
	}
	if (response.status === 401) return { status: 'unauthenticated' };
	if (response.status === 404) return { status: 'not-found' };
	if (!response.ok) return { status: 'unavailable' };
	let blob;
	try {
		blob = await response.blob();
	} catch {
		return { status: 'unavailable' };
	}
	const type = (blob.type || response.headers?.get?.('content-type') || '').split(';')[0].trim();
	return IMAGE_TYPES.has(type) ? { status: 'ok', blob } : { status: 'unavailable' };
}
