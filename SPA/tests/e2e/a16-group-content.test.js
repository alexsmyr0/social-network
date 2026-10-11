import path from 'node:path';
import { expect, test } from '@playwright/test';

import { installGroupContentFixtures } from '../fixtures/phase4/browser.js';
import { GroupContentBackend } from '../fixtures/phase4/group-content-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application against the
// approved SN-B17 group-content model. SN-A17 owns real-service authorization,
// persistence and media delivery.
const IMAGE = path.resolve('SPA/tests/fixtures/a07/avatar.png');
const postCard = (page, id) => page.locator(`[data-post-id="${id}"]`);
const comment = (page, id) => page.locator(`[data-comment-id="${id}"]`);

async function noHorizontalScroll(page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(1);
}

function groupFeedIds(backend, viewerId) {
	return backend
		.request(viewerId, 'GET', '/api/v1/posts?group_id=301', {})
		.body.data.map((post) => post.id);
}

test.describe('SN-A16 fixture group content', () => {
	test('a member writes, edits and manages a group post by keyboard, with membership as its audience', async ({
		page,
	}) => {
		const backend = new GroupContentBackend();
		await installGroupContentFixtures(page, backend, { id: 7 });
		await page.goto('/groups/301');
		await page.getByRole('link', { name: 'Posts', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/301\/posts$/u);
		await expect(postCard(page, 111).locator('.badge--group')).toHaveText('Group · Chess Club');
		await page.getByRole('link', { name: 'Write a post' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/301\/posts\/new$/u);
		await expect(page.getByText('Members of Chess Club')).toBeVisible();
		await expect(page.getByRole('radio')).toHaveCount(0);
		await page.getByLabel('Title').focus();
		await page.keyboard.type('Saturday blitz');
		await page.getByLabel('Post', { exact: true }).focus();
		await page.keyboard.type('Bring a clock.');
		await page.getByRole('button', { name: 'Publish' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/301\/posts$/u);
		await expect(page.getByText('Your post is published to Chess Club.')).toBeVisible();
		await expect(postCard(page, 122)).toContainText('Saturday blitz');
		expect(backend.posts.get(122)).toMatchObject({
			group_id: 301,
			audience: 'group',
			author_id: 7,
		});
		expect(groupFeedIds(backend, 42)).toContain(122);
		// Editing: the author's own link, no audience picker, only changed fields.
		await postCard(page, 122).getByRole('link', { name: /^Edit/u }).click();
		await expect(page).toHaveURL(/\/posts\/122\/edit$/u);
		await expect(page.getByText('Changes appear to the members of Chess Club')).toBeVisible();
		await expect(page.getByRole('radio')).toHaveCount(0);
		await page.getByLabel('Post', { exact: true }).fill('Bring a clock and a board.');
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByText('Changes saved.')).toBeVisible();
		expect(backend.posts.get(122)).toMatchObject({
			body: 'Bring a clock and a board.',
			version: 2,
		});
		const patch = backend.log.filter((entry) => entry.method === 'PATCH').at(-1);
		expect(patch.json).toEqual({ expected_version: 1, body: 'Bring a clock and a board.' });
	});

	test('drafts stay private to their author, and attachments are replaced then removed', async ({
		page,
	}) => {
		const backend = new GroupContentBackend();
		const { uploads, actAs } = await installGroupContentFixtures(page, backend, { id: 7 });
		await page.goto('/groups/301/posts/new');
		await expect(page.locator('[data-latest-draft]')).toContainText('saved draft in Chess Club');
		await page.getByLabel('Post', { exact: true }).fill('Draft with a picture');
		await page.locator('#compose-image').setInputFiles(IMAGE);
		await expect(page.getByAltText('Preview of the image you chose')).toBeVisible();
		await page.getByRole('button', { name: 'Save as draft' }).click();
		await expect(page).toHaveURL(/\/posts\/122\/edit$/u);
		await expect(
			page.getByText('Only you can see this draft until you publish it to Chess Club.'),
		).toBeVisible();
		expect(backend.posts.get(122)).toMatchObject({ status: 'draft', group_id: 301 });
		// Nobody else, not even the creator, can reach the draft or its picture.
		expect(actAs(42, 'GET', '/posts/122').status).toBe(404);
		expect(actAs(42, 'GET', backend.posts.get(122).image_url.replace('/api/v1', '')).status).toBe(
			404,
		);
		await page.getByRole('button', { name: 'Publish' }).click();
		await expect(page.getByText('Published. It’s now visible to its audience.')).toBeVisible();
		expect(actAs(42, 'GET', '/posts/122').status).toBe(200);
		await page.locator('#edit-image').setInputFiles(IMAGE);
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByText('Changes saved.')).toBeVisible();
		await page.getByRole('button', { name: 'Remove image' }).click();
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByText('Changes saved.')).toBeVisible();
		expect(backend.posts.get(122).image_url).toBeNull();
		expect(uploads).toHaveLength(2);
		await page.getByRole('button', { name: 'Move to drafts' }).click();
		await expect(page.getByText('Moved to drafts. Only you can see it now.')).toBeVisible();
		expect(groupFeedIds(backend, 42)).not.toContain(122);
		expect(groupFeedIds(backend, 7)).toEqual([111, 112]);
	});

	test('a member comments, replies, reacts and attaches an image in a group discussion', async ({
		page,
	}) => {
		const backend = new GroupContentBackend();
		const { uploads } = await installGroupContentFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/posts');
		await postCard(page, 111).getByRole('link', { name: 'Open discussion' }).click();
		await expect(page).toHaveURL(/\/posts\/111\?group=301$/u);
		await expect(page.getByRole('link', { name: 'Back to Chess Club' })).toBeVisible();
		await expect(comment(page, 212)).toContainText('Kim Example');
		await expect(comment(page, 212)).toContainText('Kim comment');
		await comment(page, 211).getByRole('button', { name: 'Reply', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Reply to comment 211', { exact: true })).toBeFocused();
		await page.keyboard.type('Keyboard reply');
		await page.getByRole('button', { name: 'Send comment' }).focus();
		await page.keyboard.press('Enter');
		await expect(comment(page, 214)).toContainText('Keyboard reply');
		expect(backend.comments.get(214).parent_comment_id).toBe(211);
		await page.locator('.comment-form input[type=file]').setInputFiles(IMAGE);
		await page.getByRole('button', { name: 'Send comment' }).click();
		await expect(comment(page, 215).getByRole('img')).toBeVisible();
		expect(uploads).toHaveLength(1);
		const reactions = page.locator('.discussion-view > .discussion-reactions');
		await reactions.getByRole('button', { name: 'Like · 0', exact: true }).click();
		await expect(reactions.getByRole('button', { name: 'Like · 1', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		// Ada is notified of the comment and the like because she is a member.
		const types = [...backend.contentNotices.values()]
			.filter((notice) => notice.recipient_id === 7)
			.map((notice) => notice.type);
		expect(types).toEqual(expect.arrayContaining(['comment', 'post_like']));
		await page.getByRole('link', { name: 'Previous post' }).click();
		await expect(page).toHaveURL(/\/posts\/112\?group=301$/u);
		await expect(page.getByText("Kim's retained post")).toBeVisible();
	});

	test('removal closes open group views, the notice disappears, and fresh admission restores them', async ({
		page,
	}) => {
		const backend = new GroupContentBackend({
			given: {
				notifications: {
					803: {
						id: 803,
						recipient_id: 7,
						actor_id: 42,
						type: 'post_like',
						post_id: 111,
						comment_id: null,
						group_id: null,
						entry_id: null,
						state: null,
						is_read: false,
						created_at: '2026-10-09T12:00:00Z',
					},
				},
				next_ids: { notifications: 804 },
			},
		});
		const { viewer, actAs } = await installGroupContentFixtures(page, backend, { id: 7 });
		const mediaRequests = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/v1/media/')) mediaRequests.push(request.url());
		});
		await page.goto('/groups/301/posts');
		await expect(postCard(page, 111)).toBeVisible();
		await expect(page.locator('.notification-badge')).toHaveText('1');
		actAs(42, 'DELETE', '/group-memberships/502');
		await expect(page.getByText('Only members can read group posts.')).toBeVisible();
		await expect(page.getByText('Group hello')).toHaveCount(0);
		await expect(page.locator('.notification-badge')).toHaveText('0');
		const loadedBefore = mediaRequests.length;
		for (const route of ['/posts/111', '/posts/111/edit', '/groups/301/posts/new', '/feed']) {
			await page.goto(route);
			await expect(page.getByText('Group hello')).toHaveCount(0);
			await expect(page.getByText('Author reply')).toHaveCount(0);
		}
		expect(mediaRequests.length).toBe(loadedBefore);
		// Fresh admission: a new request that the creator accepts. The old
		// invitation (601, cancelled when Ada left) stays gone.
		await page.goto('/groups/301');
		await page.getByRole('button', { name: 'Request to join Chess Club' }).click();
		await expect(page.getByText('Join request pending')).toBeVisible();
		actAs(42, 'PATCH', '/group-join-requests/702', { decision: 'accept' });
		await expect(page.getByRole('button', { name: 'Leave group' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Posts', exact: true })).toBeVisible();
		await page.getByRole('link', { name: 'Posts', exact: true }).click();
		await expect(postCard(page, 111)).toBeVisible();
		expect(backend.invitations.has(601)).toBe(false);
		await expect(page.locator('.notification-badge')).toHaveText('1');
		expect(viewer.id).toBe(7);
	});

	test('a notice for group content opens its discussion, and the departed author reaches nothing', async ({
		page,
	}) => {
		const backend = new GroupContentBackend({
			given: {
				notifications: {
					803: {
						id: 803,
						recipient_id: 7,
						actor_id: 42,
						type: 'comment_like',
						post_id: null,
						comment_id: 211,
						group_id: null,
						entry_id: null,
						state: null,
						is_read: false,
						created_at: '2026-10-09T12:00:00Z',
					},
				},
				next_ids: { notifications: 804 },
			},
		});
		const { viewer } = await installGroupContentFixtures(page, backend, { id: 7 });
		await page.goto('/feed');
		await page.getByRole('button', { name: /^Notifications/u }).click();
		const notice = page.locator('[data-notice-id="803"]');
		await expect(notice).toContainText('Author reply');
		await notice.getByRole('link').last().click();
		await expect(page).toHaveURL(/\/comments\/211$/u);
		await expect(comment(page, 211)).toBeFocused();
		viewer.id = 11;
		for (const route of ['/posts/112', '/posts/112/edit', '/groups/301/posts', '/activity']) {
			await page.goto(route);
			await expect(page.getByText("Kim's retained post")).toHaveCount(0);
			await expect(page.getByText('Kim comment')).toHaveCount(0);
		}
	});

	test('outsiders and account switches see no group content on any route', async ({ page }) => {
		const backend = new GroupContentBackend();
		const { viewer } = await installGroupContentFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/posts');
		await expect(postCard(page, 111)).toBeVisible();
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login/u);
		viewer.id = 99;
		const reads = backend.log.length;
		for (const route of [
			'/groups/301/posts',
			'/groups/301/posts/new',
			'/posts/111',
			'/comments/211',
			'/posts/111/edit',
			'/feed',
			'/activity',
			'/users/7',
		]) {
			await page.goto(route);
			await expect(page.getByText('Group hello')).toHaveCount(0);
			await expect(page.getByText('Author reply')).toHaveCount(0);
			await expect(
				page.getByText('Chess Club', { exact: false }).filter({ hasText: 'Group ·' }),
			).toHaveCount(0);
		}
		expect(backend.log.slice(reads).filter((entry) => entry.method !== 'GET')).toHaveLength(0);
		expect(
			backend.log.slice(reads).some((entry) => /posts\?.*group_id=301/u.test(entry.path)),
		).toBe(false);
	});

	test('outages recover and a missed removal is repaired on reconnect', async ({ page }) => {
		const backend = new GroupContentBackend();
		const { sockets } = await installGroupContentFixtures(page, backend, { id: 7 });
		backend.faults.push({ method: 'GET', path: /\/posts$/u, repeat: true });
		await page.goto('/groups/301/posts');
		await expect(page.getByText('We can’t load this group’s posts right now.')).toBeVisible();
		backend.faults.length = 0;
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(postCard(page, 111)).toBeVisible();
		await expect.poll(() => sockets.length).toBeGreaterThan(0);
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		backend.signals.length = 0;
		await sockets.at(-1).close();
		await expect(page.getByText('Only members can read group posts.')).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText('Group hello')).toHaveCount(0);
	});

	test('360px and desktop layouts wrap long group names and keep 44px controls', async ({
		page,
	}) => {
		const backend = new GroupContentBackend();
		backend.groups.get(301).title = 'Chess'.repeat(18);
		backend.posts.get(111).body = `${'Opening '.repeat(80)}${'x'.repeat(60)}`;
		const { viewer } = await installGroupContentFixtures(page, backend, { id: 7 });
		for (const width of [360, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			viewer.id = 7;
			for (const [name, route] of [
				['posts', '/groups/301/posts'],
				['compose', '/groups/301/posts/new'],
				['discussion', '/posts/111?group=301'],
				['edit', '/posts/111/edit'],
				['feed', '/feed'],
			]) {
				await page.goto(route);
				await expect(page.locator('main h1').first()).toBeVisible();
				await noHorizontalScroll(page);
				for (const control of await page
					.locator('main button, main a.button, main .file-button')
					.all()) {
					if (!(await control.isVisible())) continue;
					expect((await control.boundingBox()).height, `${name} ${width}px`).toBeGreaterThanOrEqual(
						44,
					);
				}
				await page.screenshot({ path: `.tmp/a16-${name}-${width}.png`, fullPage: true });
			}
		}
	});
});
