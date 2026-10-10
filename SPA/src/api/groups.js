import { isValidId, normalizePerson } from './social.js';

const API = '/api/v1';
const ROLES = new Set(['creator', 'member', 'none']);
const MEMBER_ROLES = new Set(['creator', 'member']);
const MEMBERSHIP_FILTERS = new Set(['all', 'member']);

export const GROUP_TITLE_MAX = 100;
export const GROUP_DESCRIPTION_MAX = 1000;

// Each pinned 409 names exactly which identity went stale; the UI branches on
// these instead of a generic conflict so it can explain what changed.
const CONFLICTS = {
	STALE_INVITATION: 'stale-invitation',
	STALE_JOIN_REQUEST: 'stale-request',
	STALE_MEMBERSHIP: 'stale-membership',
	ALREADY_MEMBER: 'already-member',
	CREATOR_CANNOT_LEAVE: 'creator-cannot-leave',
};

async function readPayload(response) {
	return response.json().catch(() => null);
}

function fieldsOf(payload) {
	const fields = payload?.error?.fields;
	return fields && typeof fields === 'object' ? { ...fields } : {};
}

// Maps a group error response to the outcomes the UI branches on. A lost or
// malformed response is "unavailable": for writes that means the outcome is
// unknown, so callers refetch instead of claiming success or replaying.
function failure(response, payload) {
	const code = payload?.error?.code;
	if (response.status === 401) return { status: 'unauthenticated' };
	if (response.status === 404) return { status: 'not-found' };
	if (response.status === 409 && CONFLICTS[code]) return { status: CONFLICTS[code] };
	if ([400, 403, 405, 413, 415].includes(response.status) && code) {
		return { status: 'rejected', code, fields: fieldsOf(payload) };
	}
	return { status: 'unavailable' };
}

async function send(path, { method = 'GET', json } = {}, fetchRef = globalThis.fetch) {
	const headers = { Accept: 'application/json' };
	const init = { method, headers, credentials: 'include' };
	if (method !== 'GET') headers['X-Requested-With'] = 'XMLHttpRequest';
	if (json !== undefined) {
		headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(json);
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

function text(value) {
	return typeof value === 'string' ? value : null;
}

function count(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A creator or inviter inside group metadata is a name and an ID only; any
// avatar, access or profile field a response carries is dropped.
function normalizeName(value) {
	if (!value || !isValidId(value.id) || typeof value.display_name !== 'string') return null;
	return { id: value.id, display_name: value.display_name };
}

function normalizeSummary(value) {
	const creator = normalizeName(value?.creator);
	if (!creator || !isValidId(value.id) || text(value.title) === null) return null;
	if (text(value.description) === null) return null;
	return { id: value.id, title: value.title, description: value.description, creator };
}

function normalizeEntryRef(value) {
	return value && isValidId(value.id) && text(value.created_at) !== null
		? { id: value.id, created_at: value.created_at }
		: null;
}

function normalizeViewer(value) {
	if (!value || !ROLES.has(value.role)) return null;
	const member = value.role !== 'none';
	if (member ? !isValidId(value.membership_id) : value.membership_id !== null) return null;
	if (!Array.isArray(value.invitations)) return null;
	const invitations = value.invitations.map((item) => {
		const ref = normalizeEntryRef(item);
		const inviter = normalizeName(item?.inviter);
		return ref && inviter ? { ...ref, inviter } : null;
	});
	if (invitations.includes(null)) return null;
	const joinRequest = value.join_request === null ? null : normalizeEntryRef(value.join_request);
	if (value.join_request !== null && !joinRequest) return null;
	// Admission resolves every pending entry, so a member never has any.
	return {
		role: value.role,
		membership_id: member ? value.membership_id : null,
		invitations: member ? [] : invitations,
		join_request: member ? null : joinRequest,
	};
}

// `member_count` is a members-only aggregate. It is kept only for a member
// viewer, so a server mistake cannot show it to an outsider.
export function normalizeGroup(value) {
	const summary = normalizeSummary(value);
	const viewer = normalizeViewer(value?.viewer);
	if (!summary || !viewer || text(value.created_at) === null) return null;
	const group = { ...summary, created_at: value.created_at, viewer };
	if (viewer.role === 'none') return group;
	const members = count(value.member_count);
	if (members === null) return null;
	return { ...group, member_count: members };
}

export function normalizeMembership(value) {
	if (
		!value ||
		!isValidId(value.id) ||
		!isValidId(value.group_id) ||
		!isValidId(value.user_id) ||
		!MEMBER_ROLES.has(value.role) ||
		text(value.joined_at) === null
	)
		return null;
	return {
		id: value.id,
		group_id: value.group_id,
		user_id: value.user_id,
		role: value.role,
		joined_at: value.joined_at,
	};
}

function normalizeMember(value) {
	const person = normalizePerson(value);
	const membership = value?.membership;
	if (
		!person ||
		!membership ||
		!isValidId(membership.id) ||
		!MEMBER_ROLES.has(membership.role) ||
		text(membership.joined_at) === null
	)
		return null;
	return {
		...person,
		membership: { id: membership.id, role: membership.role, joined_at: membership.joined_at },
	};
}

export function normalizeInvitation(value) {
	const ref = normalizeEntryRef(value);
	const group = normalizeSummary(value?.group);
	const inviter = normalizePerson(value?.inviter);
	const invitee = normalizePerson(value?.invitee);
	return ref && group && inviter && invitee ? { ...ref, group, inviter, invitee } : null;
}

export function normalizeJoinRequest(value) {
	const ref = normalizeEntryRef(value);
	const group = normalizeSummary(value?.group);
	const requester = normalizePerson(value?.requester);
	return ref && group && requester ? { ...ref, group, requester } : null;
}

function normalizePagination(meta) {
	const page = meta?.pagination;
	if (!page) return null;
	const values = [page.page, page.per_page, page.total, page.total_pages].map(count);
	if (values.includes(null)) return null;
	const [current, perPage, total, totalPages] = values;
	return { page: current, per_page: perPage, total, total_pages: totalPages };
}

function query(entries) {
	const params = new URLSearchParams();
	for (const [key, value] of entries) if (value !== undefined) params.set(key, String(value));
	const result = params.toString();
	return result ? `?${result}` : '';
}

function pageEntries({ page = 1, perPage } = {}) {
	return [
		['per_page', perPage],
		['page', page !== 1 ? page : undefined],
	];
}

function list(result, normalize, key) {
	if (result.status !== 'ok') return result;
	if (!Array.isArray(result.data)) return { status: 'unavailable' };
	const items = result.data.map(normalize);
	const pagination = normalizePagination(result.meta);
	// The contract always sends pagination; without it totals would be guesses.
	if (items.includes(null) || !pagination) return { status: 'unavailable' };
	return { status: 'ok', [key]: items, pagination };
}

function single(result, normalize, key) {
	if (result.status !== 'ok') return result;
	const item = normalize(result.data);
	return item ? { status: 'ok', [key]: item } : { status: 'unavailable' };
}

export async function fetchGroups({ q = '', membership = 'all', page, perPage } = {}, fetchRef) {
	if (!MEMBERSHIP_FILTERS.has(membership)) return { status: 'rejected', code: 'BAD_REQUEST' };
	const path = `/groups${query([
		['q', q || undefined],
		['membership', membership === 'member' ? membership : undefined],
		...pageEntries({ page, perPage }),
	])}`;
	return list(await send(path, {}, fetchRef), normalizeGroup, 'groups');
}

export async function fetchGroup(groupId, fetchRef) {
	return single(await send(`/groups/${groupId}`, {}, fetchRef), normalizeGroup, 'group');
}

export async function fetchGroupMembers(groupId, options, fetchRef) {
	const path = `/groups/${groupId}/members${query(pageEntries(options))}`;
	return list(await send(path, {}, fetchRef), normalizeMember, 'members');
}

export async function fetchJoinRequests(groupId, options, fetchRef) {
	const path = `/groups/${groupId}/join-requests${query(pageEntries(options))}`;
	return list(await send(path, {}, fetchRef), normalizeJoinRequest, 'requests');
}

export async function fetchMyInvitations(options, fetchRef) {
	const path = `/users/me/group-invitations${query(pageEntries(options))}`;
	return list(await send(path, {}, fetchRef), normalizeInvitation, 'invitations');
}

// Creation is not idempotent. A lost response is never replayed; callers
// look for the group in their own memberships instead.
export async function createGroup({ title, description }, fetchRef) {
	const result = await send('/groups', { method: 'POST', json: { title, description } }, fetchRef);
	const outcome = single(result, normalizeGroup, 'group');
	return outcome.status === 'ok' && outcome.group.viewer.role !== 'creator'
		? { status: 'unavailable' }
		: outcome;
}

// Same inviter and invitee is idempotent: 200 returns the existing ID.
export async function inviteToGroup(groupId, userId, fetchRef) {
	const result = await send(
		`/groups/${groupId}/invitations`,
		{ method: 'POST', json: { user_id: userId } },
		fetchRef,
	);
	return single(result, normalizeInvitation, 'invitation');
}

export async function requestToJoin(groupId, fetchRef) {
	const result = await send(`/groups/${groupId}/join-requests`, { method: 'POST' }, fetchRef);
	return single(result, normalizeJoinRequest, 'request');
}

async function decide(path, decision, fetchRef) {
	const result = await send(path, { method: 'PATCH', json: { decision } }, fetchRef);
	if (result.status !== 'ok' || decision === 'refuse') return result;
	return single(result, normalizeMembership, 'membership');
}

// Decisions always address the exact entry ID from the invitation, request
// or notice; a resolved ID is stale and never replayed as a success.
export function decideInvitation(invitationId, decision, fetchRef) {
	return decide(`/group-invitations/${invitationId}`, decision, fetchRef);
}

export function decideJoinRequest(requestId, decision, fetchRef) {
	return decide(`/group-join-requests/${requestId}`, decision, fetchRef);
}

// Leave (own row) and creator removal (another member's row) share one route;
// the membership ID is the generation, so an old ID cannot remove a returner.
export async function removeMembership(membershipId, fetchRef) {
	const result = await send(`/group-memberships/${membershipId}`, { method: 'DELETE' }, fetchRef);
	return result.status === 'ok' ? { status: 'ok' } : result;
}
