import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Real browser cookies, HTTP, WebSockets and bytes through the isolated two
// images. No route mocks, fixture backend, SQL seeds or synthetic socket frames.
const png = readFileSync('SPA/tests/fixtures/a07/avatar.png');
const password = 'correct horse battery';
const writeHeaders = (baseURL) => ({ Origin: baseURL, 'X-Requested-With': 'XMLHttpRequest' });

async function http(actor, method, path, data, expected = 200) {
	const response = await actor.context.request[method](path, data === undefined ? {} : { data });
	expect(response.status(), `${method} ${path}`).toBe(expected);
	expect(response.headers()['cache-control'], path).toContain('no-store');
	return expected === 204 ? null : response.json();
}
async function actors(browser, baseURL, roles = ['Owner', 'Follower', 'Pending', 'Outsider']) {
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
				name: `A11 ${role} ${suffix}`,
				email: `a11-${role.toLowerCase()}-${suffix}@example.com`,
			};
			all.push(actor);
			const fields = {
				email: actor.email,
				password,
				first_name: role,
				last_name: 'Acceptance',
				date_of_birth: '1998-03-14',
				nickname: actor.name,
				about_me: `Protected biography ${suffix}`,
			};
			const response = await context.request.post(
				'/api/v1/users/register',
				role === 'Owner'
					? {
							multipart: {
								...fields,
								avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: png },
							},
						}
					: { data: fields },
			);
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
	return (
		await http(actor, 'patch', '/api/v1/users/me/privacy', {
			visibility,
			expected_version: current.profile.version,
		})
	).data;
}
async function follow(sender, recipient) {
	return (await http(sender, 'post', '/api/v1/follows', { user_id: recipient.account.id }, 201))
		.data;
}
async function decide(recipient, id, decision) {
	return http(
		recipient,
		'patch',
		`/api/v1/follow-requests/${id}`,
		{ decision },
		decision === 'accept' ? 200 : 204,
	);
}
const profilePath = (actor) => `/users/${actor.account.id}`;
const trigger = (page) => page.getByRole('button', { name: /^Notifications/u });
async function panel(page) {
	await trigger(page).click();
	await expect(page.locator('#notification-panel')).toBeVisible();
	await expect(page.locator('#notification-panel')).not.toContainText('Loading notifications…');
}
function teaser(profile) {
	expect(Object.keys(profile).sort()).toEqual(['access', 'display_name', 'id', 'relationship']);
	expect(profile.access).toBe('teaser');
}
async function notice(actor, followId) {
	const result = await http(actor, 'get', '/api/v1/notifications');
	return result.data.notifications.find((item) => item.target.follow_id === followId);
}

async function checkContentAccess(actor, post, comment, allowed) {
	for (const path of [
		`/api/v1/posts/${post.id}`,
		`/api/v1/posts/${post.id}/comments`,
		`/api/v1/comments/${comment.id}`,
		`/api/v1/posts/${post.id}/nav?category_id=1`,
	])
		await http(actor, 'get', path, undefined, allowed ? 200 : 404);
	const bytes = await actor.context.request.get(post.image_url);
	expect(bytes.status()).toBe(allowed ? 200 : 404);
	if (allowed) {
		expect(await bytes.body()).toEqual(png);
		expect(bytes.headers()['x-content-type-options']).toBe('nosniff');
	}
	for (const path of [
		'/api/v1/posts?per_page=1',
		'/api/v1/posts?category_id=1',
		'/api/v1/categories/view',
		'/api/v1/posts/mine',
		'/api/v1/posts/liked',
		'/api/v1/posts/disliked',
		'/api/v1/users/activity',
	]) {
		const body = await http(actor, 'get', path);
		if (!allowed) expect(JSON.stringify(body)).not.toContain(post.title);
	}
}

async function checkDeniedMutations(actor, post) {
	await http(actor, 'post', `/api/v1/posts/${post.id}/comments`, { body: 'denied' }, 404);
	await http(actor, 'post', `/api/v1/posts/${post.id}/like`, undefined, 404);
	await http(actor, 'patch', `/api/v1/posts/${post.id}`, { body: 'denied' }, 404);
	for (const path of [
		'/static/uploads/guess.png',
		'/static/%75ploads/guess.png',
		'/static/uploads/dm/guess.png',
		`/api/v1/media/../media/${post.image_url.split('/').at(-1)}`,
	])
		expect((await actor.context.request.get(path)).status()).toBe(404);
}

test.describe('SN-A11 real Phase 2 acceptance through both images', () => {
	test.setTimeout(90000);

	test('discovery, private teasers, lists and complete recipient-only follow lifecycle', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL);
		const [owner, follower, pending, outsider] = all;
		try {
			const initial = (await http(outsider, 'get', `/api/v1/users/${owner.account.id}/profile`))
				.data;
			expect(initial.profile.visibility).toBe('public');
			expect((await outsider.context.request.get(owner.account.avatar_url)).status()).toBe(200);
			await outsider.page.goto(profilePath(owner));
			await expect(outsider.page.locator('.profile-details')).toContainText(owner.email);
			await owner.page.goto(profilePath(owner));
			await owner.page.getByRole('button', { name: 'Make profile private' }).click();
			await expect(owner.page.locator('[data-visibility]')).toContainText('Private profile');
			await expect(outsider.page.locator('[data-state="teaser"]')).toBeVisible();
			await expect(outsider.page.locator('main')).not.toContainText(owner.email);
			await privacy(follower, 'private');
			for (const actor of [follower, pending, outsider]) {
				teaser((await http(actor, 'get', `/api/v1/users/${owner.account.id}/profile`)).data);
				await http(actor, 'get', `/api/v1/users/${owner.account.id}/followers`, undefined, 404);
				expect((await actor.context.request.get(owner.account.avatar_url)).status()).toBe(404);
			}
			await outsider.page.goto(`/people?q=${encodeURIComponent(owner.name)}`);
			const row = outsider.page.locator(`[data-person-id="${owner.account.id}"]`);
			await expect(row).toContainText('name only');
			await expect(row.locator('img')).toHaveCount(0);
			const directory = await http(
				outsider,
				'get',
				`/api/v1/users?q=${encodeURIComponent(owner.name)}`,
			);
			teaser(directory.data.find((item) => item.id === owner.account.id));
			await follower.page.goto(profilePath(owner));
			await follower.page
				.getByRole('button', { name: `Follow ${owner.name}`, exact: true })
				.click();
			await expect(follower.page.locator('.follow-control')).toContainText('Request pending');
			const incoming = (await http(owner, 'get', '/api/v1/users/me/follow-requests')).data.find(
				(r) => r.requester.id === follower.account.id,
			);
			teaser(incoming.requester);
			await panel(owner.page);
			await owner.page
				.getByRole('button', { name: `Accept follow request from ${follower.name}` })
				.click();
			await expect(owner.page.locator('#notification-panel')).toContainText('Request accepted');
			await expect(follower.page.locator('.profile-details')).toContainText(owner.email);
			expect(await (await follower.context.request.get(owner.account.avatar_url)).body()).toEqual(
				png,
			);
			const list = await http(owner, 'get', `/api/v1/users/${owner.account.id}/followers`);
			expect(list.data.map((p) => p.id)).toEqual([follower.account.id]);
			teaser(list.data[0]);
			let request = await follow(pending, owner);
			await http(
				outsider,
				'patch',
				`/api/v1/follow-requests/${request.id}`,
				{ decision: 'accept' },
				404,
			);
			await http(pending, 'delete', `/api/v1/follows/${request.id}`, undefined, 204);
			const retry = await follow(pending, owner);
			expect(retry.id).not.toBe(request.id);
			const stale = await http(
				owner,
				'patch',
				`/api/v1/follow-requests/${request.id}`,
				{ decision: 'accept' },
				409,
			);
			expect(stale.error.code).toBe('STALE_FOLLOW');
			await decide(owner, retry.id, 'decline');
			expect((await notice(owner, request.id)).target.state).toBe('cancelled');
			expect((await notice(owner, retry.id)).target.state).toBe('declined');
			request = await follow(pending, owner);
			await owner.page.getByRole('button', { name: 'Close notifications' }).click();
			await owner.page.getByRole('button', { name: 'Make profile public' }).click();
			await owner.page.getByRole('button', { name: 'Make public and accept requests' }).click();
			await expect(owner.page.locator('[data-visibility]')).toContainText('Public profile');
			expect((await notice(owner, request.id)).target).toMatchObject({
				follow_id: request.id,
				state: 'accepted',
			});
			await privacy(owner, 'private');
			expect(
				(await http(follower, 'get', `/api/v1/users/${owner.account.id}/profile`)).data.access,
			).toBe('full');
			await follower.page.getByRole('button', { name: `Unfollow ${owner.name}` }).click();
			await expect(follower.page.locator('[data-state="teaser"]')).toBeVisible();
			await expect(follower.page.locator('main')).not.toContainText(owner.email);
			expect((await follower.context.request.get(owner.account.avatar_url)).status()).toBe(404);
			expect((await notice(owner, incoming.id)).target.state).toBe('unfollowed');
			const publicFollow = await follow(outsider, follower);
			expect(publicFollow.state).toBe('pending');
			await privacy(follower, 'public');
			await http(outsider, 'delete', `/api/v1/follows/${publicFollow.id}`, undefined, 204);
			expect((await follow(outsider, follower)).state).toBe('accepted');
		} finally {
			await dispose(all);
		}
	});

	test('durable notices, cross-tab read state, real disconnect/reconnect and global routes', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Owner', 'Follower', 'Outsider']);
		const [owner, sender, outsider] = all;
		try {
			await privacy(owner, 'private');
			await owner.context.addInitScript(() => {
				const NativeSocket = window.WebSocket;
				window.a11Sockets = [];
				window.WebSocket = class extends NativeSocket {
					constructor(...args) {
						super(...args);
						window.a11Sockets.push(this);
					}
				};
			});
			const frames = [];
			owner.page.on('websocket', (ws) =>
				ws.on('framereceived', ({ payload }) => {
					frames.push(JSON.parse(String(payload)));
				}),
			);
			await owner.page.goto('/');
			const request = await follow(sender, owner);
			await expect(trigger(owner.page)).toContainText('1');
			await panel(owner.page);
			const second = await owner.context.newPage();
			await second.goto('/people');
			await panel(second);
			const n = await notice(owner, request.id);
			await http(outsider, 'patch', `/api/v1/notifications/${n.id}/read`, undefined, 404);
			await owner.page
				.getByRole('button', { name: `Mark notification from ${sender.name} read` })
				.click();
			await expect(trigger(second)).toContainText('0');
			await expect(
				second.getByRole('button', { name: `Accept follow request from ${sender.name}` }),
			).toBeVisible();
			await second
				.getByRole('button', { name: `Decline follow request from ${sender.name}` })
				.click();
			await expect(owner.page.locator('#notification-panel')).toContainText('Request declined');
			await second.close();
			await owner.page.getByRole('button', { name: 'Close notifications' }).click();
			for (const name of ['Home', 'People', 'Profile']) {
				await owner.page.getByRole('link', { name, exact: true }).click();
				await panel(owner.page);
				await expect(owner.page.locator('#notification-panel')).toContainText('Request declined');
				await owner.page.keyboard.press('Escape');
			}
			expect(await owner.page.evaluate(() => window.a11Sockets.length)).toBe(1);
			await owner.page.evaluate(() => window.a11Sockets[0].close());
			const retry = await follow(sender, owner);
			await expect.poll(() => owner.page.evaluate(() => window.a11Sockets.length)).toBe(2);
			await expect(trigger(owner.page)).toContainText('1');
			await panel(owner.page);
			await owner.page.getByRole('button', { name: 'Mark all read' }).click();
			await expect(trigger(owner.page)).toContainText('0');
			expect((await notice(owner, retry.id)).target.state).toBe('pending');
			const signals = frames.filter((frame) =>
				['notification.new', 'social.invalidate'].includes(frame.type),
			);
			expect(signals.length).toBeGreaterThan(0);
			for (const signal of signals) expect(Object.keys(signal)).toEqual(['type']);
		} finally {
			await dispose(all);
		}
	});

	test('retained content, aggregates, activity, notices and direct media enforce the same access matrix', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL);
		const [owner, follower, pending, outsider] = all;
		try {
			const response = await owner.context.request.post('/api/v1/posts', {
				multipart: {
					title: `A11 hidden title ${owner.name}`,
					body: 'A11 protected body',
					category_ids: '1',
					image: { name: 'post.png', mimeType: 'image/png', buffer: png },
				},
			});
			expect(response.status()).toBe(201);
			const post = (await response.json()).data;
			const comment = (
				await http(
					outsider,
					'post',
					`/api/v1/posts/${post.id}/comments`,
					{ body: 'A11 restricted excerpt' },
					201,
				)
			).data;
			await http(owner, 'post', `/api/v1/comments/${comment.id}/like`);
			const visibleNotices = (await http(outsider, 'get', '/api/v1/notifications')).data;
			expect(visibleNotices.unread_count).toBe(1);
			const contentNotice = visibleNotices.notifications[0];
			await outsider.page.goto('/');
			await panel(outsider.page);
			await expect(outsider.page.locator('#notification-panel')).toContainText(post.title);
			const beforeTotal = (await http(outsider, 'get', '/api/v1/posts?per_page=1')).meta.pagination
				.total;
			const draft = (
				await http(
					owner,
					'post',
					'/api/v1/posts',
					{
						title: 'A11 owner-only draft',
						body: 'private draft body',
						status: 'draft',
						category_ids: [1],
					},
					201,
				)
			).data;
			for (const actor of all)
				await http(
					actor,
					'get',
					`/api/v1/posts/${draft.id}`,
					undefined,
					actor === owner ? 200 : 404,
				);
			await privacy(owner, 'private');
			await privacy(follower, 'private');
			const accepted = await follow(follower, owner);
			await decide(owner, accepted.id, 'accept');
			await follow(pending, owner);
			expect((await http(outsider, 'get', '/api/v1/posts?per_page=1')).meta.pagination.total).toBe(
				beforeTotal - 1,
			);
			for (const actor of all)
				await checkContentAccess(actor, post, comment, actor === owner || actor === follower);
			for (const actor of [pending, outsider]) await checkDeniedMutations(actor, post);
			const hidden = (await http(outsider, 'get', '/api/v1/notifications')).data;
			expect(hidden).toEqual({ notifications: [], unread_count: 0 });
			await expect(outsider.page.locator(`[data-notice-id="${contentNotice.id}"]`)).toHaveCount(0);
			await expect(outsider.page.locator('#notification-panel')).not.toContainText(
				'A11 restricted',
			);
			await expect(trigger(outsider.page)).toContainText('0');
			await http(
				outsider,
				'patch',
				`/api/v1/notifications/${contentNotice.id}/read`,
				undefined,
				404,
			);
			await http(outsider, 'patch', '/api/v1/notifications/read-all', undefined, 204);
			await privacy(owner, 'public');
			const restored = (await http(outsider, 'get', '/api/v1/notifications')).data;
			expect(restored.unread_count).toBe(1);
			expect(restored.notifications[0].is_read).toBe(false);
			await expect(
				outsider.page.locator(`#notification-panel [data-notice-id="${contentNotice.id}"]`),
			).toContainText(post.title);
			await expect(trigger(outsider.page)).toContainText('1');
			const anonymous = await browser.newContext({ baseURL });
			try {
				expect((await anonymous.request.get(post.image_url)).status()).toBe(401);
			} finally {
				await anonymous.close();
			}
			await privacy(owner, 'private');
			await http(follower, 'delete', `/api/v1/follows/${accepted.id}`, undefined, 204);
			expect((await follower.context.request.get(post.image_url)).status()).toBe(404);
			await http(owner, 'delete', `/api/v1/posts/${post.id}`, undefined, 204);
			expect((await owner.context.request.get(post.image_url)).status()).toBe(404);
		} finally {
			await dispose(all);
		}
	});

	test('notices, relationships, sessions and avatar/post bytes survive container recreation', async ({
		browser,
		baseURL,
	}) => {
		test.setTimeout(180000);
		if (!/^sn-b07-test-\d+$/u.test(process.env.COMPOSE_PROJECT_NAME || ''))
			throw new Error('A11 restart requires the isolated B07 stack');
		const all = await actors(browser, baseURL, ['Owner', 'Follower', 'Pending']);
		const [owner, follower, pending] = all;
		try {
			await privacy(owner, 'private');
			const accepted = await follow(follower, owner);
			await decide(owner, accepted.id, 'accept');
			const request = await follow(pending, owner);
			const savedNotice = await notice(owner, request.id);
			const response = await owner.context.request.post('/api/v1/posts', {
				multipart: {
					title: 'A11 retained bytes',
					body: 'persist me',
					category_ids: '1',
					image: { name: 'image.png', mimeType: 'image/png', buffer: png },
				},
			});
			expect(response.status()).toBe(201);
			const post = (await response.json()).data;
			await owner.page.goto(profilePath(owner));
			await follower.page.goto(profilePath(owner));
			for (let restart = 0; restart < 2; restart += 1) {
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
					],
					{ stdio: 'pipe', timeout: 120000 },
				);
				await follower.page.reload();
				await expect(follower.page.locator('.profile-details')).toContainText(owner.email);
				expect((await http(follower, 'get', '/api/v1/users/me')).data.id).toBe(follower.account.id);
				expect(
					(await http(follower, 'get', `/api/v1/users/${owner.account.id}/profile`)).data
						.relationship.follow_id,
				).toBe(accepted.id);
				const restored = await notice(owner, request.id);
				expect(restored).toEqual(savedNotice);
				for (const path of [post.image_url, owner.account.avatar_url])
					expect(await (await follower.context.request.get(path)).body()).toEqual(png);
				await http(pending, 'get', post.image_url, undefined, 404);
			}
			await panel(owner.page);
			await expect(
				owner.page.getByRole('button', { name: `Accept follow request from ${pending.name}` }),
			).toBeVisible();
			await owner.page
				.getByRole('button', { name: `Accept follow request from ${pending.name}` })
				.click();
			await expect(owner.page.locator('#notification-panel')).toContainText('Request accepted');
			expect((await pending.context.request.get(post.image_url)).status()).toBe(200);
		} finally {
			await dispose(all);
		}
	});

	for (const [label, viewport] of [
		['desktop', { width: 1280, height: 900 }],
		['360px', { width: 360, height: 800 }],
	]) {
		test(`deep links, permission revocation, logout/back and keyboard at ${label}`, async ({
			browser,
			baseURL,
		}) => {
			const all = await actors(browser, baseURL, ['Owner', 'Follower']);
			const [owner, follower] = all;
			try {
				await follower.page.setViewportSize(viewport);
				await privacy(owner, 'private');
				const request = await follow(follower, owner);
				await decide(owner, request.id, 'accept');
				await follower.page.goto(profilePath(owner));
				await expect(follower.page.locator('.profile-details')).toContainText(owner.email);
				await follower.page.getByRole('link', { name: '1 follower', exact: true }).click();
				await expect(follower.page.locator('.person-list')).toBeVisible();
				await follower.page.goBack();
				await expect(follower.page.locator('.profile-details')).toContainText(owner.email);
				const unfollow = follower.page.getByRole('button', { name: `Unfollow ${owner.name}` });
				await unfollow.focus();
				await follower.page.keyboard.press('Enter');
				await expect(follower.page.locator('[data-state="teaser"]')).toBeVisible();
				await expect(follower.page.locator('main')).not.toContainText(owner.email);
				await panel(follower.page);
				await follower.page.keyboard.press('Escape');
				await expect(trigger(follower.page)).toBeFocused();
				expect(
					await follower.page.evaluate(
						() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
					),
				).toBeLessThanOrEqual(0);
				await follower.page.screenshot({ path: `.tmp/a11-${label}.png`, fullPage: true });
				await follower.page.getByRole('button', { name: 'Sign out', exact: true }).click();
				await expect(follower.page).toHaveURL(/\/login$/);
				await follower.page.goBack();
				await expect(follower.page.locator('.profile-details')).toHaveCount(0);
				await follower.page.goto(profilePath(owner));
				await expect(follower.page).toHaveURL(/\/login\?redirect=/);
				await follower.page.getByLabel('Email', { exact: true }).fill(follower.email);
				await follower.page.getByLabel('Password', { exact: true }).fill(password);
				await follower.page.getByRole('button', { name: 'Sign in', exact: true }).click();
				await expect(follower.page.locator('[data-state="teaser"]')).toBeVisible();
			} finally {
				await dispose(all);
			}
		});
	}
});
