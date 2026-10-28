import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { recreate } from '../e2e/support/real-service.js';
import { bytes, expectBytes, http, loadState, newActor, password, png, uuid } from './world.js';

// SN-A21 phase 2: the CURRENT backend and frontend images now run on the volume
// the legacy image wrote. Everything made before the upgrade must be intact and
// permissions unchanged, and the Phase 5 features must work on that data.
const dm = (other, tail = 'messages') => `/api/v1/chats/${other.id}/${tail}`;
const messageFields = (m) => ({
	id: m.id,
	sender_id: m.sender_id,
	recipient_id: m.recipient_id,
	body: m.body,
	created_at: m.created_at,
	image_url: m.image_url,
});
const notices = async (actor) =>
	(await http(actor, 'get', '/api/v1/notifications?per_page=50')).data.notifications;
const roster = async (actor, other) =>
	(await http(actor, 'get', '/api/v1/chats?per_page=50')).data.find(
		(row) => row.user_id === other.id,
	);
const membership = async (actor, group) =>
	(await http(actor, 'get', `/api/v1/groups/${group.id}`)).data.viewer.membership_id;

async function connectActors(browser, baseURL, state) {
	const actors = {};
	for (const [role, account] of Object.entries(state.accounts)) {
		const storageState =
			role === 'Fay' ? { cookies: state.revoked, origins: [] } : state.storage[role];
		actors[role] = Object.assign(await newActor(browser, baseURL, role, { storageState }), account);
	}
	return actors;
}

async function checkSessions(browser, baseURL, actors) {
	const { Fay } = actors;
	for (const path of ['/api/v1/group-chats', '/api/v1/chats/unread', '/api/v1/group-chats/unread'])
		await http(actors.Ann, 'get', path, undefined, 200);
	for (const role of ['Ann', 'Ben', 'Cat', 'Dan', 'Eve'])
		expect((await http(actors[role], 'get', '/api/v1/users/me')).data.id, role).toBe(
			actors[role].id,
		);
	await http(Fay, 'get', '/api/v1/users/me', undefined, 401);
	// A fresh sign-in works with the credentials registered before the upgrade.
	const fay = await newActor(browser, baseURL, 'Fay');
	await http(fay, 'post', '/api/v1/users/login', { email: Fay.email, password });
	return Object.assign(fay, { id: Fay.id });
}

async function checkRecords(actors, state) {
	// Records, notices with their read flags, groups in every membership state,
	// drafts, feeds and profiles read exactly as they did before.
	let compared = 0;
	for (const [role, reads] of Object.entries(state.snapshots))
		for (const [path, before] of Object.entries(reads)) {
			const response = await actors[role].context.request.get(path);
			expect(response.status(), `${role} ${path}`).toBe(before.status);
			expect(await response.json(), `${role} ${path}`).toEqual(before.body);
			compared += 1;
		}
	expect(compared).toBeGreaterThanOrEqual(19);
}

async function checkMedia(actors, state) {
	const urls = {
		post: state.personal.image_url,
		groupPost: state.grouped.image_url,
		comment: state.comment.image_url,
		dm: state.dmImage,
		staged: state.staged,
	};
	for (const [key, status] of Object.entries(state.access)) {
		const [label, role] = key.split(':');
		const result = await bytes(actors[role], urls[label]);
		expect(result.status, key).toBe(status);
		if (status === 200) expect(result.body, key).toEqual(png);
	}
	const avatar = await bytes(actors.Ann, `/api/v1/users/${actors.Ann.id}/avatar`);
	expect(avatar.status).toBe(200);
	expect(createHash('sha256').update(avatar.body).digest('hex')).toBe(state.avatarHash);
}

async function legacyWorld(actors, state) {
	const out = {};
	for (const [role, other] of [
		['Ann', 'Cat'],
		['Cat', 'Ann'],
		['Ann', 'Eve'],
		['Eve', 'Ann'],
	])
		out[`${role}:${other}`] = (
			await http(actors[role], 'get', `${dm(state.accounts[other])}?limit=50`)
		).data.messages.map(messageFields);
	return out;
}

async function checkLegacyMessages(actors, state) {
	const { Ann, Cat, Dan, Eve } = actors;
	const legacy = await legacyWorld(actors, state);
	// Same IDs, bodies, times and images; no nonce; nothing counted unread.
	expect(legacy['Ann:Cat']).toEqual(state.history.annCat.map(messageFields));
	expect(legacy['Cat:Ann']).toEqual(legacy['Ann:Cat']);
	expect(legacy['Ann:Eve']).toEqual(state.history.eveAnn.map(messageFields));
	expect(legacy['Eve:Ann']).toEqual(legacy['Ann:Eve']);
	for (const message of (await http(Ann, 'get', `${dm(Cat)}?limit=50`)).data.messages)
		expect(message.client_id).toBeNull();
	for (const role of ['Ann', 'Cat', 'Eve'])
		expect((await http(actors[role], 'get', '/api/v1/chats/unread')).data.unread_count, role).toBe(
			0,
		);
	// Cat follows Ann, so that pair still messages; Eve has no relationship, so hers is read-only.
	expect((await roster(Ann, Cat)).can_send).toBe(true);
	expect(await roster(Ann, Eve)).toMatchObject({ can_send: false, unread_count: 0 });
	await http(Eve, 'post', dm(Ann), { client_id: uuid(), body: 'blocked now' }, 404);
	await http(Dan, 'get', dm(Ann), undefined, 404);
	await http(Dan, 'get', dm(Cat), undefined, 404);
	// The staged, unsent image still belongs to its uploader and can be sent with a nonce.
	const sent = (
		await http(Ann, 'post', dm(Cat), { client_id: uuid(), body: '', image_url: state.staged }, 201)
	).data;
	await expectBytes(Cat, sent.image_url, true);
	await expectBytes(Dan, sent.image_url, false);
}

async function checkEvents(actors, group, fay) {
	const { Ann, Ben, Cat, Dan, Eve } = actors;
	const event = (
		await http(
			Ann,
			'post',
			`/api/v1/groups/${group.id}/events`,
			{
				membership_id: await membership(Ann, group),
				title: 'After the upgrade',
				description: 'Old group, new feature',
				starts_at: '2099-11-05T19:30:00Z',
			},
			201,
		)
	).data;
	const received = async (actor) =>
		(await notices(actor)).filter(
			(n) => n.target.kind === 'group_event' && n.target.event_id === event.id,
		);
	// Exactly the members who were in the group before the upgrade.
	expect(await received(Ben)).toHaveLength(1);
	expect(await received(Cat)).toHaveLength(1);
	for (const actor of [Ann, Dan, Eve, fay]) expect(await received(actor)).toHaveLength(0);
	await http(
		Ben,
		'put',
		`/api/v1/groups/${group.id}/events/${event.id}/response`,
		{ membership_id: await membership(Ben, group), choice: 'going', expected_version: 0 },
		200,
	);
	for (const actor of [Dan, Eve, fay])
		await http(actor, 'get', `/api/v1/groups/${group.id}/events/${event.id}`, undefined, 404);
	return received;
}

async function checkRoom(actors, group, fay) {
	const { Ann, Ben, Cat, Dan, Eve } = actors;
	// The room exists for the old members, empty, with cursors at the start.
	for (const actor of [Ann, Ben, Cat]) {
		const summary = (await http(actor, 'get', '/api/v1/group-chats')).data.find(
			(row) => row.group.id === group.id,
		);
		expect(summary).toMatchObject({
			membership_id: await membership(actor, group),
			last_message: null,
			read_through_id: 0,
			unread_count: 0,
		});
	}
	const hello = (
		await http(
			Ben,
			'post',
			`/api/v1/groups/${group.id}/messages`,
			{
				membership_id: await membership(Ben, group),
				client_id: uuid(),
				body: 'First message in an old group',
			},
			201,
		)
	).data;
	expect((await http(Ann, 'get', '/api/v1/group-chats/unread')).data.unread_count).toBe(1);
	for (const actor of [Dan, Eve, fay])
		await http(actor, 'get', `/api/v1/groups/${group.id}/messages`, undefined, 404);
	return hello;
}

async function checkPendingEntries(actors, group, fay, hello, received) {
	const { Ann, Dan, Eve } = actors;
	// The invitation and the request that were pending before the upgrade still resolve.
	const invitation = (await http(Eve, 'get', '/api/v1/users/me/group-invitations')).data[0];
	await http(Eve, 'patch', `/api/v1/group-invitations/${invitation.id}`, { decision: 'accept' });
	const request = (await http(Ann, 'get', `/api/v1/groups/${group.id}/join-requests`)).data[0];
	expect(request.requester.id).toBe(fay.id);
	await http(Ann, 'patch', `/api/v1/group-join-requests/${request.id}`, { decision: 'accept' });
	// New members read the whole room with nothing unread, and get no old event notice.
	for (const actor of [Eve, fay]) {
		const room = (await http(actor, 'get', `/api/v1/groups/${group.id}/messages?limit=50`)).data;
		expect(room.messages.map((m) => m.id)).toEqual([hello.id]);
		expect((await http(actor, 'get', '/api/v1/group-chats')).data[0]).toMatchObject({
			read_through_id: hello.id,
			unread_count: 0,
		});
		expect(await received(actor)).toHaveLength(0);
	}
	// Dan, removed before the upgrade, is still out.
	await http(Dan, 'get', `/api/v1/groups/${group.id}/messages`, undefined, 404);
}

async function phase5(actors, group) {
	const out = { rooms: {}, history: {}, events: {} };
	for (const role of ['Ann', 'Ben', 'Cat', 'Eve']) {
		const actor = actors[role];
		out.rooms[role] = (await http(actor, 'get', '/api/v1/group-chats?per_page=50')).data;
		out.history[role] = (
			await http(actor, 'get', `/api/v1/groups/${group.id}/messages?limit=50`)
		).data;
		out.events[role] = (
			await http(actor, 'get', `/api/v1/groups/${group.id}/events?per_page=50`)
		).data;
	}
	return out;
}

test('SN-A21 earlier-phase data, permissions and media survive the upgrade; Phase 5 runs on it', async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(300000);
	const state = loadState();
	const actors = await connectActors(browser, baseURL, state);
	const group = state.group;
	try {
		const fay = await checkSessions(browser, baseURL, actors);
		await checkRecords(actors, state);
		await checkMedia(actors, state);
		await checkLegacyMessages(actors, state);
		const received = await checkEvents(actors, group, fay);
		const hello = await checkRoom(actors, group, fay);
		await checkPendingEntries(actors, group, fay, hello, received);

		// Starting again is a no-op: recreate both containers and compare everything.
		const before = { world: await phase5(actors, group), legacy: await legacyWorld(actors, state) };
		recreate();
		expect(await phase5(actors, group)).toEqual(before.world);
		expect(await legacyWorld(actors, state)).toEqual(before.legacy);
		await expectBytes(actors.Cat, state.dmImage, true);
		await expectBytes(actors.Dan, state.dmImage, false);
		await fay.context.close();
	} finally {
		await Promise.all(Object.values(actors).map((actor) => actor.context.close()));
	}
});
