// Stateful stand-in for the SN-B17 group contract, used only by tests. It
// extends the Phase 2 model (people, follows, notices) with groups, membership
// generations, delete-on-resolve invitations/requests, their notices and the
// post-commit signal recipients, so UI tests exercise real transitions rather
// than one canned success. Its conformance to the approved pack is checked by
// `group-model.test.js`. It is never imported by `SPA/src` (a policy test
// enforces that).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FixtureBackend, makeUser } from '../phase2/fixture-backend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE_PATH = path.join(ROOT, 'docs/social-network/fixtures/phase-4-contract.json');
const MAX_ID = Number.MAX_SAFE_INTEGER;
const NO_STORE = { 'Cache-Control': 'no-store' };
const CONTROL = /\p{Cc}/u;

export const CLOCK = '2026-10-09T12:00:00Z';

export function loadGroupFixtures() {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

// Pinned messages for the stale/conflict codes; others are illustrative.
const MESSAGES = {
	STALE_INVITATION: 'Invitation changed; refresh before acting',
	STALE_JOIN_REQUEST: 'Request changed; refresh before acting',
	STALE_MEMBERSHIP: 'Membership changed; refresh before acting',
	ALREADY_MEMBER: 'Already a member',
	CREATOR_CANNOT_LEAVE: 'The creator cannot leave the group',
	SELF_INVITE: 'Cannot invite yourself',
};

function reply(status, body = null) {
	return { status, headers: { ...NO_STORE }, body };
}

function failure(status, code, fields) {
	const error = { code, message: MESSAGES[code] ?? 'Fixture error; clients branch on code' };
	if (fields) error.fields = fields;
	return reply(status, { error });
}

const badRequest = () => failure(400, 'BAD_REQUEST');
const notFound = () => failure(404, 'NOT_FOUND');
const invalid = (fields) => failure(400, 'VALIDATION_ERROR', fields);

function parseId(text) {
	if (typeof text !== 'string' || !/^[1-9]\d*$/u.test(text)) return null;
	const id = Number(text);
	return id <= MAX_ID ? id : null;
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Deep-merges a fixture `given` patch: objects recurse, null deletes, other
// values replace.
export function mergeState(base, patch) {
	const out = structuredClone(base);
	(function apply(target, source) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (value === null) delete target[key];
			else if (isObject(value) && isObject(target[key])) apply(target[key], value);
			else target[key] = structuredClone(value);
		}
	})(out, patch);
	return out;
}

function groupText(value, field) {
	const text = value.replace(/\r\n/gu, '\n').trim();
	if (text === '') return { error: 'REQUIRED' };
	const max = field === 'title' ? 100 : 1000;
	if ([...text].length > max) return { error: 'TOO_LONG' };
	const checked = field === 'title' ? text : text.replace(/[\n\t]/gu, '');
	return CONTROL.test(checked) ? { error: 'INVALID_TEXT' } : { text };
}

const ROUTES = [
	['groups', /^\/api\/v1\/groups$/u, ['GET', 'POST']],
	['group', /^\/api\/v1\/groups\/([^/]+)$/u, ['GET']],
	['members', /^\/api\/v1\/groups\/([^/]+)\/members$/u, ['GET']],
	['invitations', /^\/api\/v1\/groups\/([^/]+)\/invitations$/u, ['POST']],
	['joinRequests', /^\/api\/v1\/groups\/([^/]+)\/join-requests$/u, ['GET', 'POST']],
	['invitation', /^\/api\/v1\/group-invitations\/([^/]+)$/u, ['PATCH']],
	['joinRequest', /^\/api\/v1\/group-join-requests\/([^/]+)$/u, ['PATCH']],
	['membership', /^\/api\/v1\/group-memberships\/([^/]+)$/u, ['DELETE']],
	['myInvitations', /^\/api\/v1\/users\/me\/group-invitations$/u, ['GET']],
];

function matchGroupRoute(pathname) {
	for (const [name, pattern, methods] of ROUTES) {
		const match = pattern.exec(pathname);
		if (match) return { name, param: match[1], methods };
	}
	return null;
}

const ENTRY_KEY = { group_invitation: 'invitation_id', group_join_request: 'request_id' };

export class GroupBackend extends FixtureBackend {
	// `state` uses the pack's record format (records keyed by decimal ID).
	constructor({ state = loadGroupFixtures().state, given } = {}) {
		const merged = mergeState(state, given);
		const users = Object.values(merged.users).map((user) =>
			makeUser(user.id, {
				display_name: user.display_name,
				visibility: user.visibility,
				active: user.is_active,
			}),
		);
		const follows = Object.values(merged.follows ?? {}).map((follow) => ({
			created_at: CLOCK,
			accepted_at: follow.state === 'accepted' ? CLOCK : null,
			...follow,
		}));
		super({ users, follows });
		this.groups = new Map();
		this.memberships = new Map();
		this.invitations = new Map();
		this.joinRequests = new Map();
		this.groupNotices = new Map();
		for (const [table, map] of [
			['groups', this.groups],
			['group_memberships', this.memberships],
			['group_invitations', this.invitations],
			['group_join_requests', this.joinRequests],
		])
			for (const record of Object.values(merged[table] ?? {})) map.set(record.id, { ...record });
		for (const notice of Object.values(merged.notifications ?? {}))
			if (ENTRY_KEY[notice.type]) this.groupNotices.set(notice.id, { ...notice });
		this.nextIds = { ...merged.next_ids };
		this.signals = [];
		this.faults = [];
	}

	allocate(table) {
		const id = this.nextIds[table];
		this.nextIds[table] += 1;
		return id;
	}

	// Snapshot in the pack's state format, for expected-state assertions.
	snapshot() {
		const table = (map) => Object.fromEntries([...map].map(([id, value]) => [id, { ...value }]));
		return {
			groups: table(this.groups),
			group_memberships: table(this.memberships),
			group_invitations: table(this.invitations),
			group_join_requests: table(this.joinRequests),
			notifications: table(this.groupNotices),
		};
	}

	group(id) {
		const group = this.groups.get(id);
		return group && this.user(group.creator_id) ? group : null;
	}

	membershipOf(groupId, userId) {
		if (!this.user(userId)) return null;
		return (
			[...this.memberships.values()].find((m) => m.group_id === groupId && m.user_id === userId) ??
			null
		);
	}

	activeMembers(groupId) {
		return [...this.memberships.values()].filter(
			(m) => m.group_id === groupId && this.user(m.user_id),
		);
	}

	name(userId) {
		const user = this.users.get(userId);
		return { id: user.id, display_name: user.display_name };
	}

	summary(group) {
		return {
			id: group.id,
			title: group.title,
			description: group.description,
			creator: this.name(group.creator_id),
		};
	}

	liveInvitations(predicate) {
		return [...this.invitations.values()].filter(
			(item) => this.user(item.inviter_id) && predicate(item),
		);
	}

	groupWire(viewerId, group) {
		const membership = this.membershipOf(group.id, viewerId);
		const role = membership?.role ?? 'none';
		const invitations = membership
			? []
			: this.liveInvitations((item) => item.group_id === group.id && item.invitee_id === viewerId)
					.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
					.map((item) => ({
						id: item.id,
						created_at: item.created_at,
						inviter: this.name(item.inviter_id),
					}));
		const request = membership
			? null
			: [...this.joinRequests.values()].find(
					(item) => item.group_id === group.id && item.requester_id === viewerId,
				);
		const wire = {
			...this.summary(group),
			created_at: group.created_at,
			viewer: {
				role,
				membership_id: membership?.id ?? null,
				invitations,
				join_request: request ? { id: request.id, created_at: request.created_at } : null,
			},
		};
		const { creator, ...rest } = wire;
		const ordered = {
			id: rest.id,
			title: rest.title,
			description: rest.description,
			created_at: rest.created_at,
			creator,
			viewer: rest.viewer,
		};
		if (membership) ordered.member_count = this.activeMembers(group.id).length;
		return ordered;
	}

	invitationWire(viewerId, item) {
		return {
			id: item.id,
			created_at: item.created_at,
			group: this.summary(this.groups.get(item.group_id)),
			inviter: this.entry(viewerId, this.user(item.inviter_id)),
			invitee: this.entry(viewerId, this.user(item.invitee_id)),
		};
	}

	requestWire(viewerId, item) {
		return {
			id: item.id,
			created_at: item.created_at,
			group: this.summary(this.groups.get(item.group_id)),
			requester: this.entry(viewerId, this.user(item.requester_id)),
		};
	}

	membershipWire(item) {
		return {
			id: item.id,
			group_id: item.group_id,
			user_id: item.user_id,
			role: item.role,
			joined_at: item.joined_at,
		};
	}

	signal(type, recipients) {
		if (recipients === 'all_authenticated') {
			this.signals.push({ type, recipients });
			return;
		}
		const sorted = [...new Set(recipients)].filter((id) => this.user(id)).sort((a, b) => a - b);
		if (sorted.length) this.signals.push({ type, recipients: sorted });
	}

	// --- notices -----------------------------------------------------------

	addNotice(type, recipientId, actorId, groupId, entryId) {
		const id = this.allocate('notifications');
		this.groupNotices.set(id, {
			id,
			recipient_id: recipientId,
			actor_id: actorId,
			type,
			post_id: null,
			comment_id: null,
			group_id: groupId,
			entry_id: entryId,
			state: 'pending',
			is_read: false,
			created_at: CLOCK,
		});
	}

	resolveNotices(type, entryId, state, named) {
		for (const notice of this.groupNotices.values()) {
			if (notice.type !== type || notice.entry_id !== entryId || notice.state !== 'pending')
				continue;
			notice.state = state;
			notice.is_read = true;
			named.push(notice.recipient_id, notice.actor_id);
		}
	}

	entryLive(notice) {
		if (notice.state !== 'pending') return false;
		if (notice.type === 'group_invitation') {
			const item = this.invitations.get(notice.entry_id);
			return Boolean(item && this.user(item.inviter_id));
		}
		return this.joinRequests.has(notice.entry_id);
	}

	visibleNotices(viewer) {
		const groupNotices = [...this.groupNotices.values()].filter(
			(notice) => notice.recipient_id === viewer.id && this.user(notice.actor_id),
		);
		return [...super.visibleNotices(viewer), ...groupNotices].sort(
			(a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
		);
	}

	projectNotice(viewer, notice) {
		if (!ENTRY_KEY[notice.type]) return super.projectNotice(viewer, notice);
		const group = this.groups.get(notice.group_id);
		return {
			id: notice.id,
			type: notice.type,
			created_at: notice.created_at,
			is_read: notice.is_read,
			actor: this.entry(viewer.id, this.user(notice.actor_id)),
			target: {
				kind: notice.type,
				[ENTRY_KEY[notice.type]]: notice.entry_id,
				group: { id: group.id, title: group.title },
				state: notice.state,
			},
			actions: this.entryLive(notice) ? ['accept', 'refuse'] : [],
		};
	}

	// --- dispatch ------------------------------------------------------------

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only route dispatcher
	request(viewerId, method, url, payload = {}) {
		const target = new URL(url, 'http://fixture.test');
		const route = matchGroupRoute(target.pathname);
		const readRoute = /^\/api\/v1\/notifications\/([^/]+\/read|read-all)$/u.test(target.pathname);
		if (!route && !readRoute) return super.request(viewerId, method, url, payload);
		this.log.push({ viewerId, method, path: `${target.pathname}${target.search}`, ...payload });
		if (route && !route.methods.includes(method)) return failure(405, 'METHOD_NOT_ALLOWED');
		const viewer = viewerId === null ? null : this.user(viewerId);
		if (!viewer) return failure(401, 'UNAUTHORIZED');
		if (
			method !== 'GET' &&
			payload.headers &&
			payload.headers['X-Requested-With'] !== 'XMLHttpRequest'
		)
			return failure(403, 'CSRF_CHECK_FAILED');
		if (readRoute) return this.readWithSignal(viewer, method, url, payload);
		const fault = this.faults.findIndex(
			(item) => item.method === method && item.path.test(target.pathname),
		);
		if (fault >= 0) {
			const item = this.faults[fault];
			if (!item.repeat) this.faults.splice(fault, 1);
			if (!item.commit) return failure(500, 'INTERNAL_SERVER_ERROR');
			const result = this.dispatchGroup(viewer, method, route, target, payload.json);
			return result.status < 400 ? failure(500, 'INTERNAL_SERVER_ERROR') : result;
		}
		return this.dispatchGroup(viewer, method, route, target, payload.json);
	}

	readWithSignal(viewer, method, url, payload) {
		const before = this.visibleNotices(viewer).filter((notice) => !notice.is_read).length;
		const result = super.request(viewer.id, method, url, payload);
		const after = this.visibleNotices(viewer).filter((notice) => !notice.is_read).length;
		if (result.status < 400 && after !== before) this.signal('social.invalidate', [viewer.id]);
		return result;
	}

	dispatchGroup(viewer, method, route, target, json) {
		const params = target.searchParams;
		let id = null;
		if (route.param !== undefined) {
			id = parseId(route.param);
			if (!id) return badRequest();
		}
		switch (route.name) {
			case 'groups':
				return method === 'GET' ? this.listGroups(viewer, params) : this.createGroup(viewer, json);
			case 'group': {
				const group = this.group(id);
				return group ? reply(200, { data: this.groupWire(viewer.id, group) }) : notFound();
			}
			case 'members':
				return this.listMembers(viewer, id, params);
			case 'invitations':
				return this.invite(viewer, id, json);
			case 'joinRequests':
				return method === 'GET'
					? this.listJoinRequests(viewer, id, params)
					: this.requestToJoin(viewer, id, json);
			case 'invitation':
				return this.decideInvitation(viewer, id, json);
			case 'joinRequest':
				return this.decideJoinRequest(viewer, id, json);
			case 'membership':
				return this.removeMembership(viewer, id, json);
			default:
				return this.myInvitations(viewer, params);
		}
	}

	strictParams(params, allowed) {
		for (const key of params.keys()) if (!allowed.includes(key)) return false;
		return allowed.every((key) => params.getAll(key).length <= 1);
	}

	pagedReply(items, params, wire) {
		const paged = this.page(items, params);
		if (!paged) return badRequest();
		return reply(200, { data: paged.items.map(wire), meta: { pagination: paged.pagination } });
	}

	listGroups(viewer, params) {
		if (!this.strictParams(params, ['q', 'membership', 'page', 'per_page'])) return badRequest();
		const membership = params.get('membership') ?? 'all';
		if (!['all', 'member'].includes(membership)) return badRequest();
		const q = (params.get('q') ?? '').trim();
		if ([...q].length > 100) return invalid({ q: 'TOO_LONG' });
		if (CONTROL.test(q)) return invalid({ q: 'INVALID_TEXT' });
		const needle = q.toLowerCase();
		const items = [...this.groups.values()]
			.filter((group) => this.group(group.id))
			.filter((group) => group.title.toLowerCase().includes(needle))
			.filter((group) => membership === 'all' || this.membershipOf(group.id, viewer.id))
			.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
		return this.pagedReply(items, params, (group) => this.groupWire(viewer.id, group));
	}

	listMembers(viewer, groupId, params) {
		const group = this.group(groupId);
		if (!group || !this.membershipOf(groupId, viewer.id)) return notFound();
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		const members = this.activeMembers(groupId);
		const users = this.sortedUsers(members.map((m) => this.user(m.user_id)));
		return this.pagedReply(users, params, (user) => {
			const membership = members.find((m) => m.user_id === user.id);
			return {
				...this.entry(viewer.id, user),
				membership: { id: membership.id, role: membership.role, joined_at: membership.joined_at },
			};
		});
	}

	listJoinRequests(viewer, groupId, params) {
		const group = this.group(groupId);
		if (!group || group.creator_id !== viewer.id) return notFound();
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		const items = [...this.joinRequests.values()]
			.filter((item) => item.group_id === groupId && this.user(item.requester_id))
			.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
		return this.pagedReply(items, params, (item) => this.requestWire(viewer.id, item));
	}

	myInvitations(viewer, params) {
		if (!this.strictParams(params, ['page', 'per_page'])) return badRequest();
		const items = this.liveInvitations((item) => item.invitee_id === viewer.id)
			.filter((item) => this.group(item.group_id))
			.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
		return this.pagedReply(items, params, (item) => this.invitationWire(viewer.id, item));
	}

	createGroup(viewer, json) {
		if (!isObject(json)) return badRequest();
		if (Object.keys(json).some((key) => key !== 'title' && key !== 'description'))
			return badRequest();
		const fields = {};
		const values = {};
		for (const field of ['title', 'description']) {
			if (json[field] === undefined) {
				fields[field] = 'REQUIRED';
				continue;
			}
			if (typeof json[field] !== 'string') return badRequest();
			const checked = groupText(json[field], field);
			if (checked.error) fields[field] = checked.error;
			else values[field] = checked.text;
		}
		if (Object.keys(fields).length) return invalid(fields);
		const group = {
			id: this.allocate('groups'),
			creator_id: viewer.id,
			title: values.title,
			description: values.description,
			created_at: CLOCK,
		};
		this.groups.set(group.id, group);
		const membership = {
			id: this.allocate('group_memberships'),
			group_id: group.id,
			user_id: viewer.id,
			role: 'creator',
			joined_at: CLOCK,
		};
		this.memberships.set(membership.id, membership);
		this.signal('social.invalidate', 'all_authenticated');
		return reply(201, { data: this.groupWire(viewer.id, group) });
	}

	invite(viewer, groupId, json) {
		if (!isObject(json) || Object.keys(json).some((key) => key !== 'user_id')) return badRequest();
		if (json.user_id === undefined) return invalid({ user_id: 'REQUIRED' });
		if (typeof json.user_id !== 'number') return badRequest();
		if (!Number.isSafeInteger(json.user_id) || json.user_id <= 0)
			return invalid({ user_id: 'INVALID_ID' });
		if (json.user_id === viewer.id) return failure(400, 'SELF_INVITE', { user_id: 'SELF_INVITE' });
		const group = this.group(groupId);
		if (!group || !this.membershipOf(groupId, viewer.id)) return notFound();
		const invitee = this.user(json.user_id);
		if (!invitee) return notFound();
		if (this.membershipOf(groupId, invitee.id)) return failure(409, 'ALREADY_MEMBER');
		const existing = [...this.invitations.values()].find(
			(item) =>
				item.group_id === groupId &&
				item.inviter_id === viewer.id &&
				item.invitee_id === invitee.id,
		);
		if (existing) return reply(200, { data: this.invitationWire(viewer.id, existing) });
		const item = {
			id: this.allocate('group_invitations'),
			group_id: groupId,
			inviter_id: viewer.id,
			invitee_id: invitee.id,
			created_at: CLOCK,
		};
		this.invitations.set(item.id, item);
		this.addNotice('group_invitation', invitee.id, viewer.id, groupId, item.id);
		this.signal('notification.new', [invitee.id]);
		this.signal('social.invalidate', [viewer.id, invitee.id]);
		return reply(201, { data: this.invitationWire(viewer.id, item) });
	}

	requestToJoin(viewer, groupId, json) {
		if (json !== undefined) return badRequest();
		const group = this.group(groupId);
		if (!group) return notFound();
		if (this.membershipOf(groupId, viewer.id)) return failure(409, 'ALREADY_MEMBER');
		const existing = [...this.joinRequests.values()].find(
			(item) => item.group_id === groupId && item.requester_id === viewer.id,
		);
		if (existing) return reply(200, { data: this.requestWire(viewer.id, existing) });
		const item = {
			id: this.allocate('group_join_requests'),
			group_id: groupId,
			requester_id: viewer.id,
			created_at: CLOCK,
		};
		this.joinRequests.set(item.id, item);
		this.addNotice('group_join_request', group.creator_id, viewer.id, groupId, item.id);
		this.signal('notification.new', [group.creator_id]);
		this.signal('social.invalidate', [viewer.id, group.creator_id]);
		return reply(201, { data: this.requestWire(viewer.id, item) });
	}

	decision(json) {
		if (!isObject(json) || Object.keys(json).some((key) => key !== 'decision'))
			return { error: badRequest() };
		if (json.decision === undefined) return { error: invalid({ decision: 'REQUIRED' }) };
		if (json.decision !== 'accept' && json.decision !== 'refuse')
			return { error: invalid({ decision: 'INVALID_CHOICE' }) };
		return { decision: json.decision };
	}

	// Inserts the membership and resolves every other pending entry the new
	// member holds for that group, as one transaction.
	admit(groupId, userId, named) {
		const membership = {
			id: this.allocate('group_memberships'),
			group_id: groupId,
			user_id: userId,
			role: 'member',
			joined_at: CLOCK,
		};
		this.memberships.set(membership.id, membership);
		named.push(userId);
		for (const item of [...this.invitations.values()]) {
			if (item.group_id !== groupId || item.invitee_id !== userId) continue;
			this.invitations.delete(item.id);
			named.push(item.inviter_id, item.invitee_id);
			this.resolveNotices('group_invitation', item.id, 'superseded', named);
		}
		for (const item of [...this.joinRequests.values()]) {
			if (item.group_id !== groupId || item.requester_id !== userId) continue;
			this.joinRequests.delete(item.id);
			named.push(item.requester_id);
			this.resolveNotices('group_join_request', item.id, 'superseded', named);
		}
		return membership;
	}

	membershipSignal(groupId, named) {
		const members = this.activeMembers(groupId).map((m) => m.user_id);
		this.signal('social.invalidate', [...named, ...members]);
	}

	decideInvitation(viewer, id, json) {
		const { decision, error } = this.decision(json);
		if (error) return error;
		const item = this.invitations.get(id);
		if (!item || !this.user(item.inviter_id) || !this.group(item.group_id))
			return failure(409, 'STALE_INVITATION');
		if (item.invitee_id !== viewer.id) return notFound();
		const named = [item.inviter_id, item.invitee_id];
		if (decision === 'refuse') {
			this.invitations.delete(id);
			this.resolveNotices('group_invitation', id, 'refused', named);
			this.signal('social.invalidate', named);
			return reply(204);
		}
		if (this.membershipOf(item.group_id, viewer.id)) return failure(409, 'STALE_INVITATION');
		this.invitations.delete(id);
		this.resolveNotices('group_invitation', id, 'accepted', named);
		const membership = this.admit(item.group_id, viewer.id, named);
		this.membershipSignal(item.group_id, named);
		return reply(200, { data: this.membershipWire(membership) });
	}

	decideJoinRequest(viewer, id, json) {
		const { decision, error } = this.decision(json);
		if (error) return error;
		const item = this.joinRequests.get(id);
		const group = item && this.group(item.group_id);
		if (!item || !group || !this.user(item.requester_id)) return failure(409, 'STALE_JOIN_REQUEST');
		if (group.creator_id !== viewer.id) return notFound();
		const named = [item.requester_id];
		this.joinRequests.delete(id);
		if (decision === 'refuse') {
			this.resolveNotices('group_join_request', id, 'refused', named);
			this.signal('social.invalidate', named);
			return reply(204);
		}
		this.resolveNotices('group_join_request', id, 'accepted', named);
		const membership = this.admit(group.id, item.requester_id, named);
		this.membershipSignal(group.id, named);
		return reply(200, { data: this.membershipWire(membership) });
	}

	removeMembership(viewer, id, json) {
		if (json !== undefined) return badRequest();
		const membership = this.memberships.get(id);
		if (!membership || !this.user(membership.user_id)) return failure(409, 'STALE_MEMBERSHIP');
		const group = this.group(membership.group_id);
		if (!group) return failure(409, 'STALE_MEMBERSHIP');
		const own = membership.user_id === viewer.id;
		if (own && membership.role === 'creator') return failure(409, 'CREATOR_CANNOT_LEAVE');
		if (!own && (group.creator_id !== viewer.id || membership.role === 'creator'))
			return notFound();
		this.memberships.delete(id);
		const named = [membership.user_id];
		// Departure cancels the departing member's still-pending invitations.
		for (const item of [...this.invitations.values()]) {
			if (item.group_id !== group.id || item.inviter_id !== membership.user_id) continue;
			this.invitations.delete(item.id);
			named.push(item.inviter_id, item.invitee_id);
			this.resolveNotices('group_invitation', item.id, 'cancelled', named);
		}
		this.membershipSignal(group.id, named);
		return reply(204);
	}
}

// fetch-compatible adapter with session switching, held/failed responses and
// a record of every call, matching the Phase 2 and 3 helpers.
export function createGroupFetch(backend, { viewer = () => 42, before, after } = {}) {
	const calls = [];
	async function fetchRef(url, init = {}) {
		const method = init.method ?? 'GET';
		const json = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		const headers = init.headers ?? {};
		const entry = { url, method, json, headers };
		calls.push(entry);
		if (before) await before(entry);
		const result = backend.request(viewer(), method, url, { json, headers });
		if (after) await after(entry, result);
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			headers: result.headers,
			json: async () => {
				if (result.body === null) throw new SyntaxError('empty body');
				return JSON.parse(JSON.stringify(result.body));
			},
		};
	}
	fetchRef.calls = calls;
	return fetchRef;
}
