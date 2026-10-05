const API = '/api/v1';
const AVATAR_PATH = /^\/api\/v1\/users\/[1-9]\d*\/avatar$/u;
const RELATIONSHIP_STATES = new Set(['self', 'none', 'pending', 'accepted']);
const FOLLOW_STATES = new Set(['pending', 'accepted']);
const VISIBILITIES = new Set(['public', 'private']);

export const RELATIONSHIP_NONE = Object.freeze({ state: 'none', follow_id: null });

export function isValidId(value) {
	return Number.isSafeInteger(value) && value > 0;
}

async function readPayload(response) {
	return response.json().catch(() => null);
}

function fieldsOf(payload) {
	const fields = payload?.error?.fields;
	return fields && typeof fields === 'object' ? { ...fields } : {};
}

// Maps a contract error response to the outcomes the UI branches on. Only the
// documented 401/404/409 statuses carry meaning; everything else, including a
// malformed body, is "unavailable" so callers never claim a logout or a write.
function failure(response, payload) {
	const code = payload?.error?.code;
	if (response.status === 401) return { status: 'unauthenticated' };
	if (response.status === 404) return { status: 'not-found' };
	if (response.status === 409 && code === 'STALE_FOLLOW') return { status: 'stale-follow' };
	if (response.status === 409 && code === 'STALE_PROFILE') return { status: 'stale-profile' };
	if (response.status === 400 || response.status === 403) {
		return { status: 'rejected', code: code ?? 'BAD_REQUEST', fields: fieldsOf(payload) };
	}
	return { status: 'unavailable' };
}

async function send(path, { method = 'GET', body } = {}, fetchRef = globalThis.fetch) {
	const headers = { Accept: 'application/json' };
	const init = { method, headers, credentials: 'include' };
	if (method !== 'GET') headers['X-Requested-With'] = 'XMLHttpRequest';
	if (body !== undefined) {
		headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(body);
	}
	let response;
	try {
		response = await fetchRef(`${API}${path}`, init);
	} catch {
		return { status: 'unavailable' };
	}
	if (response.status === 204) return { status: 'ok', data: null, meta: null };
	const payload = await readPayload(response);
	if (!response.ok) return failure(response, payload);
	if (!payload || payload.data === undefined) return { status: 'unavailable' };
	return { status: 'ok', data: payload.data, meta: payload.meta ?? null };
}

function normalizeRelationship(value) {
	if (!value || !RELATIONSHIP_STATES.has(value.state)) return null;
	const followId = value.follow_id;
	if (followId !== null && !isValidId(followId)) return null;
	if ((value.state === 'pending' || value.state === 'accepted') && followId === null) return null;
	return { state: value.state, follow_id: followId };
}

// Teasers keep exactly four keys. Anything else a response carries for a
// name-only entry (avatar, counts, profile) is dropped here so a server bug
// cannot surface protected details through the UI.
export function normalizePerson(value) {
	if (!value || !isValidId(value.id) || typeof value.display_name !== 'string') return null;
	const relationship = normalizeRelationship(value.relationship);
	if (!relationship) return null;
	const base = { id: value.id, display_name: value.display_name, relationship };
	if (value.access === 'teaser') return { ...base, access: 'teaser' };
	if (value.access !== 'full') return null;
	return { ...base, access: 'full', avatar_url: safeAvatar(value.avatar_url) };
}

function safeAvatar(url) {
	return typeof url === 'string' && AVATAR_PATH.test(url) ? url : null;
}

function nullableText(value) {
	return typeof value === 'string' ? value : null;
}

function count(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function normalizeProfile(value) {
	const person = normalizePerson(value);
	if (!person) return null;
	if (person.access === 'teaser') return person;
	const profile = value.profile;
	if (!profile || !VISIBILITIES.has(profile.visibility)) return null;
	const { avatar_url: _unused, ...identity } = person;
	const result = {
		...identity,
		profile: {
			email: nullableText(profile.email) ?? '',
			first_name: nullableText(profile.first_name) ?? '',
			last_name: nullableText(profile.last_name) ?? '',
			date_of_birth: nullableText(profile.date_of_birth),
			nickname: nullableText(profile.nickname),
			about_me: nullableText(profile.about_me),
			avatar_url: safeAvatar(profile.avatar_url),
			visibility: profile.visibility,
			followers_count: count(profile.followers_count),
			following_count: count(profile.following_count),
		},
	};
	if (person.relationship.state === 'self') {
		// The owner's version guards privacy writes; without it the profile is
		// unusable rather than silently unable to change.
		if (!isValidId(profile.version)) return null;
		result.profile.version = profile.version;
	}
	return result;
}

export function normalizeFollow(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!isValidId(value.follower_id) ||
		!isValidId(value.followed_id) ||
		!FOLLOW_STATES.has(value.state)
	) {
		return null;
	}
	return {
		id: value.id,
		follower_id: value.follower_id,
		followed_id: value.followed_id,
		state: value.state,
		created_at: nullableText(value.created_at),
		accepted_at: nullableText(value.accepted_at),
	};
}

function normalizePagination(meta) {
	const page = meta?.pagination;
	if (!page) return null;
	return {
		page: count(page.page),
		per_page: count(page.per_page),
		total: count(page.total),
		total_pages: count(page.total_pages),
	};
}

function query({ q, page, perPage }) {
	const params = new URLSearchParams();
	if (q) params.set('q', q);
	if (page && page !== 1) params.set('page', String(page));
	if (perPage) params.set('per_page', String(perPage));
	const text = params.toString();
	return text ? `?${text}` : '';
}

function personList(result) {
	if (result.status !== 'ok') return result;
	if (!Array.isArray(result.data)) return { status: 'unavailable' };
	const people = result.data.map(normalizePerson);
	if (people.includes(null)) return { status: 'unavailable' };
	const pagination = normalizePagination(result.meta);
	// The contract always sends pagination; without it totals would be guesses.
	if (!pagination) return { status: 'unavailable' };
	return { status: 'ok', people, pagination };
}

export async function searchPeople({ q = '', page = 1, perPage } = {}, fetchRef) {
	return personList(await send(`/users${query({ q, page, perPage })}`, {}, fetchRef));
}

export async function fetchProfile(userId, fetchRef) {
	const result = await send(`/users/${userId}/profile`, {}, fetchRef);
	if (result.status !== 'ok') return result;
	const profile = normalizeProfile(result.data);
	return profile ? { status: 'ok', profile } : { status: 'unavailable' };
}

async function fetchRelationshipList(userId, kind, { page = 1, perPage } = {}, fetchRef) {
	const path = `/users/${userId}/${kind}${query({ page, perPage })}`;
	return personList(await send(path, {}, fetchRef));
}

export function fetchFollowers(userId, options, fetchRef) {
	return fetchRelationshipList(userId, 'followers', options, fetchRef);
}

export function fetchFollowing(userId, options, fetchRef) {
	return fetchRelationshipList(userId, 'following', options, fetchRef);
}

export async function followUser(userId, fetchRef) {
	const result = await send('/follows', { method: 'POST', body: { user_id: userId } }, fetchRef);
	if (result.status !== 'ok') return result;
	const follow = normalizeFollow(result.data);
	return follow ? { status: 'ok', follow } : { status: 'unavailable' };
}

// Cancelling a pending request and unfollowing an accepted one are the same
// sender-only DELETE; the ID, never the user pair, identifies what is removed.
export async function removeFollow(followId, fetchRef) {
	const result = await send(`/follows/${followId}`, { method: 'DELETE' }, fetchRef);
	return result.status === 'ok' ? { status: 'ok' } : result;
}

export async function setProfileVisibility({ visibility, expectedVersion }, fetchRef) {
	const result = await send(
		'/users/me/privacy',
		{ method: 'PATCH', body: { visibility, expected_version: expectedVersion } },
		fetchRef,
	);
	if (result.status !== 'ok') return result;
	const profile = normalizeProfile(result.data);
	return profile?.access === 'full' && profile.profile.version
		? { status: 'ok', profile }
		: { status: 'unavailable' };
}

const NOTICE_TYPES = new Set([
	'follow_request',
	'post_like',
	'post_dislike',
	'comment',
	'comment_like',
	'comment_dislike',
]);
const REQUEST_STATES = new Set(['pending', 'accepted', 'declined', 'cancelled', 'unfollowed']);

function normalizeRequestNotice(base, target, actions) {
	if (
		target.kind !== 'follow_request' ||
		!isValidId(target.follow_id) ||
		!REQUEST_STATES.has(target.state)
	)
		return null;
	return {
		...base,
		target: { kind: target.kind, follow_id: target.follow_id, state: target.state },
		actions:
			target.state === 'pending' && Array.isArray(actions)
				? actions.filter((action) => action === 'accept' || action === 'decline')
				: [],
	};
}

export function normalizeNotice(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!NOTICE_TYPES.has(value.type) ||
		typeof value.created_at !== 'string' ||
		typeof value.is_read !== 'boolean'
	)
		return null;
	const actor = normalizePerson(value.actor);
	const target = value.target;
	if (!actor || !target) return null;
	const base = {
		id: value.id,
		type: value.type,
		created_at: value.created_at,
		is_read: value.is_read,
		actor,
	};
	if (value.type === 'follow_request') return normalizeRequestNotice(base, target, value.actions);
	if (!isValidId(target.post_id) || !['post', 'comment'].includes(target.kind)) return null;
	const content = { kind: target.kind, post_id: target.post_id, title: nullableText(target.title) };
	if (target.kind === 'comment') {
		if (!isValidId(target.comment_id)) return null;
		content.comment_id = target.comment_id;
		if (typeof target.excerpt === 'string')
			content.excerpt = [...target.excerpt].slice(0, 20).join('');
	}
	return { ...base, target: content, actions: [] };
}

export async function fetchNotifications({ page = 1, perPage } = {}, fetchRef) {
	const result = await send(`/notifications${query({ page, perPage })}`, {}, fetchRef);
	if (result.status !== 'ok') return result;
	if (
		!Array.isArray(result.data?.notifications) ||
		!Number.isSafeInteger(result.data.unread_count) ||
		result.data.unread_count < 0
	)
		return { status: 'unavailable' };
	const notifications = result.data.notifications.map(normalizeNotice);
	const pagination = normalizePagination(result.meta);
	if (notifications.includes(null) || !pagination) return { status: 'unavailable' };
	return { status: 'ok', notifications, unreadCount: result.data.unread_count, pagination };
}

export async function fetchFollowRequests({ page = 1, perPage } = {}, fetchRef) {
	const result = await send(`/users/me/follow-requests${query({ page, perPage })}`, {}, fetchRef);
	if (result.status !== 'ok') return result;
	if (!Array.isArray(result.data)) return { status: 'unavailable' };
	const requests = result.data.map((item) => {
		const requester = normalizePerson(item?.requester);
		return isValidId(item?.id) && typeof item.created_at === 'string' && requester
			? { id: item.id, created_at: item.created_at, requester }
			: null;
	});
	const pagination = normalizePagination(result.meta);
	return requests.includes(null) || !pagination
		? { status: 'unavailable' }
		: { status: 'ok', requests, pagination };
}

export async function decideFollowRequest(followId, decision, fetchRef) {
	const result = await send(
		`/follow-requests/${followId}`,
		{ method: 'PATCH', body: { decision } },
		fetchRef,
	);
	if (result.status !== 'ok' || decision === 'decline') return result;
	const follow = normalizeFollow(result.data);
	return follow?.state === 'accepted' ? { status: 'ok', follow } : { status: 'unavailable' };
}

export async function markNotificationRead(id, fetchRef) {
	return send(`/notifications/${id}/read`, { method: 'PATCH' }, fetchRef);
}

export async function markAllNotificationsRead(fetchRef) {
	return send('/notifications/read-all', { method: 'PATCH' }, fetchRef);
}
