// Stateful stand-in for the SN-B20 group-event contract, used only by tests. It
// extends the Phase 4 group model (membership generations, signals, People
// redaction, group notices) with events, per-generation responses and event
// notices, so UI tests exercise real transitions rather than one canned
// success. Its conformance to the approved pack is checked by
// `event-model.test.js`. It is never imported by `SPA/src` (a policy test
// enforces that).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GroupBackend, loadGroupFixtures, mergeState } from '../phase4/group-backend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE_PATH = path.join(ROOT, 'docs/social-network/fixtures/phase-5-contract.json');
const MAX_ID = Number.MAX_SAFE_INTEGER;
const NO_STORE = { 'Cache-Control': 'no-store' };
const CONTROL = /\p{Cc}/u;
const SURROGATE = /\p{Cs}/u;
const INSTANT =
	/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/u;

export const CLOCK = '2026-10-15T12:00:00Z';
export const UNAVAILABLE_ACCOUNT = 'Unavailable account';

export function loadEventFixtures() {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

const MESSAGES = {
	NOT_FOUND: 'Not found',
	BAD_REQUEST: 'Bad request',
	VALIDATION_ERROR: 'Validation failed',
	METHOD_NOT_ALLOWED: 'Method not allowed',
	STALE_EVENT_RESPONSE: 'Event response changed; refresh and retry',
	STALE_MEMBERSHIP: 'Membership changed; refresh before acting',
};

function reply(status, body = null, headers = {}) {
	return { status, headers: { ...NO_STORE, ...headers }, body };
}

function failure(status, code, fields) {
	const error = { code, message: MESSAGES[code] ?? 'Fixture error; clients branch on code' };
	if (fields) error.fields = fields;
	return reply(status, { error });
}

const badRequest = () => failure(400, 'BAD_REQUEST');
const notFound = () => failure(404, 'NOT_FOUND');
const invalid = (fields) => failure(400, 'VALIDATION_ERROR', fields);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseId(text) {
	if (typeof text !== 'string' || !/^[1-9]\d*$/u.test(text)) return null;
	const id = Number(text);
	return id <= MAX_ID ? id : null;
}

// Mirrors the contract's text rules: CRLF → LF, trim, required, code-point
// limit, then control characters (descriptions may keep newline and tab).
function cleanText(value, limit, { multiline }) {
	if (value === undefined || value === null) return { error: 'REQUIRED' };
	const text = value.replace(/\r\n/gu, '\n').trim();
	if (text === '') return { error: 'REQUIRED' };
	if ([...text].length > limit) return { error: 'TOO_LONG' };
	const checked = multiline ? text.replace(/[\n\t]/gu, '') : text;
	return CONTROL.test(checked) || SURROGATE.test(checked) ? { error: 'INVALID_TEXT' } : { text };
}

// Absolute instant only: a calendar-valid date, whole seconds and an explicit
// Z or ±HH:MM offset, normalized to UTC in years 0001–9999.
export function parseInstant(value) {
	const match = typeof value === 'string' ? INSTANT.exec(value) : null;
	if (!match) return null;
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	if (year < 1 || month < 1 || month > 12) return null;
	const probe = new Date(0);
	probe.setUTCFullYear(year, month, 0);
	if (day < 1 || day > probe.getUTCDate()) return null;
	const instant = new Date(0);
	instant.setUTCFullYear(year, month - 1, day);
	instant.setUTCHours(hour, minute, second, 0);
	if (match[7]) {
		const offset = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === '+' ? 1 : -1);
		instant.setTime(instant.getTime() - offset * 60000);
	}
	const utcYear = instant.getUTCFullYear();
	if (utcYear < 1 || utcYear > 9999) return null;
	return instant.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

const ROUTES = [
	['events', /^\/api\/v1\/groups\/([^/]+)\/events$/u, ['GET', 'POST']],
	['event', /^\/api\/v1\/groups\/([^/]+)\/events\/([^/]+)$/u, ['GET']],
	['responses', /^\/api\/v1\/groups\/([^/]+)\/events\/([^/]+)\/responses$/u, ['GET']],
	['response', /^\/api\/v1\/groups\/([^/]+)\/events\/([^/]+)\/response$/u, ['PUT']],
];

function matchEventRoute(pathname) {
	for (const [name, pattern, methods] of ROUTES) {
		const match = pattern.exec(pathname);
		if (match) return { name, params: match.slice(1), methods };
	}
	return null;
}

// Phase 4 users, groups and memberships plus a few events, answers and event
// notices for group 301 (Alex creator, Ada private member, Lee member).
export function defaultEventState() {
	const base = loadGroupFixtures().state;
	return {
		...structuredClone(base),
		group_memberships: {
			...structuredClone(base.group_memberships),
			504: {
				id: 504,
				group_id: 301,
				user_id: 10,
				role: 'member',
				joined_at: '2026-10-08T14:00:00Z',
			},
		},
		next_ids: {
			...base.next_ids,
			group_memberships: 505,
			notifications: 811,
			events: 703,
		},
		events: {
			701: {
				id: 701,
				group_id: 301,
				creator_id: 7,
				title: 'Opening night',
				description: 'Bring a board and a clock.',
				starts_at: '2099-10-20T17:30:00Z',
				created_at: '2026-10-09T12:00:00Z',
			},
			702: {
				id: 702,
				group_id: 301,
				creator_id: 42,
				title: 'Endgame workshop',
				description: 'Rook endings, step by step.',
				starts_at: '2020-10-01T16:00:00Z',
				created_at: '2026-09-20T12:00:00Z',
			},
		},
		event_responses: {
			'701:502': { event_id: 701, membership_id: 502, user_id: 7, choice: 'going', version: 1 },
			'702:501': { event_id: 702, membership_id: 501, user_id: 42, choice: 'going', version: 1 },
			'702:504': {
				event_id: 702,
				membership_id: 504,
				user_id: 10,
				choice: 'not_going',
				version: 2,
			},
		},
		event_notices: {
			810: {
				id: 810,
				recipient_id: 42,
				actor_id: 7,
				event_id: 701,
				is_read: false,
				created_at: '2026-10-09T12:00:00Z',
			},
		},
	};
}

// Translates the Phase 5 pack's compact record format into the Phase 4 model
// state so the shared group machinery can serve it.
export function packToState(pack, given) {
	const s = mergeState(pack.state, given);
	const toRecords = (records, map) =>
		Object.fromEntries(Object.entries(records ?? {}).map(([id, value]) => [id, map(value, id)]));
	const users = toRecords(s.users, (user) => ({
		id: user.id,
		display_name: user.display_name,
		visibility: user.visibility,
		is_active: user.active,
	}));
	let followId = 70;
	const follows = Object.fromEntries(
		Object.entries(s.follows ?? {}).map(([pair, state]) => {
			const [from, to] = pair.split(':').map(Number);
			followId += 1;
			return [followId, { id: followId, follower_id: from, followed_id: to, state }];
		}),
	);
	const groups = toRecords(s.groups, (group) => ({
		...group,
		description: `${group.title} group`,
		created_at: CLOCK,
	}));
	return {
		users,
		follows,
		groups,
		group_memberships: toRecords(s.memberships, (membership) => ({
			...membership,
			role: groups[membership.group_id]?.creator_id === membership.user_id ? 'creator' : 'member',
			joined_at: CLOCK,
		})),
		group_invitations: toRecords(s.invitations, (item, id) => ({
			id: Number(id),
			group_id: item.group_id,
			inviter_id: groups[item.group_id].creator_id,
			invitee_id: item.user_id,
			created_at: CLOCK,
		})),
		group_join_requests: toRecords(s.requests, (item, id) => ({
			id: Number(id),
			group_id: item.group_id,
			requester_id: item.user_id,
			created_at: CLOCK,
		})),
		events: structuredClone(s.events),
		event_responses: Object.fromEntries(
			Object.entries(s.responses ?? {}).map(([key, response]) => {
				const [eventId, membershipId] = key.split(':').map(Number);
				return [key, { event_id: eventId, membership_id: membershipId, ...response }];
			}),
		),
		event_notices: toRecords(s.notices, (notice) => ({ created_at: CLOCK, ...notice })),
		next_ids: {
			groups: 100,
			group_invitations: 200,
			group_join_requests: 300,
			group_memberships: s.next_ids.membership,
			notifications: s.next_ids.notice,
			events: s.next_ids.event,
		},
	};
}

export class EventBackend extends GroupBackend {
	constructor({ state = defaultEventState(), given } = {}) {
		super({ state, given });
		const merged = mergeState(state, given);
		this.events = new Map();
		this.responses = new Map();
		this.eventNotices = new Map();
		for (const event of Object.values(merged.events ?? {})) this.events.set(event.id, { ...event });
		for (const [key, response] of Object.entries(merged.event_responses ?? {}))
			this.responses.set(key, { ...response });
		for (const notice of Object.values(merged.event_notices ?? {}))
			this.eventNotices.set(notice.id, { type: 'group_event', ...notice });
	}

	// Pack-format state for the conformance tests.
	static fromPack(pack, given) {
		return new EventBackend({ state: packToState(pack, given) });
	}

	snapshot() {
		const table = (map) => Object.fromEntries([...map].map(([id, value]) => [id, { ...value }]));
		return {
			...super.snapshot(),
			events: table(this.events),
			event_responses: Object.fromEntries(
				[...this.responses].map(([key, value]) => [key, { ...value }]),
			),
			event_notices: table(this.eventNotices),
		};
	}

	// --- model helpers -------------------------------------------------------

	displayName(userId) {
		return this.user(userId)?.display_name ?? UNAVAILABLE_ACCOUNT;
	}

	// A response counts only for the member's current membership generation, so
	// a departed member's answer is hidden and a returner starts over.
	activeResponses(event) {
		return [...this.responses.values()].filter((response) => {
			if (response.event_id !== event.id) return false;
			const membership = this.membershipOf(event.group_id, response.user_id);
			return Boolean(membership && membership.id === response.membership_id);
		});
	}

	eventWire(viewerId, event) {
		const responses = this.activeResponses(event);
		const own = responses.find((response) => response.user_id === viewerId);
		return {
			id: event.id,
			group_id: event.group_id,
			creator: { id: event.creator_id, display_name: this.displayName(event.creator_id) },
			title: event.title,
			description: event.description,
			starts_at: event.starts_at,
			created_at: event.created_at,
			options: ['going', 'not_going'],
			counts: {
				going: responses.filter((response) => response.choice === 'going').length,
				not_going: responses.filter((response) => response.choice === 'not_going').length,
			},
			viewer_response: own ? { choice: own.choice, version: own.version } : null,
		};
	}

	groupEvents(groupId) {
		return [...this.events.values()]
			.filter((event) => event.group_id === groupId)
			.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id - b.id);
	}

	// --- notices -------------------------------------------------------------

	eventNoticeVisible(viewerId, notice) {
		const event = this.events.get(notice.event_id);
		return Boolean(
			notice.recipient_id === viewerId &&
				this.user(notice.actor_id) &&
				event &&
				this.membershipOf(event.group_id, viewerId),
		);
	}

	visibleNotices(viewer) {
		const events = [...this.eventNotices.values()].filter((notice) =>
			this.eventNoticeVisible(viewer.id, notice),
		);
		return [...super.visibleNotices(viewer), ...events].sort(
			(a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
		);
	}

	projectNotice(viewer, notice) {
		if (notice.type !== 'group_event') return super.projectNotice(viewer, notice);
		const event = this.events.get(notice.event_id);
		const group = this.groups.get(event.group_id);
		return {
			id: notice.id,
			type: 'group_event',
			created_at: notice.created_at,
			is_read: notice.is_read,
			actor: this.entry(viewer.id, this.user(notice.actor_id)),
			target: {
				kind: 'group_event',
				event_id: event.id,
				group: { id: group.id, title: group.title },
			},
			actions: [],
		};
	}

	// --- dispatch ------------------------------------------------------------

	// Errors from the inherited Phase 2–4 routes carry illustrative messages;
	// the Phase 5 contract pins the text of the shared ones.
	request(viewerId, method, url, payload = {}) {
		const result = this.handle(viewerId, method, url, payload);
		const code = result.body?.error?.code;
		if (code && MESSAGES[code]) result.body.error.message = MESSAGES[code];
		return result;
	}

	handle(viewerId, method, url, payload) {
		const target = new URL(url, 'http://fixture.test');
		const route = matchEventRoute(target.pathname);
		if (!route) return super.request(viewerId, method, url, payload);
		this.log.push({
			viewerId,
			method,
			path: `${target.pathname}${target.search}`,
			json: payload.json,
		});
		if (!route.methods.includes(method))
			return {
				...failure(405, 'METHOD_NOT_ALLOWED'),
				headers: { ...NO_STORE, Allow: route.methods.join(', ') },
			};
		if (
			method !== 'GET' &&
			payload.headers &&
			payload.headers['X-Requested-With'] !== 'XMLHttpRequest'
		)
			return failure(403, 'CSRF_CHECK_FAILED');
		const viewer = viewerId === null ? null : this.user(viewerId);
		if (!viewer) return failure(401, 'UNAUTHORIZED');
		const ids = route.params.map(parseId);
		if (ids.includes(null)) return badRequest();
		const fault = this.faults.findIndex(
			(item) => item.method === method && item.path.test(target.pathname),
		);
		if (fault >= 0) {
			const item = this.faults[fault];
			if (!item.repeat) this.faults.splice(fault, 1);
			if (!item.commit) return failure(500, 'INTERNAL_SERVER_ERROR');
			const result = this.dispatchEvent(viewer, method, route, ids, target, payload.json);
			return result.status < 400 ? failure(500, 'INTERNAL_SERVER_ERROR') : result;
		}
		return this.dispatchEvent(viewer, method, route, ids, target, payload.json);
	}

	dispatchEvent(viewer, method, route, [groupId, eventId], target, json) {
		const params = target.searchParams;
		switch (route.name) {
			case 'events':
				return method === 'GET'
					? this.listEvents(viewer, groupId, params)
					: this.createEvent(viewer, groupId, json);
			case 'event':
				return this.readEvent(viewer, groupId, eventId, params);
			case 'responses':
				return this.listResponses(viewer, groupId, eventId, params);
			default:
				return this.respond(viewer, groupId, eventId, json);
		}
	}

	member(viewer, groupId) {
		return this.group(groupId) ? this.membershipOf(groupId, viewer.id) : null;
	}

	bodyOf(json, allowed) {
		if (json === undefined) return { body: {} };
		if (!isObject(json) || Object.keys(json).some((key) => !allowed.includes(key)))
			return { error: badRequest() };
		for (const [key, value] of Object.entries(json)) {
			const text = ['title', 'description', 'starts_at', 'choice'].includes(key);
			if (text ? typeof value !== 'string' : !Number.isInteger(value))
				return { error: badRequest() };
		}
		return { body: json };
	}

	idField(value, { zero }) {
		return Number.isInteger(value) && value >= (zero ? 0 : 1) && value <= MAX_ID;
	}

	listEvents(viewer, groupId, params) {
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		if (!this.member(viewer, groupId)) return notFound();
		return this.pagedReply(this.groupEvents(groupId), params, (event) =>
			this.eventWire(viewer.id, event),
		);
	}

	readEvent(viewer, groupId, eventId, params) {
		if (!this.strictParams(params, [])) return badRequest();
		if (!this.member(viewer, groupId)) return notFound();
		const event = this.events.get(eventId);
		if (!event || event.group_id !== groupId) return notFound();
		return reply(200, { data: this.eventWire(viewer.id, event) });
	}

	listResponses(viewer, groupId, eventId, params) {
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		if (!this.member(viewer, groupId)) return notFound();
		const event = this.events.get(eventId);
		if (!event || event.group_id !== groupId) return notFound();
		const items = this.activeResponses(event).sort((a, b) => a.user_id - b.user_id);
		return this.pagedReply(items, params, (response) => ({
			user: { id: response.user_id, display_name: this.displayName(response.user_id) },
			choice: response.choice,
			version: response.version,
		}));
	}

	// The membership ID names a generation: a current member holding an old one
	// is stale, never silently accepted.
	currentMembership(viewer, groupId, body) {
		const membership = this.member(viewer, groupId);
		if (!membership) return { error: notFound() };
		if (body.membership_id !== membership.id) return { error: failure(409, 'STALE_MEMBERSHIP') };
		return { membership };
	}

	createEvent(viewer, groupId, json) {
		const { body, error } = this.bodyOf(json, [
			'membership_id',
			'title',
			'description',
			'starts_at',
		]);
		if (error) return error;
		const fields = {};
		const clean = {};
		for (const [field, limit, multiline] of [
			['title', 100, false],
			['description', 1000, true],
		]) {
			const checked = cleanText(body[field], limit, { multiline });
			if (checked.error) fields[field] = checked.error;
			else clean[field] = checked.text;
		}
		const startsAt = parseInstant(body.starts_at);
		if (startsAt === null) fields.starts_at = 'INVALID_TIME';
		if (!this.idField(body.membership_id, { zero: false })) fields.membership_id = 'INVALID_ID';
		if (Object.keys(fields).length) return invalid(fields);
		const { error: denied } = this.currentMembership(viewer, groupId, body);
		if (denied) return denied;
		const event = {
			id: this.allocate('events'),
			group_id: groupId,
			creator_id: viewer.id,
			title: clean.title,
			description: clean.description,
			starts_at: startsAt,
			created_at: CLOCK,
		};
		this.events.set(event.id, event);
		const members = this.activeMembers(groupId).map((item) => item.user_id);
		const recipients = members.filter((id) => id !== viewer.id);
		for (const recipientId of recipients) {
			const id = this.allocate('notifications');
			this.eventNotices.set(id, {
				id,
				type: 'group_event',
				recipient_id: recipientId,
				actor_id: viewer.id,
				event_id: event.id,
				is_read: false,
				created_at: CLOCK,
			});
		}
		if (recipients.length) this.signal('notification.new', recipients);
		this.signal('social.invalidate', members);
		return reply(201, { data: this.eventWire(viewer.id, event) });
	}

	respond(viewer, groupId, eventId, json) {
		const { body, error } = this.bodyOf(json, ['membership_id', 'choice', 'expected_version']);
		if (error) return error;
		const fields = {};
		if (!['going', 'not_going'].includes(body.choice)) fields.choice = 'INVALID_CHOICE';
		if (!this.idField(body.membership_id, { zero: false })) fields.membership_id = 'INVALID_ID';
		if (!this.idField(body.expected_version, { zero: true }))
			fields.expected_version = 'INVALID_ID';
		if (Object.keys(fields).length) return invalid(fields);
		const { membership, error: denied } = this.currentMembership(viewer, groupId, body);
		if (denied) return denied;
		const event = this.events.get(eventId);
		if (!event || event.group_id !== groupId) return notFound();
		const key = `${eventId}:${membership.id}`;
		const old = this.responses.get(key);
		if (body.expected_version !== (old?.version ?? 0)) return failure(409, 'STALE_EVENT_RESPONSE');
		this.responses.set(key, {
			event_id: eventId,
			membership_id: membership.id,
			user_id: viewer.id,
			choice: body.choice,
			version: (old?.version ?? 0) + 1,
		});
		this.signal(
			'social.invalidate',
			this.activeMembers(groupId).map((item) => item.user_id),
		);
		return reply(200, { data: this.eventWire(viewer.id, event) });
	}

	// --- control actions used by journeys -------------------------------------

	// Control actions for journeys: a silent removal and a fresh admission with a
	// new membership generation, as the group transitions would commit them.
	removeMember(groupId, userId) {
		const membership = this.membershipOf(groupId, userId);
		if (!membership) throw new Error(`User ${userId} is not in group ${groupId}`);
		this.memberships.delete(membership.id);
	}

	observable(actorId) {
		const visible = this.user(actorId)
			? [...this.eventNotices.values()].filter((notice) => this.eventNoticeVisible(actorId, notice))
			: [];
		return {
			events_count: this.events.size,
			notice_recipients_902: [...this.eventNotices.values()]
				.filter((notice) => notice.event_id === 902)
				.map((notice) => notice.recipient_id)
				.sort((a, b) => a - b),
			notice_unread: visible.filter((notice) => !notice.is_read).length,
		};
	}
}
