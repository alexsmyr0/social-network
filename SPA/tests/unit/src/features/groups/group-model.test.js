// The A15 interaction and browser tests run against GroupBackend. This proves
// that stand-in follows the approved SN-B17 pack before any UI result relies
// on it: every group/membership/notice case, journey and group race replays
// with exact statuses, bodies, resulting state and signal recipients.
import { describe, expect, test } from 'vitest';

import { GroupBackend, loadGroupFixtures } from '../../../../fixtures/phase4/group-backend.js';

const pack = loadGroupFixtures();
const GROUP_ROUTE =
	/^\/api\/v1\/(groups|group-invitations\/|group-join-requests\/|group-memberships\/|users\/me\/group-invitations)/u;
// Notice cases that depend only on group notices (content notices need B19).
const GROUP_NOTICE_CASES = new Set([
	'notices-invitee-pending',
	'notices-creator-pending-request',
	'notices-invitee-resolved-states',
	'notices-creator-resolved-states',
	'notice-read-one-keeps-actions',
	'notice-read-all-keeps-pending-request',
	'notice-foreign-read',
]);
const groupOwned = (c) => GROUP_ROUTE.test(c.request.path) || GROUP_NOTICE_CASES.has(c.name);
// Origin, content-type and raw-encoding checks are server transport rules the
// browser and client never exercise; the client replay covers their outcomes.
const transportOnly = (c) =>
	c.request.encoding || c.request.raw_body !== undefined || c.request.headers?.Origin;
const PINNED = new Set([
	'STALE_INVITATION',
	'STALE_JOIN_REQUEST',
	'STALE_MEMBERSHIP',
	'ALREADY_MEMBER',
	'CREATOR_CANNOT_LEAVE',
]);
const TABLES = {
	groups: 'groups',
	group_memberships: 'group_memberships',
	group_invitations: 'group_invitations',
	group_join_requests: 'group_join_requests',
	notifications: 'notifications',
};

const ownedCases = pack.cases.filter(groupOwned);

function send(backend, viewer, request) {
	const missingHeader = request.headers && request.headers['X-Requested-With'] === null;
	return backend.request(viewer ?? null, request.method, request.path, {
		json: request.body,
		headers: { 'X-Requested-With': missingHeader ? undefined : 'XMLHttpRequest' },
	});
}

function expectResponse(result, response) {
	expect(result.status).toBe(response.status);
	if (response.headers?.['Cache-Control']) expect(result.headers['Cache-Control']).toBe('no-store');
	const body = response.body;
	if (body === undefined || body === null) {
		if (response.status === 204) expect(result.body).toBeNull();
		return;
	}
	if (body.error) {
		expect(result.body.error.code).toBe(body.error.code);
		expect(result.body.error.fields).toEqual(body.error.fields);
		if (PINNED.has(body.error.code)) expect(result.body.error.message).toBe(body.error.message);
		return;
	}
	expect(result.body).toEqual(body);
}

// Deep subset: null means the record is absent. Content tables belong to B19.
function expectState(backend, expected) {
	if (!expected || expected.unchanged) return;
	const snapshot = backend.snapshot();
	for (const [table, records] of Object.entries(expected)) {
		if (!TABLES[table]) continue;
		for (const [id, record] of Object.entries(records)) {
			if (record === null) expect(snapshot[table][id], `${table}.${id}`).toBeUndefined();
			else expect(snapshot[table][id], `${table}.${id}`).toMatchObject(record);
		}
	}
}

describe('SN-A15 test model conforms to the approved group pack', () => {
	const replayed = ownedCases.filter((c) => !transportOnly(c));

	test('replays every expressible group-owned case', () => {
		expect(ownedCases.length).toBe(205);
		expect(replayed.length).toBe(195);
	});

	test.each(replayed.map((c) => [c.name, c]))('%s', (_name, c) => {
		const backend = new GroupBackend({ given: c.given });
		const before = JSON.stringify(backend.snapshot());
		const result = send(backend, c.viewer_id, c.request);
		expectResponse(result, c.response);
		if (c.expect_state?.unchanged || c.response.status >= 400 || c.request.method === 'GET')
			expect(JSON.stringify(backend.snapshot())).toBe(before);
		expectState(backend, c.expect_state);
		if (c.signals) expect(backend.signals).toEqual(c.signals);
	});

	test.each(pack.sequences.map((s) => [s.name, s]))('journey %s', (_name, sequence) => {
		const backend = new GroupBackend({ given: sequence.given });
		let checked = 0;
		for (const step of sequence.steps) {
			if (!GROUP_ROUTE.test(step.request.path) && !step.request.path.includes('/notifications'))
				continue;
			backend.signals = [];
			const result = send(backend, step.viewer_id, step.request);
			expectResponse(result, step.response);
			expectState(backend, step.expect_state);
			if (step.signals) expect(backend.signals).toEqual(step.signals);
			checked += 1;
		}
		expect(checked).toBeGreaterThan(0);
	});

	const groupRaces = pack.races.filter((race) =>
		Object.values(race.ops).every((op) => GROUP_ROUTE.test(op.request.path)),
	);

	test('covers every group-only race', () => {
		expect(groupRaces.length).toBe(9);
	});

	test.each(
		groupRaces.flatMap((race) =>
			Object.keys(race.outcomes).map((order) => [race.name, order, race]),
		),
	)('race %s in order %s', (_name, order, race) => {
		const backend = new GroupBackend({ given: race.given });
		const outcome = race.outcomes[order];
		for (const key of order.split(',')) {
			const op = race.ops[key];
			const result = send(backend, op.viewer, op.request);
			const [status, code] = outcome[key];
			expect(result.status).toBe(status);
			// A null code pins only the status (success, or an uncoded denial).
			if (code !== null) expect(result.body.error.code).toBe(code);
		}
		expectState(backend, outcome.final);
	});
});
