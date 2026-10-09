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
				name: `A14 ${role} ${suffix}`,
				email: `a14-${role.toLowerCase()}-${suffix}@example.com`,
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
const trigger = (page) => page.getByRole('button', { name: /^Notifications/u });
async function panel(page) {
	await trigger(page).click();
	await expect(page.locator('#notification-panel')).toBeVisible();
	await expect(page.locator('#notification-panel')).not.toContainText('Loading notifications…');
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
		if (!allowed) expect(JSON.stringify(body)).not.toContain(post.body);
	}
}

async function checkDeniedMutations(actor, post) {
	await http(actor, 'post', `/api/v1/posts/${post.id}/comments`, { body: 'denied' }, 404);
	await http(actor, 'post', `/api/v1/posts/${post.id}/like`, undefined, 404);
	await http(
		actor,
		'patch',
		`/api/v1/posts/${post.id}`,
		{ expected_version: post.version, body: 'denied' },
		404,
	);
	for (const path of [
		'/static/uploads/guess.png',
		'/static/%75ploads/guess.png',
		'/static/uploads/dm/guess.png',
		`/api/v1/media/../media/${post.image_url.split('/').at(-1)}`,
	])
		expect((await actor.context.request.get(path)).status()).toBe(404);
}

async function create(owner, data = {}) {
	return (await http(owner, 'post', '/api/v1/posts', { body: `A14 ${randomUUID()}`, ...data }, 201))
		.data;
}
async function edit(owner, post, data) {
	const current = (await http(owner, 'get', `/api/v1/posts/${post.id}`)).data;
	return (
		await http(owner, 'patch', `/api/v1/posts/${post.id}`, {
			expected_version: current.version,
			...data,
		})
	).data;
}
async function upload(owner, path, extra = {}) {
	const response = await owner.context.request.post(path, {
		multipart: {
			...extra,
			image: { name: 'post.png', mimeType: 'image/png', buffer: png },
		},
	});
	expect(response.status()).toBe(201);
	return (await response.json()).data;
}
async function contains(actor, path, id, allowed) {
	const response = await http(actor, 'get', path);
	expect(
		response.data.some((item) => item.id === id),
		path,
	).toBe(allowed);
	return response;
}

test.describe('SN-A14 real Phase 3 acceptance', () => {
	test.setTimeout(180000);
	for (const visibility of ['public', 'private']) {
		for (const audience of ['public', 'followers', 'selected']) {
			test(`${visibility} profile / ${audience}: five roles across browser, API, counts and bytes`, async ({
				browser,
				baseURL,
				// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit matrix assertions cover every access surface.
			}) => {
				const all = await actors(browser, baseURL, [
					'Owner',
					'Selected',
					'Unselected',
					'Pending',
					'Outsider',
				]);
				const [owner, selected, unselected, pending] = all;
				try {
					await privacy(owner, 'private');
					for (const actor of [selected, unselected]) {
						const request = await follow(actor, owner);
						await decide(owner, request.id, 'accept');
					}
					await follow(pending, owner);
					if (visibility === 'public') {
						await privacy(owner, 'public');
						// Public profiles auto-accept pending requests; remove this relation
						// to test the non-follower cell. Private rows retain a real pending request.
						const relation = (
							await http(pending, 'get', `/api/v1/users/${owner.account.id}/profile`)
						).data.relationship;
						await http(pending, 'delete', `/api/v1/follows/${relation.follow_id}`, undefined, 204);
					}
					const post = await upload(owner, '/api/v1/posts', {
						body: `Matrix ${randomUUID()}`,
						audience,
						category_ids: '1',
						...(audience === 'selected'
							? { selected_follower_ids: String(selected.account.id) }
							: {}),
					});
					const comment = await upload(owner, `/api/v1/posts/${post.id}/comments`, {
						body: `Matrix comment ${randomUUID()}`,
					});
					for (const actor of all) {
						const accepted = actor === selected || actor === unselected;
						const allowed =
							actor === owner ||
							((visibility === 'public' || accepted) &&
								(audience === 'public' ||
									(audience === 'followers' && accepted) ||
									actor === selected));
						await checkContentAccess(actor, post, comment, allowed);
						const image = await actor.context.request.get(comment.image_url);
						expect(image.status()).toBe(allowed ? 200 : 404);
						if (allowed) expect(await image.body()).toEqual(png);
						await contains(actor, '/api/v1/posts?per_page=50', post.id, allowed);
						const following = await contains(
							actor,
							'/api/v1/posts?feed=following&category_id=1&per_page=50',
							post.id,
							allowed && accepted,
						);
						if (!accepted) expect(following.meta.pagination.total).toBe(0);
						for (const suffix of ['posts', 'comments']) {
							const path = `/api/v1/users/${owner.account.id}/${suffix}`;
							if (visibility === 'private' && !accepted && actor !== owner)
								await http(actor, 'get', path, undefined, 404);
							else {
								const result = await contains(
									actor,
									path,
									suffix === 'posts' ? post.id : comment.id,
									allowed,
								);
								expect(result.meta.pagination.total).toBe(allowed ? 1 : 0);
							}
						}
						await actor.page.goto(`/posts/${post.id}`);
						if (allowed) {
							await expect(actor.page.locator('.discussion-view')).toContainText(post.body);
							await expect(actor.page.locator(`[data-comment-id="${comment.id}"]`)).toContainText(
								comment.body,
							);
							const result = (await http(actor, 'get', `/api/v1/posts/${post.id}`)).data;
							expect(Object.hasOwn(result, 'selected_follower_ids')).toBe(actor === owner);
						} else {
							await expect(
								actor.page.getByText('This discussion isn’t available.', { exact: true }),
							).toBeVisible();
							await expect(actor.page.locator('main')).not.toContainText(post.body);
							await checkDeniedMutations(actor, post);
						}
						await actor.page.goto('/feed');
						await expect(actor.page.locator(`[data-post-id="${post.id}"]`)).toHaveCount(
							allowed ? 1 : 0,
						);
					}
					const anonymous = await browser.newContext({ baseURL });
					try {
						expect((await anonymous.request.get(post.image_url)).status()).toBe(401);
					} finally {
						await anonymous.close();
					}
				} finally {
					await dispose(all);
				}
			});
		}
	}

	test('audience directions, profile toggles, unfollow/refollow and explicit reselection', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Owner', 'Selected', 'Outsider']);
		const [owner, selected, outsider] = all;
		try {
			const first = await follow(selected, owner);
			let post = await create(owner);
			await http(outsider, 'get', `/api/v1/posts/${post.id}`);
			post = await edit(owner, post, { audience: 'followers' });
			await http(outsider, 'get', `/api/v1/posts/${post.id}`, undefined, 404);
			await http(selected, 'get', `/api/v1/posts/${post.id}`);
			post = await edit(owner, post, {
				audience: 'selected',
				selected_follower_ids: [selected.account.id],
			});
			await selected.page.goto(`/posts/${post.id}`);
			await expect(selected.page.locator('.discussion-view')).toContainText(post.body);
			await http(selected, 'delete', `/api/v1/follows/${first.id}`, undefined, 204);
			await expect(
				selected.page.getByText('This discussion isn’t available.', { exact: true }),
			).toBeVisible();
			const second = await follow(selected, owner);
			expect(second.id).not.toBe(first.id);
			await http(selected, 'get', `/api/v1/posts/${post.id}`, undefined, 404);
			expect(
				(await http(owner, 'get', `/api/v1/posts/${post.id}`)).data.selected_follower_ids,
			).toEqual([]);
			post = await edit(owner, post, { selected_follower_ids: [selected.account.id] });
			await expect(selected.page.locator('.discussion-view')).toContainText(post.body);
			await privacy(owner, 'private');
			await http(selected, 'get', `/api/v1/posts/${post.id}`);
			await privacy(owner, 'public');
			await http(outsider, 'get', `/api/v1/posts/${post.id}`, undefined, 404);
			post = await edit(owner, post, { audience: 'public' });
			await http(outsider, 'get', `/api/v1/posts/${post.id}`);
			await privacy(owner, 'private');
			await http(outsider, 'get', `/api/v1/posts/${post.id}`, undefined, 404);
			await privacy(owner, 'public');
			await http(outsider, 'get', `/api/v1/posts/${post.id}`);
		} finally {
			await dispose(all);
		}
	});

	test('draft publication retains nested discussions, toggled reactions, activity and hidden notice state', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Owner', 'Follower']);
		const [owner, follower] = all;
		try {
			await follow(follower, owner);
			let post = await create(owner, { status: 'draft', body: '', title: null });
			await http(follower, 'get', `/api/v1/posts/${post.id}`, undefined, 404);
			post = await edit(owner, post, {
				body: 'Published draft',
				status: 'published',
				category_ids: [1],
			});
			const comment = (
				await http(
					follower,
					'post',
					`/api/v1/posts/${post.id}/comments`,
					{ body: 'Parent comment' },
					201,
				)
			).data;
			const child = (
				await http(
					owner,
					'post',
					`/api/v1/posts/${post.id}/comments`,
					{ body: 'Nested reply', parent_comment_id: comment.id },
					201,
				)
			).data;
			const revised = (
				await http(follower, 'patch', `/api/v1/comments/${comment.id}`, {
					body: 'Edited parent',
					expected_version: comment.version,
				})
			).data;
			for (const target of [`posts/${post.id}`, `comments/${comment.id}`]) {
				for (const [action, reaction] of [
					['like', 1],
					['like', 0],
					['dislike', -1],
					['like', 1],
				]) {
					const result = await http(owner, 'post', `/api/v1/${target}/${action}`);
					expect(result.data.reaction).toBe(reaction);
				}
			}
			await http(follower, 'post', `/api/v1/posts/${post.id}/like`);
			await contains(follower, '/api/v1/posts/liked', post.id, true);
			const notices = (await http(follower, 'get', '/api/v1/notifications')).data;
			const n = notices.notifications.find((item) => item.target.comment_id === comment.id);
			expect(n).toBeTruthy();
			await follower.page.goto('/feed');
			await panel(follower.page);
			await follower.page.locator(`[data-notice-id="${n.id}"] .notice__context`).click();
			await expect(follower.page).toHaveURL(new RegExp(`/comments/${comment.id}$`));
			await expect(follower.page.locator(`[data-comment-id="${comment.id}"]`)).toContainText(
				'Edited parent',
			);
			post = await edit(owner, post, { status: 'draft' });
			await http(follower, 'get', `/api/v1/comments/${comment.id}`, undefined, 404);
			await contains(follower, '/api/v1/posts/liked', post.id, false);
			expect(
				(await http(follower, 'get', '/api/v1/notifications')).data.notifications.some(
					(item) => item.id === n.id,
				),
			).toBe(false);
			await http(follower, 'patch', '/api/v1/notifications/read-all', undefined, 204);
			post = await edit(owner, post, { status: 'published' });
			const restored = (
				await http(follower, 'get', '/api/v1/notifications')
			).data.notifications.find((item) => item.id === n.id);
			expect(restored).toEqual(n);
			expect((await http(owner, 'get', `/api/v1/comments/${comment.id}`)).data).toMatchObject({
				body: 'Edited parent',
				likes: 1,
			});
			await http(follower, 'get', `/api/v1/comments/${child.id}`);
			await follower.page.goto('/activity');
			await follower.page.getByRole('button', { name: 'Comments', exact: true }).click();
			await expect(follower.page.locator('main')).toContainText('Edited parent');
			await http(
				follower,
				'delete',
				`/api/v1/comments/${comment.id}?expected_version=${revised.version}`,
				undefined,
				204,
			);
			await http(owner, 'get', `/api/v1/comments/${child.id}`, undefined, 404);
		} finally {
			await dispose(all);
		}
	});
});

test('SN-A14 selected grants, draft discussions and attachment bytes survive recreation', async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(180000);
	if (!/^sn-b07-test-\d+$/u.test(process.env.COMPOSE_PROJECT_NAME || ''))
		throw new Error('Requires isolated B07 stack');
	const all = await actors(browser, baseURL, ['Owner', 'Selected', 'Unselected']);
	const [owner, selected, unselected] = all;
	try {
		await follow(selected, owner);
		await follow(unselected, owner);
		let post = await upload(owner, '/api/v1/posts', {
			audience: 'selected',
			selected_follower_ids: String(selected.account.id),
		});
		const comment = await upload(selected, `/api/v1/posts/${post.id}/comments`);
		await http(selected, 'post', `/api/v1/posts/${post.id}/dislike`);
		post = await edit(owner, post, { status: 'draft' });
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
		expect((await http(owner, 'get', `/api/v1/posts/${post.id}`)).data).toEqual(post);
		expect(await (await owner.context.request.get(post.image_url)).body()).toEqual(png);
		await http(selected, 'get', `/api/v1/comments/${comment.id}`, undefined, 404);
		post = await edit(owner, post, { status: 'published' });
		expect((await http(selected, 'get', `/api/v1/posts/${post.id}`)).data).toMatchObject({
			dislikes: 1,
			my_reaction: -1,
		});
		await http(unselected, 'get', `/api/v1/posts/${post.id}`, undefined, 404);
		expect(await (await selected.context.request.get(comment.image_url)).body()).toEqual(png);
		const response = await owner.context.request.patch(`/api/v1/posts/${post.id}`, {
			multipart: {
				expected_version: String(post.version),
				image: { name: 'replacement.png', mimeType: 'image/png', buffer: png },
			},
		});
		expect(response.status()).toBe(200);
		const replaced = (await response.json()).data;
		expect(replaced.image_url).not.toBe(post.image_url);
		expect((await owner.context.request.get(post.image_url)).status()).toBe(404);
		expect(await (await selected.context.request.get(replaced.image_url)).body()).toEqual(png);
		const removed = await edit(owner, replaced, { body: 'Text remains', remove_image: true });
		expect(removed.image_url).toBeNull();
		expect((await owner.context.request.get(replaced.image_url)).status()).toBe(404);
		await http(
			owner,
			'delete',
			`/api/v1/posts/${post.id}?expected_version=${removed.version}`,
			undefined,
			204,
		);
		await http(selected, 'get', `/api/v1/comments/${comment.id}`, undefined, 404);
		expect((await selected.context.request.get(comment.image_url)).status()).toBe(404);
	} finally {
		await dispose(all);
	}
});

for (const [label, viewport] of [
	['desktop', { width: 1280, height: 900 }],
	['360px', { width: 360, height: 800 }],
]) {
	test(`SN-A14 keyboard publishing, discussions and session cleanup at ${label}`, async ({
		browser,
		baseURL,
	}) => {
		test.setTimeout(90000);
		const all = await actors(browser, baseURL, ['Owner', 'Selected']);
		const [owner, selected] = all;
		try {
			await follow(selected, owner);
			await owner.page.setViewportSize(viewport);
			await owner.page.goto('/posts/new');
			await owner.page.getByLabel('Title').fill(`Keyboard ${owner.name}`);
			await owner.page.getByLabel('Post', { exact: true }).fill('Real selected publication');
			await owner.page.getByRole('radio', { name: /^Selected followers/u }).check();
			await owner.page.getByRole('checkbox', { name: selected.name }).focus();
			await owner.page.keyboard.press('Space');
			await owner.page.getByRole('button', { name: 'Publish', exact: true }).focus();
			await owner.page.keyboard.press('Enter');
			await expect(owner.page).toHaveURL(/\/feed$/u);
			const mine = (await http(owner, 'get', '/api/v1/posts/mine')).data;
			const post = mine.find((item) => item.title === `Keyboard ${owner.name}`);
			expect(post.audience).toBe('selected');
			await selected.page.setViewportSize(viewport);
			await selected.page.goto(`/posts/${post.id}`);
			await selected.page.getByLabel('Your comment', { exact: true }).fill('Real keyboard comment');
			await selected.page.getByRole('button', { name: 'Send comment' }).focus();
			await selected.page.keyboard.press('Enter');
			await expect(selected.page.locator('[data-comment-id]')).toContainText(
				'Real keyboard comment',
			);
			expect(
				await selected.page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				),
			).toBeLessThanOrEqual(0);
			await selected.page.screenshot({ path: `.tmp/a14-${label}.png`, fullPage: true });
			await selected.page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await expect(selected.page).toHaveURL(/\/login$/u);
			await selected.page.goBack();
			await expect(selected.page.locator('[data-comment-id]')).toHaveCount(0);
			await selected.page.goto(`/posts/${post.id}`);
			await expect(selected.page).toHaveURL(/\/login\?redirect=/u);
		} finally {
			await dispose(all);
		}
	});
}

test('SN-A14 real editor saves incomplete drafts, rejects stale edits and publishes retained text', async ({
	browser,
	baseURL,
}) => {
	const all = await actors(browser, baseURL, ['Owner', 'Outsider']);
	const [owner, outsider] = all;
	try {
		await owner.page.goto('/posts/new');
		await owner.page.getByLabel('Title').fill(`Draft ${owner.name}`);
		await owner.page.getByRole('button', { name: 'Save as draft' }).click();
		await expect(owner.page).toHaveURL(/\/posts\/\d+\/edit$/u);
		const id = Number(new URL(owner.page.url()).pathname.split('/')[2]);
		await owner.page.getByLabel('Post', { exact: true }).fill('Saved real draft body');
		await owner.page.getByRole('button', { name: 'Save draft', exact: true }).click();
		await expect(owner.page.getByText('Draft saved.', { exact: true })).toBeVisible();
		await owner.page.reload();
		await expect(owner.page.getByLabel('Post', { exact: true })).toHaveValue(
			'Saved real draft body',
		);
		await http(outsider, 'get', `/api/v1/posts/${id}`, undefined, 404);
		await owner.page.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(
			owner.page.getByText('Published. It’s now visible to its audience.'),
		).toBeVisible();
		const published = (await http(owner, 'get', `/api/v1/posts/${id}`)).data;
		await http(outsider, 'get', `/api/v1/posts/${id}`);
		await owner.page.getByLabel('Post', { exact: true }).fill('Edited through the real editor');
		await owner.page.getByRole('button', { name: 'Save changes', exact: true }).click();
		await expect(owner.page.getByText('Changes saved.', { exact: true })).toBeVisible();
		await http(
			owner,
			'patch',
			`/api/v1/posts/${id}`,
			{ expected_version: published.version, body: 'Stale overwrite' },
			409,
		);
		expect((await http(outsider, 'get', `/api/v1/posts/${id}`)).data.body).toBe(
			'Edited through the real editor',
		);
		await owner.page.getByRole('button', { name: 'Move to drafts' }).click();
		await expect(owner.page.getByText('Moved to drafts. Only you can see it now.')).toBeVisible();
		await http(outsider, 'get', `/api/v1/posts/${id}`, undefined, 404);
		await owner.page.getByRole('button', { name: 'Delete draft' }).click();
		await owner.page.getByRole('button', { name: 'Delete permanently' }).click();
		await expect(owner.page).toHaveURL(/\/posts\/mine$/u);
		await http(owner, 'get', `/api/v1/posts/${id}`, undefined, 404);
	} finally {
		await dispose(all);
	}
});

test('SN-A14 hidden totals, category projections and navigation filter before paging', async ({
	browser,
	baseURL,
}) => {
	const all = await actors(browser, baseURL, ['Owner', 'Selected', 'Outsider']);
	const [owner, selected, outsider] = all;
	try {
		await follow(selected, owner);
		const first = await create(owner, { category_ids: [1] });
		const hidden = await create(owner, {
			audience: 'selected',
			selected_follower_ids: [selected.account.id],
			category_ids: [1],
		});
		const last = await create(owner, { category_ids: [1] });
		const baseline = (await http(outsider, 'get', '/api/v1/posts?category_id=1&per_page=1')).meta
			.pagination.total;
		const visible = (await http(selected, 'get', '/api/v1/posts?category_id=1&per_page=1')).meta
			.pagination.total;
		expect(visible).toBe(baseline + 1);
		const nav = (await http(outsider, 'get', `/api/v1/posts/${first.id}/nav?category_id=1`)).data;
		expect([nav.prev_id, nav.next_id]).toContain(last.id);
		expect([nav.prev_id, nav.next_id]).not.toContain(hidden.id);
		const categories = (await http(outsider, 'get', '/api/v1/categories/view')).data;
		expect(categories.flatMap((item) => item.posts).some((item) => item.id === hidden.id)).toBe(
			false,
		);
		await edit(owner, hidden, { audience: 'public' });
		expect(
			(await http(outsider, 'get', '/api/v1/posts?category_id=1&per_page=1')).meta.pagination.total,
		).toBe(baseline + 1);
		const restored = (await http(outsider, 'get', `/api/v1/posts/${first.id}/nav?category_id=1`))
			.data;
		expect([restored.prev_id, restored.next_id]).toContain(hidden.id);
	} finally {
		await dispose(all);
	}
});
