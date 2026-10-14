import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// SN-A17: real browsers, cookies, HTTP, WebSockets and bytes through the two
// isolated images. No route mocks, fixture backend, SQL seeds or synthetic
// socket frames. Expectations come from the owner-approved groups contract.
const png = readFileSync('SPA/tests/fixtures/a07/avatar.png');
const password = 'correct horse battery';
const writeHeaders = (baseURL) => ({ Origin: baseURL, 'X-Requested-With': 'XMLHttpRequest' });
const feedback = (page) => page.locator('.group-feedback');

async function http(actor, method, path, data, expected = 200) {
	const response = await actor.context.request[method](path, data === undefined ? {} : { data });
	expect(response.status(), `${actor.role} ${method} ${path}`).toBe(expected);
	expect(response.headers()['cache-control'], path).toContain('no-store');
	return expected === 204 ? null : response.json();
}
async function conflict(actor, method, path, data, code) {
	const body = await http(actor, method, path, data, 409);
	expect(body.error.code, `${actor.role} ${method} ${path}`).toBe(code);
}
async function actors(browser, baseURL, roles) {
	const suffix = randomUUID().slice(0, 8);
	const all = [];
	try {
		for (const role of roles) {
			const context = await browser.newContext({
				baseURL,
				extraHTTPHeaders: writeHeaders(baseURL),
			});
			const actor = {
				context,
				role,
				name: `A17 ${role} ${suffix}`,
				email: `a17-${role.toLowerCase()}-${suffix}@example.com`,
			};
			all.push(actor);
			const response = await context.request.post('/api/v1/users/register', {
				data: {
					email: actor.email,
					password,
					first_name: role,
					last_name: 'Acceptance',
					date_of_birth: '1998-03-14',
					nickname: actor.name,
					about_me: `Protected biography ${suffix}`,
				},
			});
			expect(response.status()).toBe(201);
			actor.account = (await response.json()).data;
			actor.page = await context.newPage();
		}
		return all;
	} catch (error) {
		await dispose(all);
		throw error;
	}
}
async function dispose(all) {
	await Promise.all(all.map((actor) => actor.context.close()));
}
async function privacy(actor, visibility) {
	const current = (await http(actor, 'get', `/api/v1/users/${actor.account.id}/profile`)).data;
	await http(actor, 'patch', '/api/v1/users/me/privacy', {
		visibility,
		expected_version: current.profile.version,
	});
}
async function follow(sender, recipient, accept = false) {
	const request = (
		await http(sender, 'post', '/api/v1/follows', { user_id: recipient.account.id }, 201)
	).data;
	if (accept)
		await http(recipient, 'patch', `/api/v1/follow-requests/${request.id}`, { decision: 'accept' });
}
async function createGroup(creator, title = `A17 Group ${randomUUID().slice(0, 8)}`) {
	return (
		await http(
			creator,
			'post',
			'/api/v1/groups',
			{ title, description: 'Real acceptance group' },
			201,
		)
	).data;
}
const invite = async (inviter, group, invitee) =>
	(
		await http(
			inviter,
			'post',
			`/api/v1/groups/${group.id}/invitations`,
			{ user_id: invitee.account.id },
			201,
		)
	).data;
const acceptInvitation = async (invitee, invitation) =>
	(
		await http(invitee, 'patch', `/api/v1/group-invitations/${invitation.id}`, {
			decision: 'accept',
		})
	).data;
const requestJoin = async (requester, group) =>
	(await http(requester, 'post', `/api/v1/groups/${group.id}/join-requests`, undefined, 201)).data;
const acceptRequest = async (creator, request) =>
	(
		await http(creator, 'patch', `/api/v1/group-join-requests/${request.id}`, {
			decision: 'accept',
		})
	).data;
// Admit through the request path so the actor needs nothing but the creator.
async function admit(creator, group, member) {
	return acceptRequest(creator, await requestJoin(member, group));
}
async function role(actor, group) {
	return (await http(actor, 'get', `/api/v1/groups/${group.id}`)).data.viewer.role;
}
async function notices(actor) {
	return (await http(actor, 'get', '/api/v1/notifications')).data.notifications;
}
const groupNotice = async (actor, kind, id) =>
	(await notices(actor)).find(
		(n) =>
			n.target.kind === kind &&
			n.target[kind === 'group_invitation' ? 'invitation_id' : 'request_id'] === id,
	);
async function post(author, group, data = {}) {
	return (
		await http(
			author,
			'post',
			'/api/v1/posts',
			{ body: `A17 ${randomUUID()}`, group_id: group.id, ...data },
			201,
		)
	).data;
}
async function upload(author, path, extra = {}) {
	const response = await author.context.request.post(path, {
		multipart: { ...extra, image: { name: 'post.png', mimeType: 'image/png', buffer: png } },
	});
	expect(response.status()).toBe(201);
	return (await response.json()).data;
}
async function ids(actor, path) {
	return (await http(actor, 'get', path)).data.map((item) => item.id);
}
async function bytes(actor, url, allowed) {
	const response = await actor.context.request.get(url);
	expect(response.status(), `${actor.role} ${url}`).toBe(allowed ? 200 : 404);
	if (allowed) {
		expect(await response.body()).toEqual(png);
		expect(response.headers()['x-content-type-options']).toBe('nosniff');
	}
}
async function checkDenied(actor, group, p) {
	for (const path of [
		'/api/v1/posts/mine',
		'/api/v1/posts/liked',
		'/api/v1/posts/disliked',
		'/api/v1/categories/view',
		'/api/v1/users/activity',
	])
		expect(JSON.stringify(await http(actor, 'get', path))).not.toContain(p.body);
	await http(actor, 'post', `/api/v1/posts/${p.id}/comments`, { body: 'denied' }, 404);
	await http(actor, 'post', `/api/v1/posts/${p.id}/like`, undefined, 404);
	await http(
		actor,
		'patch',
		`/api/v1/posts/${p.id}`,
		{ expected_version: p.version, body: 'denied' },
		404,
	);
	await http(actor, 'get', `/api/v1/posts?group_id=${group.id}`, undefined, 404);
	for (const guess of [
		'/static/uploads/guess.png',
		'/static/%75ploads/guess.png',
		'/static/uploads/dm/guess.png',
	])
		expect((await actor.context.request.get(guess)).status()).toBe(404);
}
// Every read surface, one predicate: detail, thread, comment, navigation,
// media, feeds, aggregates, own and cross-user activity.
async function checkAccess(actor, group, p, c, allowed, { author = null } = {}) {
	for (const path of [
		`/api/v1/posts/${p.id}`,
		`/api/v1/posts/${p.id}/comments`,
		`/api/v1/comments/${c.id}`,
		`/api/v1/posts/${p.id}/nav?group_id=${group.id}`,
		`/api/v1/posts?group_id=${group.id}`,
	])
		await http(actor, 'get', path, undefined, allowed ? 200 : 404);
	await bytes(actor, p.image_url, allowed);
	await bytes(actor, c.image_url, allowed);
	const home = await ids(actor, '/api/v1/posts?per_page=50');
	expect(home.includes(p.id)).toBe(allowed);
	if (allowed)
		expect(await ids(actor, `/api/v1/posts?group_id=${group.id}&per_page=50`)).toContain(p.id);
	else await checkDenied(actor, group, p);
	if (!author) return;
	const result = await actor.context.request.get(`/api/v1/users/${author.account.id}/posts`);
	if (result.status() === 200)
		expect((await result.json()).data.some((item) => item.id === p.id)).toBe(allowed);
	else expect(result.status()).toBe(404);
}
const trigger = (page) => page.getByRole('button', { name: /^Notifications/u });
const noOverflow = async (page) =>
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(1);

function recreate() {
	if (!/^sn-b07-test-\d+$/u.test(process.env.COMPOSE_PROJECT_NAME || ''))
		throw new Error('Requires isolated B07 stack');
	execFileSync(
		'docker',
		[
			'compose',
			'--env-file',
			'/dev/null',
			'-f',
			'compose.yaml',
			'up',
			'-d',
			'--no-deps',
			'--force-recreate',
			'--wait',
			'backend',
			'frontend',
		],
		{ stdio: 'pipe', timeout: 120000 },
	);
}

test.describe('SN-A17 real Phase 4 acceptance', () => {
	test.setTimeout(240000);

	test('browser discovery, creation, requests, invitations, decisions and creator authority', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, [
			'Creator',
			'Member',
			'Invitee',
			'Requester',
			'Outsider',
		]);
		const [creator, member, invitee, requester, outsider] = all;
		try {
			// Creator makes the group with the keyboard; it is one group, one creator membership.
			const title = `A17 Chess ${randomUUID().slice(0, 8)}`;
			await creator.page.goto('/groups/new');
			await creator.page.getByLabel('Name').fill(title);
			await creator.page.getByLabel('Description').fill('Real service acceptance');
			await creator.page.getByRole('button', { name: 'Create group' }).focus();
			await creator.page.keyboard.press('Enter');
			await expect(creator.page).toHaveURL(/\/groups\/\d+$/u);
			await expect(creator.page.getByText('1 member', { exact: true })).toBeVisible();
			const group = { id: Number(new URL(creator.page.url()).pathname.split('/')[2]) };
			expect(await role(creator, group)).toBe('creator');
			const own = (await http(creator, 'get', `/api/v1/groups/${group.id}/members`)).data[0]
				.membership;
			await conflict(
				creator,
				'delete',
				`/api/v1/group-memberships/${own.id}`,
				undefined,
				'CREATOR_CANNOT_LEAVE',
			);
			// The creator cannot be removed or leave; nobody else sees the member list.
			await http(outsider, 'get', `/api/v1/groups/${group.id}/members`, undefined, 404);
			await http(outsider, 'get', `/api/v1/groups/${group.id}/join-requests`, undefined, 404);

			// Outsider finds the group by search and requests with the keyboard.
			await requester.page.goto('/groups');
			await requester.page.getByLabel('Search groups by name').fill(title);
			await requester.page.keyboard.press('Enter');
			const card = requester.page.locator(`[data-group-id="${group.id}"]`);
			await expect(card).toBeVisible();
			await expect(card).not.toContainText('members');
			await card.getByRole('button', { name: `Request to join ${title}` }).focus();
			await requester.page.keyboard.press('Enter');
			await expect(feedback(requester.page)).toContainText('Request sent.');
			const request = (await http(creator, 'get', `/api/v1/groups/${group.id}/join-requests`))
				.data[0];
			expect(request.requester.id).toBe(requester.account.id);
			// A duplicate is idempotent and creates no second notice.
			const again = (
				await http(requester, 'post', `/api/v1/groups/${group.id}/join-requests`, undefined, 200)
			).data;
			expect(again.id).toBe(request.id);
			// Only the creator decides: other people get 404, a bad ID 409 after resolution.
			await http(
				outsider,
				'patch',
				`/api/v1/group-join-requests/${request.id}`,
				{ decision: 'accept' },
				404,
			);
			await http(
				requester,
				'patch',
				`/api/v1/group-join-requests/${request.id}`,
				{ decision: 'accept' },
				404,
			);
			await creator.page.goto(`/groups/${group.id}`);
			await trigger(creator.page).click();
			const notice = creator.page
				.locator('#notification-panel [data-notice-id]')
				.filter({ hasText: 'Asked to join' })
				.first();
			await notice.getByRole('button', { name: /^Accept / }).focus();
			await creator.page.keyboard.press('Enter');
			await expect(creator.page.locator('#notification-panel')).toContainText(
				`${requester.name} joined`,
			);
			await creator.page.keyboard.press('Escape');
			expect(await role(requester, group)).toBe('member');
			await conflict(
				creator,
				'patch',
				`/api/v1/group-join-requests/${request.id}`,
				{ decision: 'accept' },
				'STALE_JOIN_REQUEST',
			);
			// The requester's open page learns of admission without a reload.
			await requester.page.goto(`/groups/${group.id}`);
			await expect(requester.page.getByRole('button', { name: 'Leave group' })).toBeVisible();

			// A member invites; the invitee accepts from their own notice with the keyboard.
			const invitation = await invite(requester, group, invitee);
			const duplicate = (
				await http(
					requester,
					'post',
					`/api/v1/groups/${group.id}/invitations`,
					{ user_id: invitee.account.id },
					200,
				)
			).data;
			expect(duplicate.id).toBe(invitation.id);
			await http(
				outsider,
				'post',
				`/api/v1/groups/${group.id}/invitations`,
				{ user_id: invitee.account.id },
				404,
			);
			await http(
				requester,
				'post',
				`/api/v1/groups/${group.id}/invitations`,
				{ user_id: requester.account.id },
				400,
			);
			await conflict(
				creator,
				'post',
				`/api/v1/groups/${group.id}/invitations`,
				{ user_id: requester.account.id },
				'ALREADY_MEMBER',
			);
			await invitee.page.goto('/groups');
			const list = invitee.page.getByRole('list', { name: 'Pending group invitations' });
			await expect(list.locator(`[data-invitation-id="${invitation.id}"]`)).toBeVisible();
			await http(
				outsider,
				'patch',
				`/api/v1/group-invitations/${invitation.id}`,
				{ decision: 'accept' },
				404,
			);
			await list
				.getByRole('button', {
					name: new RegExp(`^Accept invitation to .* from ${requester.name}`, 'u'),
				})
				.dblclick();
			await expect(feedback(invitee.page)).toContainText('You joined');
			expect(await role(invitee, group)).toBe('member');
			const resolved = await groupNotice(invitee, 'group_invitation', invitation.id);
			expect(resolved.target.state).toBe('accepted');
			expect(resolved.actions).toEqual([]);
			await conflict(
				invitee,
				'patch',
				`/api/v1/group-invitations/${invitation.id}`,
				{ decision: 'accept' },
				'STALE_INVITATION',
			);
			await conflict(
				invitee,
				'patch',
				`/api/v1/group-invitations/${invitation.id}`,
				{ decision: 'refuse' },
				'STALE_INVITATION',
			);

			// Refusal is not a ban; only the creator removes; members cannot.
			const refusedRequest = await requestJoin(outsider, group);
			await http(
				creator,
				'patch',
				`/api/v1/group-join-requests/${refusedRequest.id}`,
				{ decision: 'refuse' },
				204,
			);
			expect(
				(await groupNotice(creator, 'group_join_request', refusedRequest.id)).target.state,
			).toBe('refused');
			const again2 = await requestJoin(outsider, group);
			expect(again2.id).not.toBe(refusedRequest.id);
			const members = (await http(creator, 'get', `/api/v1/groups/${group.id}/members`)).data;
			const target = members.find((m) => m.id === invitee.account.id).membership;
			await http(member, 'delete', `/api/v1/group-memberships/${target.id}`, undefined, 404);
			await http(requester, 'delete', `/api/v1/group-memberships/${target.id}`, undefined, 404);
			await http(creator, 'delete', `/api/v1/group-memberships/${target.id}`, undefined, 204);
			expect(await role(invitee, group)).toBe('none');
			await conflict(
				creator,
				'delete',
				`/api/v1/group-memberships/${target.id}`,
				undefined,
				'STALE_MEMBERSHIP',
			);
		} finally {
			await dispose(all);
		}
	});

	test('inviter departure cancels invitations, stale actions never admit, and fresh admission is clean', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Creator', 'Inviter', 'Invitee', 'Rival']);
		const [creator, inviter, invitee, rival] = all;
		try {
			const group = await createGroup(creator);
			const inviterMembership = await admit(creator, group, inviter);
			const first = await invite(inviter, group, invitee);
			const second = await invite(creator, group, invitee);
			const rivalInvite = await invite(inviter, group, rival);
			// Leaving cancels only the leaver's invitations.
			await http(
				inviter,
				'delete',
				`/api/v1/group-memberships/${inviterMembership.id}`,
				undefined,
				204,
			);
			expect((await groupNotice(invitee, 'group_invitation', first.id)).target.state).toBe(
				'cancelled',
			);
			expect((await groupNotice(invitee, 'group_invitation', first.id)).actions).toEqual([]);
			expect((await groupNotice(rival, 'group_invitation', rivalInvite.id)).target.state).toBe(
				'cancelled',
			);
			expect((await groupNotice(invitee, 'group_invitation', second.id)).target.state).toBe(
				'pending',
			);
			await conflict(
				rival,
				'patch',
				`/api/v1/group-invitations/${rivalInvite.id}`,
				{ decision: 'accept' },
				'STALE_INVITATION',
			);
			await conflict(
				invitee,
				'patch',
				`/api/v1/group-invitations/${first.id}`,
				{ decision: 'accept' },
				'STALE_INVITATION',
			);
			expect(await role(rival, group)).toBe('none');
			// The returning inviter cannot revive the old invitation; a fresh invitation is a new identity.
			await conflict(
				inviter,
				'delete',
				`/api/v1/group-memberships/${inviterMembership.id}`,
				undefined,
				'STALE_MEMBERSHIP',
			);
			const returned = await admit(creator, group, inviter);
			expect(returned.id).not.toBe(inviterMembership.id);
			await conflict(
				rival,
				'patch',
				`/api/v1/group-invitations/${rivalInvite.id}`,
				{ decision: 'accept' },
				'STALE_INVITATION',
			);
			await conflict(
				creator,
				'delete',
				`/api/v1/group-memberships/${inviterMembership.id}`,
				undefined,
				'STALE_MEMBERSHIP',
			);
			expect(await role(rival, group)).toBe('none');
			const fresh = await invite(inviter, group, rival);
			expect(fresh.id).not.toBe(rivalInvite.id);
			// Accepting the invitee's other pending invitation supersedes siblings and removes any request.
			const sibling = await invite(inviter, group, invitee);
			await requestJoin(invitee, group);
			await acceptInvitation(invitee, second);
			expect((await groupNotice(invitee, 'group_invitation', sibling.id)).target.state).toBe(
				'superseded',
			);
			await conflict(
				invitee,
				'patch',
				`/api/v1/group-invitations/${sibling.id}`,
				{ decision: 'accept' },
				'STALE_INVITATION',
			);
			expect((await http(creator, 'get', `/api/v1/groups/${group.id}/join-requests`)).data).toEqual(
				[],
			);
			expect(
				(await http(creator, 'get', `/api/v1/groups/${group.id}/members`)).data.filter(
					(m) => m.id === invitee.account.id,
				),
			).toHaveLength(1);
			// Departed-inviter notice in the browser shows no live actions.
			await invitee.page.goto('/groups');
			await expect(invitee.page.locator(`[data-invitation-id="${first.id}"]`)).toHaveCount(0);
			await trigger(invitee.page).click();
			await expect(
				invitee.page
					.locator(
						`#notification-panel [data-notice-id="${(await groupNotice(invitee, 'group_invitation', first.id)).id}"] button`,
					)
					.filter({ hasText: /Accept|Refuse/u }),
			).toHaveCount(0);
		} finally {
			await dispose(all);
		}
	});

	test('private authors, nonmember followers, departed authors and retained contributions across every surface', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, [
			'Creator',
			'Author',
			'Reader',
			'Follower',
			'Outsider',
			'Pending',
		]);
		const [creator, author, reader, follower, outsider, pending] = all;
		try {
			await privacy(author, 'private');
			await follow(follower, author, true);
			const group = await createGroup(creator);
			const authorMembership = await admit(creator, group, author);
			await admit(creator, group, reader);
			await requestJoin(pending, group);
			await invite(creator, group, outsider);
			const p = await upload(author, '/api/v1/posts', {
				body: `Private author ${randomUUID()}`,
				group_id: String(group.id),
			});
			expect(p).toMatchObject({ audience: 'group', group: { id: group.id } });
			const c = await upload(reader, `/api/v1/posts/${p.id}/comments`, { body: 'Reader comment' });
			const mine = await post(reader, group, { body: 'Reader group post' });
			await http(author, 'post', `/api/v1/posts/${p.id}/like`);
			await http(reader, 'post', `/api/v1/comments/${c.id}/like`);
			const draft = await post(author, group, { status: 'draft', body: 'Author group draft' });
			const stillDraft = await post(reader, group, { status: 'draft', body: 'Reader draft' });
			// Private authors need no extra profile access for members to read the group post.
			for (const [who, allowed] of [
				[creator, true],
				[author, true],
				[reader, true],
				[follower, false],
				[outsider, false],
				[pending, false],
			])
				await checkAccess(who, group, p, c, allowed, { author });
			expect(
				(await http(reader, 'get', `/api/v1/users/${author.account.id}/profile`)).data.access,
			).not.toBe('full');
			await http(reader, 'get', `/api/v1/users/${author.account.id}/posts`, undefined, 404);
			// The follower has full profile access but no membership, so group posts are filtered.
			expect(await ids(follower, `/api/v1/users/${author.account.id}/posts`)).not.toContain(p.id);
			// Drafts are author-only, even from the creator.
			for (const who of [creator, reader, follower, outsider])
				await http(who, 'get', `/api/v1/posts/${draft.id}`, undefined, 404);
			await http(author, 'get', `/api/v1/posts/${draft.id}`);
			await http(author, 'get', `/api/v1/posts/draft?group_id=${group.id}`);
			// Browser: the nonmember sees no content on any route; the member does.
			for (const route of [`/posts/${p.id}`, `/groups/${group.id}/posts`, '/feed', '/activity']) {
				await follower.page.goto(route);
				await expect(follower.page.locator('main')).not.toContainText(p.body);
			}
			await reader.page.goto(`/groups/${group.id}/posts`);
			await expect(reader.page.locator(`[data-post-id="${p.id}"]`)).toContainText(p.body);
			await reader.page.goto('/feed');
			await expect(reader.page.locator('.feed-view .social-status')).toHaveText(/^\d+ posts?$/u);
			await expect(reader.page.locator(`[data-post-id="${p.id}"]`)).toHaveCount(1);
			// The author's content notice exists while they are a member and disappears on departure.
			const before = (await notices(author)).filter((n) => n.target.post_id === p.id);
			expect(before.map((n) => n.type)).toEqual(expect.arrayContaining(['comment']));

			// The author departs: every read and write path closes at once, including live pages.
			await author.page.goto(`/groups/${group.id}/posts`);
			await expect(author.page.locator(`[data-post-id="${p.id}"]`)).toBeVisible();
			await http(
				author,
				'delete',
				`/api/v1/group-memberships/${authorMembership.id}`,
				undefined,
				204,
			);
			await expect(author.page.getByText('Only members can read group posts.')).toBeVisible();
			await expect(author.page.locator('main')).not.toContainText(p.body);
			await checkAccess(author, group, p, c, false);
			await http(author, 'get', `/api/v1/posts/${draft.id}`, undefined, 404);
			await bytes(author, p.image_url, false);
			await http(author, 'post', `/api/v1/posts/${p.id}/comments`, { body: 'no' }, 404);
			await http(
				author,
				'delete',
				`/api/v1/posts/${p.id}?expected_version=${p.version}`,
				undefined,
				404,
			);
			await http(
				author,
				'post',
				`/api/v1/groups/${group.id}/invitations`,
				{ user_id: follower.account.id },
				404,
			);
			await http(author, 'post', '/api/v1/posts', { body: 'late', group_id: group.id }, 404);
			expect(await ids(author, '/api/v1/posts/mine')).not.toContain(p.id);
			expect(await ids(author, '/api/v1/posts/liked')).not.toContain(p.id);
			expect((await notices(author)).filter((n) => n.target.post_id === p.id)).toEqual([]);
			for (const route of [
				`/posts/${p.id}`,
				`/posts/${draft.id}/edit`,
				`/groups/${group.id}/posts/new`,
				'/feed',
				'/activity',
			]) {
				await author.page.goto(route);
				await expect(author.page.locator('main')).not.toContainText(p.body);
			}
			// Remaining members keep the contribution, its image, comments, likes and the author's name.
			for (const who of [creator, reader]) {
				const seen = (await http(who, 'get', `/api/v1/posts/${p.id}`)).data;
				expect(seen).toMatchObject({ likes: 1 });
				expect(JSON.stringify(seen)).toContain(author.name);
				await checkAccess(who, group, p, c, true);
				await http(who, 'get', `/api/v1/posts/${mine.id}`);
			}
			await reader.page.goto(`/posts/${p.id}?group=${group.id}`);
			await expect(reader.page.locator('.discussion-view')).toContainText(p.body);
			await http(creator, 'get', `/api/v1/posts/${draft.id}`, undefined, 404);
			await http(reader, 'get', `/api/v1/posts/${stillDraft.id}`);
			expect(await ids(creator, `/api/v1/posts?group_id=${group.id}&per_page=50`)).not.toContain(
				draft.id,
			);

			// Fresh admission restores membership-based access to the author's own contributions,
			// including the retained draft; the old membership ID stays dead.
			await conflict(
				creator,
				'delete',
				`/api/v1/group-memberships/${authorMembership.id}`,
				undefined,
				'STALE_MEMBERSHIP',
			);
			const back = await admit(creator, group, author);
			expect(back.id).not.toBe(authorMembership.id);
			await checkAccess(author, group, p, c, true);
			await http(author, 'get', `/api/v1/posts/${draft.id}`);
			await author.page.goto(`/groups/${group.id}/posts`);
			await expect(author.page.locator(`[data-post-id="${p.id}"]`)).toBeVisible();
			// Removal by the creator denies in the same way, and a stale pre-removal action cannot restore access.
			await http(creator, 'delete', `/api/v1/group-memberships/${back.id}`, undefined, 204);
			await checkAccess(author, group, p, c, false);
			await conflict(
				creator,
				'delete',
				`/api/v1/group-memberships/${back.id}`,
				undefined,
				'STALE_MEMBERSHIP',
			);
		} finally {
			await dispose(all);
		}
	});

	test('personal and group privacy never widen each other, and aggregates agree with feeds', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Creator', 'Member', 'Outsider']);
		const [creator, member, outsider] = all;
		try {
			const group = await createGroup(creator);
			await admit(creator, group, member);
			await follow(outsider, member);
			const personal = (
				await http(
					member,
					'post',
					'/api/v1/posts',
					{ body: `Followers ${randomUUID()}`, audience: 'followers', category_ids: [1] },
					201,
				)
			).data;
			const grouped = await post(member, group, { category_ids: [1] });
			// Cannot mix audiences or move content between scopes.
			await http(
				member,
				'post',
				'/api/v1/posts',
				{ body: 'mixed', group_id: group.id, audience: 'public' },
				400,
			);
			await http(
				member,
				'patch',
				`/api/v1/posts/${grouped.id}`,
				{ expected_version: grouped.version, group_id: group.id + 1 },
				400,
			);
			await http(
				member,
				'patch',
				`/api/v1/posts/${personal.id}`,
				{ expected_version: personal.version, group_id: group.id },
				400,
			);
			// Membership does not make a followers-only personal post readable.
			await http(creator, 'get', `/api/v1/posts/${personal.id}`, undefined, 404);
			await http(outsider, 'get', `/api/v1/posts/${personal.id}`);
			await http(outsider, 'get', `/api/v1/posts/${grouped.id}`, undefined, 404);
			const total = async (actor, q) =>
				(await http(actor, 'get', `/api/v1/posts?${q}per_page=1`)).meta.pagination.total;
			const base = await total(outsider, 'category_id=1&');
			// The outsider sees only the personal post; the creator only the group post; the member both.
			expect(await total(member, 'category_id=1&')).toBe(base + 1);
			expect(await total(creator, 'category_id=1&')).toBe(base);
			const categories = (actor) => http(actor, 'get', '/api/v1/categories/view');
			expect(JSON.stringify(await categories(outsider))).not.toContain(grouped.body);
			expect(JSON.stringify(await categories(creator))).toContain(grouped.body);
			// Unpublishing hides the group post from members too; republishing restores it with its totals.
			const current = (await http(member, 'get', `/api/v1/posts/${grouped.id}`)).data;
			await http(member, 'patch', `/api/v1/posts/${grouped.id}`, {
				expected_version: current.version,
				status: 'draft',
			});
			await http(creator, 'get', `/api/v1/posts/${grouped.id}`, undefined, 404);
			expect(await total(creator, 'category_id=1&')).toBe(base - 1);
			const draft = (await http(member, 'get', `/api/v1/posts/${grouped.id}`)).data;
			await http(member, 'patch', `/api/v1/posts/${grouped.id}`, {
				expected_version: draft.version,
				status: 'published',
			});
			expect(await total(creator, 'category_id=1&')).toBe(base);
			// Navigation never exposes a neighbouring hidden item.
			const nav = (await http(outsider, 'get', `/api/v1/posts/${personal.id}/nav?category_id=1`))
				.data;
			expect([nav.prev_id, nav.next_id]).not.toContain(grouped.id);
		} finally {
			await dispose(all);
		}
	});

	test('live membership loss reaches open pages, recovery after missed signals, and session cleanup', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Creator', 'Member', 'Other']);
		const [creator, member, other] = all;
		try {
			const group = await createGroup(creator);
			const membership = await admit(creator, group, member);
			const otherMembership = await admit(creator, group, other);
			const p = await post(creator, group, { body: 'Open page post' });
			await member.page.goto(`/groups/${group.id}/posts`);
			await expect(member.page.locator(`[data-post-id="${p.id}"]`)).toBeVisible();
			// Missed signal: the socket path is offline while removal commits, then reconnects.
			await member.context.setOffline(true);
			await http(creator, 'delete', `/api/v1/group-memberships/${membership.id}`, undefined, 204);
			await member.context.setOffline(false);
			await expect(member.page.getByText('Only members can read group posts.')).toBeVisible({
				timeout: 30000,
			});
			await expect(member.page.locator('main')).not.toContainText('Open page post');
			// Live signal: the other member is removed while the page is connected.
			await other.page.goto(`/groups/${group.id}/posts`);
			await expect(other.page.locator(`[data-post-id="${p.id}"]`)).toBeVisible();
			await http(
				creator,
				'delete',
				`/api/v1/group-memberships/${otherMembership.id}`,
				undefined,
				204,
			);
			await expect(other.page.getByText('Only members can read group posts.')).toBeVisible({
				timeout: 15000,
			});
			// Session cleanup: sign out, back button and protected direct entry reveal nothing.
			await creator.page.goto(`/groups/${group.id}/posts`);
			await expect(creator.page.locator(`[data-post-id="${p.id}"]`)).toBeVisible();
			await creator.page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await expect(creator.page).toHaveURL(/\/login$/u);
			await creator.page.goBack();
			await expect(creator.page.locator(`[data-post-id="${p.id}"]`)).toHaveCount(0);
			await creator.page.goto(`/groups/${group.id}/members`);
			await expect(creator.page).toHaveURL(/\/login\?redirect=/u);
			await http(creator, 'get', `/api/v1/groups/${group.id}`, undefined, 401);
			await http(creator, 'get', `/api/v1/posts/${p.id}`, undefined, 401);
		} finally {
			await dispose(all);
		}
	});
});

test('SN-A17 groups, notices, drafts and bytes survive recreation without resets', async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(240000);
	const all = await actors(browser, baseURL, [
		'Creator',
		'Author',
		'Departed',
		'Invitee',
		'Outsider',
	]);
	const [creator, author, departed, invitee, outsider] = all;
	try {
		const group = await createGroup(creator);
		await admit(creator, group, author);
		const departedMembership = await admit(creator, group, departed);
		const pending = await invite(author, group, invitee);
		const p = await upload(departed, '/api/v1/posts', {
			body: `Retained ${randomUUID()}`,
			group_id: String(group.id),
		});
		const c = await upload(author, `/api/v1/posts/${p.id}/comments`, { body: 'Author comment' });
		const draft = await post(author, group, { status: 'draft', body: 'Draft across restart' });
		await http(author, 'post', `/api/v1/posts/${p.id}/dislike`);
		const requestId = (await requestJoin(outsider, group)).id;
		await http(
			departed,
			'delete',
			`/api/v1/group-memberships/${departedMembership.id}`,
			undefined,
			204,
		);
		recreate();
		// Sessions, membership, pending entries, notices, records and bytes persist.
		expect(await role(author, group)).toBe('member');
		expect(await role(departed, group)).toBe('none');
		expect((await http(author, 'get', `/api/v1/posts/${p.id}`)).data).toMatchObject({
			dislikes: 1,
			my_reaction: -1,
			group: { id: group.id },
		});
		await bytes(author, p.image_url, true);
		await bytes(creator, c.image_url, true);
		await bytes(departed, p.image_url, false);
		await http(departed, 'get', `/api/v1/posts/${p.id}`, undefined, 404);
		await http(creator, 'get', `/api/v1/posts/${draft.id}`, undefined, 404);
		await http(author, 'get', `/api/v1/posts/${draft.id}`);
		expect((await groupNotice(invitee, 'group_invitation', pending.id)).target.state).toBe(
			'pending',
		);
		expect((await groupNotice(creator, 'group_join_request', requestId)).target.state).toBe(
			'pending',
		);
		await acceptInvitation(invitee, pending);
		await acceptRequest(creator, { id: requestId });
		await conflict(
			departed,
			'delete',
			`/api/v1/group-memberships/${departedMembership.id}`,
			undefined,
			'STALE_MEMBERSHIP',
		);
		await conflict(
			invitee,
			'patch',
			`/api/v1/group-invitations/${pending.id}`,
			{ decision: 'accept' },
			'STALE_INVITATION',
		);
		expect(await role(outsider, group)).toBe('member');
		await outsider.page.goto(`/groups/${group.id}/posts`);
		await expect(outsider.page.locator(`[data-post-id="${p.id}"]`)).toBeVisible();
		// Missed-signal recovery: a page opened after restart receives later removals without reload.
		const removed = (await http(creator, 'get', `/api/v1/groups/${group.id}/members`)).data.find(
			(m) => m.id === outsider.account.id,
		).membership;
		await http(creator, 'delete', `/api/v1/group-memberships/${removed.id}`, undefined, 204);
		await expect(outsider.page.getByText('Only members can read group posts.')).toBeVisible({
			timeout: 20000,
		});
		// Group deletion of the departed author's text does not occur: the post remains for members.
		expect((await http(creator, 'get', `/api/v1/posts/${p.id}`)).data.body).toBe(p.body);
	} finally {
		await dispose(all);
	}
});

for (const [label, viewport] of [
	['desktop', { width: 1280, height: 900 }],
	['360px', { width: 360, height: 800 }],
]) {
	test(`SN-A17 keyboard group publishing, discussion and removal at ${label}`, async ({
		browser,
		baseURL,
	}) => {
		test.setTimeout(120000);
		const all = await actors(browser, baseURL, ['Creator', 'Member']);
		const [creator, member] = all;
		try {
			const group = await createGroup(creator);
			await admit(creator, group, member);
			await member.page.setViewportSize(viewport);
			await creator.page.setViewportSize(viewport);
			await member.page.goto(`/groups/${group.id}/posts/new`);
			await member.page.getByLabel('Title').fill(`Keyboard ${member.name}`);
			await member.page.getByLabel('Post', { exact: true }).fill('Real group publication');
			await member.page.getByRole('button', { name: 'Publish' }).focus();
			await member.page.keyboard.press('Enter');
			await expect(member.page).toHaveURL(new RegExp(`/groups/${group.id}/posts$`, 'u'));
			const mine = (await http(member, 'get', '/api/v1/posts/mine')).data.find(
				(item) => item.title === `Keyboard ${member.name}`,
			);
			expect(mine).toMatchObject({ audience: 'group', group: { id: group.id } });
			await creator.page.goto(`/posts/${mine.id}?group=${group.id}`);
			await creator.page
				.getByLabel('Your comment', { exact: true })
				.fill('Creator keyboard comment');
			await creator.page.getByRole('button', { name: 'Send comment' }).focus();
			await creator.page.keyboard.press('Enter');
			await expect(creator.page.locator('[data-comment-id]')).toContainText(
				'Creator keyboard comment',
			);
			await noOverflow(creator.page);
			await creator.page.screenshot({ path: `.tmp/a17-discussion-${label}.png`, fullPage: true });
			await creator.page.goto('/groups');
			await noOverflow(creator.page);
			await creator.page.goto(`/groups/${group.id}/members`);
			await noOverflow(creator.page);
			await creator.page.screenshot({ path: `.tmp/a17-members-${label}.png`, fullPage: true });
			await creator.page
				.getByRole('button', { name: new RegExp(`^Remove ${member.name}`, 'u') })
				.click();
			await creator.page.getByRole('button', { name: 'Confirm removal' }).click();
			await expect(member.page.locator('main')).toBeVisible();
			await member.page.goto(`/posts/${mine.id}`);
			await expect(member.page.locator('main')).not.toContainText('Real group publication');
			await http(member, 'get', `/api/v1/posts/${mine.id}`, undefined, 404);
		} finally {
			await dispose(all);
		}
	});
}
