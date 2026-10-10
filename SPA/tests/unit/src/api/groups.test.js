// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import * as api from '../../../../src/api/groups.js';
import {
	fetchNotifications,
	markAllNotificationsRead,
	markNotificationRead,
} from '../../../../src/api/social.js';
import { loadGroupFixtures } from '../../../fixtures/phase4/group-backend.js';

const pack = loadGroupFixtures();
const GROUP_ROUTE =
	/^\/api\/v1\/(groups|group-invitations\/|group-join-requests\/|group-memberships\/|users\/me\/group-invitations)/u;
// Every group/membership route plus every group-notice case the client reads.
const cases = pack.cases.filter(
	(c) =>
		GROUP_ROUTE.test(c.request.path) ||
		(/^\/api\/v1\/notifications/u.test(c.request.path) && !c.tags.includes('content')) ||
		/hidden-group-content$/u.test(c.name),
);

// Server-side rejections the client cannot produce (unknown or repeated query
// keys, malformed JSON, wrong methods/origins/headers, forbidden bodies). They
// still replay through the nearest client function so their outcome mapping is
// checked, but the request is not expected to match.
const SERVER_ONLY = new Set([
	'groups-detail-wrong-method',
	'groups-list-unknown-key',
	'groups-list-bad-membership',
	'groups-list-repeated-key',
	'group-create-null-title',
	'group-create-numeric-title',
	'group-create-unknown-field',
	'group-create-array-body',
	'group-create-duplicate-key',
	'group-create-trailing-json',
	'group-create-bad-type',
	'group-create-over-budget',
	'group-create-wrong-method',
	'members-unknown-key',
	'members-wrong-method',
	'invite-string-user-id',
	'invite-unknown-field',
	'invite-wrong-method',
	'my-invitations-unknown-key',
	'invitation-decision-unknown-field',
	'invitation-decision-wrong-method',
	'request-body-not-allowed',
	'request-wrong-method',
	'join-requests-unknown-key',
	'request-decision-wrong-method',
	'membership-body-not-allowed',
	'membership-wrong-method',
]);

function options(params) {
	return {
		page: params.has('page') ? Number(params.get('page')) : 1,
		perPage: params.has('per_page') ? Number(params.get('per_page')) : undefined,
	};
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dispatch approved fixtures across distinct client routes
function call(request, fetchRef) {
	const url = new URL(request.path, 'http://test');
	const params = url.searchParams;
	const path = url.pathname.replace('/api/v1', '');
	const body = request.body ?? {};
	if (path === '/notifications') return fetchNotifications(options(params), fetchRef);
	if (path === '/notifications/read-all') return markAllNotificationsRead(fetchRef);
	const read = path.match(/^\/notifications\/(\d+)\/read$/u);
	if (read) return markNotificationRead(Number(read[1]), fetchRef);
	if (path === '/users/me/group-invitations')
		return api.fetchMyInvitations(options(params), fetchRef);
	if (path === '/groups') {
		if (request.method !== 'GET') return api.createGroup(body, fetchRef);
		const membership = params.get('membership');
		return api.fetchGroups(
			{
				q: params.get('q') ?? '',
				membership: membership === 'member' ? membership : 'all',
				...options(params),
			},
			fetchRef,
		);
	}
	const nested = path.match(/^\/groups\/([^/]+)\/(members|invitations|join-requests)$/u);
	if (nested) {
		const [, id, kind] = nested;
		if (kind === 'members') return api.fetchGroupMembers(id, options(params), fetchRef);
		if (kind === 'invitations') return api.inviteToGroup(id, body.user_id, fetchRef);
		return request.method === 'GET'
			? api.fetchJoinRequests(id, options(params), fetchRef)
			: api.requestToJoin(id, fetchRef);
	}
	const [, resource, id] = path.split('/');
	if (resource === 'groups') return api.fetchGroup(id, fetchRef);
	if (resource === 'group-invitations') return api.decideInvitation(id, body.decision, fetchRef);
	if (resource === 'group-join-requests') return api.decideJoinRequest(id, body.decision, fetchRef);
	return api.removeMembership(id, fetchRef);
}

const CONFLICTS = {
	STALE_INVITATION: 'stale-invitation',
	STALE_JOIN_REQUEST: 'stale-request',
	STALE_MEMBERSHIP: 'stale-membership',
	ALREADY_MEMBER: 'already-member',
	CREATOR_CANNOT_LEAVE: 'creator-cannot-leave',
};
function expectedStatus(response) {
	if (response.status < 300) return 'ok';
	if (response.status === 401) return 'unauthenticated';
	if (response.status === 404) return 'not-found';
	if (response.status === 409) return CONFLICTS[response.body.error.code];
	return 'rejected';
}

function respond(c) {
	return vi.fn(async () => ({
		ok: c.response.status < 400,
		status: c.response.status,
		json: async () => {
			if (c.response.body === null || c.response.body === undefined) throw new SyntaxError('empty');
			return structuredClone(c.response.body);
		},
	}));
}

describe('SN-A15 approved contract replay', () => {
	test('covers every group-owned case and the two hidden group-content notice reads', () => {
		expect(cases).toHaveLength(207);
		expect(cases.filter((c) => SERVER_ONLY.has(c.name))).toHaveLength(SERVER_ONLY.size);
	});

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: verify request and each approved response schema
	test.each(cases.map((c) => [c.name, c]))('%s', async (_name, c) => {
		const fetchRef = respond(c);
		const result = await call(c.request, fetchRef);
		expect(result.status).toBe(expectedStatus(c.response));
		expect(fetchRef).toHaveBeenCalledTimes(1);
		const [path, init] = fetchRef.mock.calls[0];
		expect(init.credentials).toBe('include');
		if (!SERVER_ONLY.has(c.name)) {
			expect(path).toBe(c.request.path);
			expect(init.method).toBe(c.request.method);
			if (init.method !== 'GET') expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
			if (c.request.body) expect(JSON.parse(init.body)).toEqual(c.request.body);
			else expect(init.body).toBeUndefined();
		}
		if (c.response.status !== 200 && c.response.status !== 201) return;
		const { data, meta } = c.response.body;
		for (const key of ['groups', 'members', 'requests', 'invitations']) {
			if (!result[key]) continue;
			expect(result[key]).toEqual(data);
			expect(result.pagination).toEqual(meta.pagination);
		}
		for (const key of ['group', 'invitation', 'request', 'membership'])
			if (result[key]) expect(result[key]).toEqual(data);
		if (result.notifications) {
			expect(result.notifications).toEqual(data.notifications);
			expect(result.unreadCount).toBe(data.unread_count);
		}
		const shapes = ['groups', 'members', 'requests', 'invitations', 'group', 'invitation'];
		const typed = [...shapes, 'request', 'membership', 'notifications'];
		expect(typed.some((key) => result[key])).toBe(true);
	});
});

function okResponse(data, meta) {
	return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data, meta }) }));
}
const caseBody = (name) => structuredClone(pack.cases.find((c) => c.name === name).response.body);

describe('group client redaction and failure handling', () => {
	test('a nonmember never receives member_count, private creator fields or a member list role', async () => {
		const { data } = caseBody('groups-detail-outsider');
		data.member_count = 9;
		data.creator.avatar_url = '/api/v1/users/42/avatar';
		data.creator.email = 'alex@example.com';
		const result = await api.fetchGroup(301, okResponse(data));
		expect(result.group.member_count).toBeUndefined();
		expect(result.group.creator).toEqual({ id: 42, display_name: 'Alex Example' });
	});

	test('a member view drops leftover pending entries; teaser members never carry avatars', async () => {
		const detail = caseBody('groups-detail-member').data;
		detail.viewer.invitations = [
			{ id: 601, created_at: 'x', inviter: { id: 7, display_name: 'Ada' } },
		];
		detail.viewer.join_request = { id: 701, created_at: 'x' };
		const group = (await api.fetchGroup(301, okResponse(detail))).group;
		expect(group.viewer).toEqual({
			role: 'member',
			membership_id: 502,
			invitations: [],
			join_request: null,
		});
		const members = caseBody('members-creator');
		members.data[0].avatar_url = '/api/v1/users/7/avatar';
		members.data[0].profile = { email: 'secret' };
		const result = await api.fetchGroupMembers(301, {}, okResponse(members.data, members.meta));
		expect(Object.keys(result.members[0]).sort()).toEqual([
			'access',
			'display_name',
			'id',
			'membership',
			'relationship',
		]);
	});

	test('malformed success bodies, missing pagination and lost responses are unavailable', async () => {
		const list = caseBody('groups-list-creator');
		expect((await api.fetchGroups({}, okResponse(list.data))).status).toBe('unavailable');
		const role = structuredClone(list.data[0]);
		role.viewer.role = 'owner';
		expect((await api.fetchGroups({}, okResponse([role], list.meta))).status).toBe('unavailable');
		const outsiderWithId = structuredClone(list.data[0]);
		outsiderWithId.viewer.membership_id = 501;
		expect((await api.fetchGroups({}, okResponse([outsiderWithId], list.meta))).status).toBe(
			'unavailable',
		);
		const memberWithoutCount = caseBody('groups-detail-member').data;
		delete memberWithoutCount.member_count;
		expect((await api.fetchGroup(301, okResponse(memberWithoutCount))).status).toBe('unavailable');
		const lost = vi.fn(async () => {
			throw new Error('connection lost');
		});
		for (const write of [
			() => api.createGroup({ title: 'a', description: 'b' }, lost),
			() => api.inviteToGroup(301, 8, lost),
			() => api.requestToJoin(301, lost),
			() => api.decideInvitation(601, 'accept', lost),
			() => api.decideJoinRequest(701, 'refuse', lost),
			() => api.removeMembership(502, lost),
		])
			expect((await write()).status).toBe('unavailable');
		const server = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }));
		expect((await api.fetchGroup(301, server)).status).toBe('unavailable');
		expect(lost).toHaveBeenCalledTimes(6);
	});

	test('a created group must name the caller as creator, and invalid filters are never sent', async () => {
		const created = caseBody('group-create').data;
		created.viewer = { role: 'none', membership_id: null, invitations: [], join_request: null };
		delete created.member_count;
		const fetchRef = okResponse(created);
		expect((await api.createGroup({ title: 'a', description: 'b' }, fetchRef)).status).toBe(
			'unavailable',
		);
		const never = vi.fn();
		expect((await api.fetchGroups({ membership: 'owner' }, never)).status).toBe('rejected');
		expect(never).not.toHaveBeenCalled();
	});

	test('group notices keep only public group metadata and drop actions once resolved', async () => {
		const body = caseBody('notices-invitee-pending');
		const notice = body.data.notifications[0];
		notice.target.group.description = 'members-only detail';
		notice.target.excerpt = 'secret';
		notice.target.state = 'cancelled';
		const result = await fetchNotifications({}, okResponse(body.data, body.meta));
		expect(result.notifications[0].target).toEqual({
			kind: 'group_invitation',
			invitation_id: 601,
			group: { id: 301, title: 'Chess Club' },
			state: 'cancelled',
		});
		expect(result.notifications[0].actions).toEqual([]);
		notice.target.state = 'paused';
		expect((await fetchNotifications({}, okResponse(body.data, body.meta))).status).toBe(
			'unavailable',
		);
	});
});
