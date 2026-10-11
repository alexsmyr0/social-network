// The A16 interaction and browser tests run against GroupContentBackend. This
// proves that stand-in follows the approved SN-B17 pack before any UI result
// relies on it: every group-content case, journey step and content race replays
// with exact statuses, bodies, bytes, resulting state and signal recipients.
import { describe, expect, test } from 'vitest';
import { loadGroupFixtures } from '../../../../fixtures/phase4/group-backend.js';
import {
	GroupContentBackend,
	pngBytes,
} from '../../../../fixtures/phase4/group-content-backend.js';

const pack = loadGroupFixtures();
const GROUP_ROUTE =
	/^\/api\/v1\/(groups|group-invitations\/|group-join-requests\/|group-memberships\/|users\/me\/group-invitations)/u;
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
const contentCases = pack.cases.filter((c) => !groupOwned(c));
const PINNED = new Set(['STALE_CONTENT']);
const TABLES = ['posts', 'comments', 'media', 'reactions', 'notifications', 'groups'];

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
	if (response.bytes_fixture) {
		expect(result.headers['Content-Type']).toBe(response.headers['Content-Type']);
		expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
		expect(Buffer.from(result.bytes)).toEqual(Buffer.from(pngBytes()));
		return;
	}
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

// Deep subset: null means the record is absent.
function expectState(backend, expected) {
	if (!expected || expected.unchanged) return;
	const snapshot = backend.snapshot();
	for (const [table, records] of Object.entries(expected)) {
		if (!TABLES.includes(table)) continue;
		for (const [id, record] of Object.entries(records)) {
			if (record === null) expect(snapshot[table][id], `${table}.${id}`).toBeUndefined();
			else expect(snapshot[table][id], `${table}.${id}`).toMatchObject(record);
		}
	}
}

describe('SN-A16 test model conforms to the approved group-content pack', () => {
	test('covers every content-owned case', () => {
		expect(contentCases).toHaveLength(184);
	});

	test.each(contentCases.map((c) => [c.name, c]))('%s', (_name, c) => {
		const backend = new GroupContentBackend({ given: c.given });
		const before = JSON.stringify(backend.snapshot());
		const result = send(backend, c.viewer_id, c.request);
		expectResponse(result, c.response);
		if (
			c.expect_state?.unchanged ||
			c.unchanged ||
			c.response.status >= 400 ||
			c.request.method === 'GET'
		)
			expect(JSON.stringify(backend.snapshot()), 'state must be unchanged').toBe(before);
		expectState(backend, c.expect_state);
		if (c.signals) expect(backend.signals).toEqual(c.signals);
	});

	test.each(pack.sequences.map((s) => [s.name, s]))('journey %s', (_name, sequence) => {
		const backend = new GroupContentBackend({ given: sequence.given });
		for (const step of sequence.steps) {
			backend.signals = [];
			const result = send(backend, step.viewer_id, step.request);
			expectResponse(result, step.response);
			expectState(backend, step.expect_state);
			if (step.signals) expect(backend.signals).toEqual(step.signals);
		}
	});

	const races = pack.races.filter(
		(race) => !Object.values(race.ops).every((op) => GROUP_ROUTE.test(op.request.path)),
	);

	test('covers every content race', () => {
		expect(races).toHaveLength(3);
	});

	test.each(
		races.flatMap((race) => Object.keys(race.outcomes).map((order) => [race.name, order, race])),
	)('race %s in order %s', (_name, order, race) => {
		const backend = new GroupContentBackend({ given: race.given });
		const outcome = race.outcomes[order];
		for (const key of order.split(',')) {
			const op = race.ops[key];
			const result = send(backend, op.viewer, op.request);
			const [status, code] = outcome[key];
			expect(result.status).toBe(status);
			if (code !== null) expect(result.body.error.code).toBe(code);
		}
		expectState(backend, outcome.final);
	});
});
