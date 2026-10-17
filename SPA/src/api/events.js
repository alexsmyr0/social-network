import { isValidId } from './social.js';

const API = '/api/v1';
const CHOICES = new Set(['going', 'not_going']);
const OPTIONS = ['going', 'not_going'];

export const EVENT_TITLE_MAX = 100;
export const EVENT_DESCRIPTION_MAX = 1000;

// Each pinned 409 names exactly which identity went stale; the UI branches on
// these instead of a generic conflict so it can explain what changed.
const CONFLICTS = {
	STALE_EVENT_RESPONSE: 'stale-response',
	STALE_MEMBERSHIP: 'stale-membership',
};

async function readPayload(response) {
	return response.json().catch(() => null);
}

function fieldsOf(payload) {
	const fields = payload?.error?.fields;
	return fields && typeof fields === 'object' ? { ...fields } : {};
}

// Maps an event error response to the outcomes the UI branches on. A lost or
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

// Creators and responders are a name and an ID only; any avatar, access or
// profile field a response carries is dropped so shared membership can never
// surface private profile details.
function normalizeName(value) {
	if (!value || !isValidId(value.id) || typeof value.display_name !== 'string') return null;
	return { id: value.id, display_name: value.display_name };
}

function validInstant(value) {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function normalizeViewerResponse(value) {
	if (value === null) return null;
	if (!value || !CHOICES.has(value.choice) || !isValidId(value.version)) return undefined;
	return { choice: value.choice, version: value.version };
}

export function normalizeEvent(value) {
	const creator = normalizeName(value?.creator);
	const viewerResponse = normalizeViewerResponse(value?.viewer_response);
	const going = count(value?.counts?.going);
	const notGoing = count(value?.counts?.not_going);
	if (
		!creator ||
		viewerResponse === undefined ||
		going === null ||
		notGoing === null ||
		!isValidId(value.id) ||
		!isValidId(value.group_id) ||
		text(value.title) === null ||
		text(value.description) === null ||
		!validInstant(value.starts_at) ||
		!validInstant(value.created_at) ||
		!Array.isArray(value.options) ||
		value.options.join(',') !== OPTIONS.join(',')
	)
		return null;
	return {
		id: value.id,
		group_id: value.group_id,
		creator,
		title: value.title,
		description: value.description,
		starts_at: value.starts_at,
		created_at: value.created_at,
		options: [...OPTIONS],
		counts: { going, not_going: notGoing },
		viewer_response: viewerResponse,
	};
}

export function normalizeEventResponse(value) {
	const user = normalizeName(value?.user);
	if (!user || !CHOICES.has(value.choice) || !isValidId(value.version)) return null;
	return { user, choice: value.choice, version: value.version };
}

function normalizePagination(meta) {
	const page = meta?.pagination;
	if (!page) return null;
	const values = [page.page, page.per_page, page.total, page.total_pages].map(count);
	if (values.includes(null)) return null;
	const [current, perPage, total, totalPages] = values;
	return { page: current, per_page: perPage, total, total_pages: totalPages };
}

function query({ page = 1, perPage } = {}) {
	const params = new URLSearchParams();
	if (page !== 1) params.set('page', String(page));
	if (perPage) params.set('per_page', String(perPage));
	const result = params.toString();
	return result ? `?${result}` : '';
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

// An event must belong to the group the route names; a response for another
// group is treated as a malformed answer, never shown.
function single(result, groupId) {
	if (result.status !== 'ok') return result;
	const event = normalizeEvent(result.data);
	return event && event.group_id === groupId ? { status: 'ok', event } : { status: 'unavailable' };
}

export async function fetchEvents(groupId, options, fetchRef) {
	const result = await send(`/groups/${groupId}/events${query(options)}`, {}, fetchRef);
	const outcome = list(result, normalizeEvent, 'events');
	return outcome.status === 'ok' && outcome.events.some((event) => event.group_id !== groupId)
		? { status: 'unavailable' }
		: outcome;
}

export async function fetchEvent(groupId, eventId, fetchRef) {
	return single(await send(`/groups/${groupId}/events/${eventId}`, {}, fetchRef), groupId);
}

export async function fetchEventResponses(groupId, eventId, options, fetchRef) {
	const path = `/groups/${groupId}/events/${eventId}/responses${query(options)}`;
	return list(await send(path, {}, fetchRef), normalizeEventResponse, 'responses');
}

// Event creation is not idempotent: an explicit repeat is a distinct event with
// distinct notices. A lost response is therefore never replayed; callers send
// the member to the event list to check instead.
export async function createEvent(
	groupId,
	{ membershipId, title, description, startsAt },
	fetchRef,
) {
	const result = await send(
		`/groups/${groupId}/events`,
		{
			method: 'POST',
			json: { membership_id: membershipId, title, description, starts_at: startsAt },
		},
		fetchRef,
	);
	return single(result, groupId);
}

// `expectedVersion` is the version of the response the viewer saw (0 when they
// had none). An older version is refused even for the same choice, so a stale
// screen can never overwrite a newer answer or repeat a delayed action.
export async function respondToEvent(
	groupId,
	eventId,
	{ membershipId, choice, expectedVersion },
	fetchRef,
) {
	const result = await send(
		`/groups/${groupId}/events/${eventId}/response`,
		{
			method: 'PUT',
			json: { membership_id: membershipId, choice, expected_version: expectedVersion },
		},
		fetchRef,
	);
	return single(result, groupId);
}
