import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
	bytes,
	expectBytes,
	http,
	image,
	multipart,
	newActor,
	password,
	saveState,
	uuid,
} from './world.js';

// SN-A21 phase 1: build earlier-phase data through the LEGACY backend image
// (last revision before Phase 5, migration 000007). Nothing is written to the
// database directly; every record, notice, session and image byte is made by
// that revision's own HTTP and WebSocket interfaces.
const ROLES = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve', 'Fay'];

async function register(browser, baseURL, role, suffix, { avatar = false } = {}) {
	const actor = await newActor(browser, baseURL, role);
	actor.email = `a21-up-${role.toLowerCase()}-${suffix}@example.com`;
	actor.name = `A21 ${role} ${suffix}`;
	const fields = {
		email: actor.email,
		password,
		first_name: role,
		last_name: 'Upgrade',
		date_of_birth: '1998-03-14',
		nickname: actor.name,
		about_me: `Biography of ${role} ${suffix}`,
	};
	const response = await actor.context.request.post('/api/v1/users/register', {
		multipart: avatar ? { ...fields, avatar: image('avatar.png') } : fields,
	});
	expect(response.status()).toBe(201);
	actor.id = (await response.json()).data.id;
	return actor;
}

// Legacy direct messages exist only on the socket and need a connected recipient.
async function connect(actor) {
	await actor.page.goto('/api/v1/health');
	await actor.page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const socket = new WebSocket(`ws://${location.host}/ws`);
				window.__frames = [];
				window.__socket = socket;
				socket.onmessage = (event) => window.__frames.push(JSON.parse(event.data));
				socket.onopen = () => resolve();
				socket.onerror = () => reject(new Error('socket failed'));
			}),
	);
}
async function legacyDm(sender, recipient, body, imageUrl) {
	const payload = { recipient_id: recipient.id, body };
	if (imageUrl) payload.image_url = imageUrl;
	const frame = await sender.page.evaluate(async (data) => {
		const start = window.__frames.length;
		window.__socket.send(JSON.stringify({ type: 'dm.send', payload: data }));
		for (let tries = 0; tries < 100; tries += 1) {
			const next = window.__frames
				.slice(start)
				.find((entry) => entry.type === 'dm.message' || entry.type === 'chat.error');
			if (next) return next;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return null;
	}, payload);
	expect(frame, `${sender.role} -> ${recipient.role}`).not.toBeNull();
	expect(frame.type, JSON.stringify(frame)).toBe('dm.message');
	return frame.payload;
}
async function stageImage(actor, to) {
	const response = await actor.context.request.post(`/api/v1/chats/${to.id}/images`, {
		multipart: { image: image('dm.png') },
	});
	expect(response.status()).toBe(200);
	return (await response.json()).data.image_url;
}

test('SN-A21 seeds earlier-phase data through the legacy backend image', async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(240000);
	// The image under test really is the legacy revision: Phase 5 routes do not exist.
	const probe = await browser.newContext({ baseURL });
	for (const path of ['/api/v1/group-chats', '/api/v1/chats/unread'])
		expect((await probe.request.get(path)).status(), path).not.toBe(200);
	await probe.close();

	const suffix = uuid().slice(0, 8);
	const actors = {};
	for (const role of ROLES)
		actors[role] = await register(browser, baseURL, role, suffix, { avatar: role === 'Ann' });
	const { Ann, Ben, Cat, Dan, Eve, Fay } = actors;
	try {
		// Profiles and follows: Ben is private, so the follow is a request Ben accepts.
		const profile = (await http(Ben, 'get', `/api/v1/users/${Ben.id}/profile`)).data;
		await http(Ben, 'patch', '/api/v1/users/me/privacy', {
			visibility: 'private',
			expected_version: profile.profile.version,
		});
		const annFollowsBen = (await http(Ann, 'post', '/api/v1/follows', { user_id: Ben.id }, 201))
			.data;
		await http(Ben, 'patch', `/api/v1/follow-requests/${annFollowsBen.id}`, {
			decision: 'accept',
		});
		await http(Cat, 'post', '/api/v1/follows', { user_id: Ann.id }, 201);

		// A group with every membership state, then content in it.
		const group = (
			await http(
				Ann,
				'post',
				'/api/v1/groups',
				{ title: 'Upgrade Club', description: 'Old data' },
				201,
			)
		).data;
		const admit = async (actor) => {
			const request = (
				await http(actor, 'post', `/api/v1/groups/${group.id}/join-requests`, undefined, 201)
			).data;
			await http(Ann, 'patch', `/api/v1/group-join-requests/${request.id}`, { decision: 'accept' });
		};
		await admit(Ben);
		await admit(Dan);
		const invitation = (
			await http(Ann, 'post', `/api/v1/groups/${group.id}/invitations`, { user_id: Cat.id }, 201)
		).data;
		await http(Cat, 'patch', `/api/v1/group-invitations/${invitation.id}`, { decision: 'accept' });
		// Dan is removed: a departed generation. Eve keeps a pending invitation, Fay a pending request.
		const danMembership = (await http(Dan, 'get', `/api/v1/groups/${group.id}`)).data.viewer
			.membership_id;
		await http(Ann, 'delete', `/api/v1/group-memberships/${danMembership}`, undefined, 204);
		await http(Ann, 'post', `/api/v1/groups/${group.id}/invitations`, { user_id: Eve.id }, 201);
		await http(Fay, 'post', `/api/v1/groups/${group.id}/join-requests`, undefined, 201);

		// Posts and images: personal with image, group with image, comments with image,
		// a draft, a reaction.
		const personal = await multipart(Ann, '/api/v1/posts', {
			title: 'Upgrade post',
			body: 'Personal body',
			category_ids: '1',
			image: image('post.png'),
		});
		const grouped = await multipart(Ben, '/api/v1/posts', {
			body: 'Group body',
			group_id: String(group.id),
			image: image('post.png'),
		});
		const comment = await multipart(Cat, `/api/v1/posts/${grouped.id}/comments`, {
			body: 'Image comment',
			image: image('comment.png'),
		});
		const draft = (
			await http(
				Ben,
				'post',
				'/api/v1/posts',
				{ body: 'Draft body', group_id: group.id, status: 'draft' },
				201,
			)
		).data;
		await http(Cat, 'post', `/api/v1/posts/${personal.id}/dislike`);

		// Legacy private messages: the socket is the only way to send, and the recipient
		// must be connected. Cat follows Ann; Eve has no relationship with Ann at all.
		for (const actor of [Ann, Cat, Eve]) await connect(actor);
		const dmImage = await stageImage(Ann, Cat);
		const history = {
			annCat: [
				await legacyDm(Cat, Ann, 'Legacy hello'),
				await legacyDm(Ann, Cat, 'Legacy reply with image', dmImage),
				await legacyDm(Cat, Ann, 'Legacy last'),
			],
			eveAnn: [await legacyDm(Eve, Ann, 'Stranger legacy', await stageImage(Eve, Ann))],
		};
		// A staged image that was never sent stays with its uploader.
		const staged = await stageImage(Ann, Cat);

		// A revoked session stays revoked after the upgrade.
		const revoked = (await Fay.context.storageState()).cookies;
		await http(Fay, 'post', '/api/v1/users/logout', undefined, 200);
		expect((await Fay.context.request.get('/api/v1/users/me')).status()).toBe(401);

		// Read state: Ann reads one notice; the others stay unread.
		const annNotices = (await http(Ann, 'get', '/api/v1/notifications?per_page=50')).data;
		expect(annNotices.notifications.length).toBeGreaterThan(1);
		await http(
			Ann,
			'patch',
			`/api/v1/notifications/${annNotices.notifications[0].id}/read`,
			undefined,
			204,
		);

		// Snapshots of everything the verifier must find unchanged.
		const reads = {
			Ann: [
				'/api/v1/notifications?per_page=50',
				`/api/v1/groups/${group.id}`,
				`/api/v1/groups/${group.id}/members?per_page=50`,
				'/api/v1/posts?per_page=50',
				`/api/v1/posts/${personal.id}`,
				`/api/v1/posts/${grouped.id}`,
				`/api/v1/posts/${grouped.id}/comments`,
				`/api/v1/users/${Ann.id}/profile`,
				`/api/v1/users/${Ben.id}/profile`,
			],
			Ben: [
				'/api/v1/notifications?per_page=50',
				`/api/v1/groups/${group.id}`,
				`/api/v1/posts/${draft.id}`,
				'/api/v1/posts?per_page=50',
			],
			Cat: [`/api/v1/groups/${group.id}`, '/api/v1/notifications?per_page=50'],
			Dan: [`/api/v1/groups/${group.id}`],
			Eve: ['/api/v1/users/me/group-invitations', `/api/v1/groups/${group.id}`],
			Fay: [`/api/v1/groups/${group.id}`],
		};
		const snapshots = {};
		for (const [role, paths] of Object.entries(reads)) {
			snapshots[role] = {};
			for (const path of paths) {
				const response = await actors[role].context.request.get(path);
				snapshots[role][path] = { status: response.status(), body: await response.json() };
			}
		}
		// Image access before the upgrade, so any change is a regression.
		const access = {};
		for (const [label, url] of Object.entries({
			post: personal.image_url,
			groupPost: grouped.image_url,
			comment: comment.image_url,
			dm: dmImage,
			staged,
		}))
			for (const role of ROLES)
				access[`${label}:${role}`] = (await actors[role].context.request.get(url)).status();
		expect(access['dm:Cat']).toBe(200);
		expect(access['dm:Eve']).toBe(404);
		expect(access['staged:Ann']).toBe(200);
		expect(access['staged:Cat']).toBe(404);

		const avatar = await bytes(Ann, `/api/v1/users/${Ann.id}/avatar`);
		expect(avatar.status).toBe(200);

		const storage = {};
		for (const role of ROLES)
			if (role !== 'Fay') storage[role] = await actors[role].context.storageState();
		saveState({
			revision: process.env.A21_LEGACY_REV,
			suffix,
			accounts: Object.fromEntries(
				ROLES.map((role) => [
					role,
					{ id: actors[role].id, email: actors[role].email, name: actors[role].name },
				]),
			),
			storage,
			revoked,
			avatarHash: createHash('sha256').update(avatar.body).digest('hex'),
			group,
			personal,
			grouped,
			comment,
			draft,
			dmImage,
			staged,
			history,
			snapshots,
			access,
		});
		await expectBytes(Cat, dmImage, true);
	} finally {
		await Promise.all(Object.values(actors).map((actor) => actor.context.close()));
	}
});
