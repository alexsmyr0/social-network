import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installContentFixtures } from '../fixtures/phase3/browser.js';
import { DiscussionBackend } from '../fixtures/phase3/discussion-backend.js';

const IMAGE = path.resolve('SPA/tests/fixtures/a07/avatar.png');
const comment = (page, id) => page.locator(`[data-comment-id="${id}"]`);
const postReaction = (page) => page.locator('.discussion-view > .discussion-reactions');
async function invalidate(sockets) {
	sockets.at(-1).send(JSON.stringify({ type: 'social.invalidate' }));
}
test.describe('SN-A13 fixture discussions and activity', () => {
	test('keyboard creates a reply, edits it and confirms deletion with server versions', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		await installContentFixtures(page, backend, { id: 7 });
		await page.goto('/posts/101');
		await comment(page, 201).getByRole('button', { name: 'Reply', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Reply to comment 201', { exact: true })).toBeFocused();
		await page.keyboard.type('Keyboard reply');
		await page.getByRole('button', { name: 'Send comment' }).focus();
		await page.keyboard.press('Enter');
		await expect(comment(page, 202)).toContainText('Keyboard reply');
		expect(backend.comments.get(202).parent_comment_id).toBe(201);
		await comment(page, 202).getByRole('button', { name: 'Edit comment', exact: true }).click();
		await comment(page, 202).getByLabel('Edit comment', { exact: true }).fill('Revised reply');
		await comment(page, 202).getByRole('button', { name: 'Save comment' }).click();
		await expect(comment(page, 202)).toContainText('Revised reply');
		expect(backend.comments.get(202).version).toBe(2);
		await comment(page, 202).getByRole('button', { name: 'Delete comment', exact: true }).click();
		await expect(comment(page, 202)).toContainText('and all its replies');
		await comment(page, 202).getByRole('button', { name: 'Confirm deletion' }).click();
		await expect(comment(page, 202)).toHaveCount(0);
		await page.reload();
		await expect(comment(page, 201)).toBeVisible();
		await expect(comment(page, 202)).toHaveCount(0);
	});
	test('image-only comments support preview, replacement and removal with text retained', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		const { uploads } = await installContentFixtures(page, backend, { id: 7 });
		await page.goto('/posts/101');
		await page.locator('.comment-form input[type=file]').setInputFiles(IMAGE);
		await expect(page.getByAltText('Comment attachment preview')).toBeVisible();
		await page.getByRole('button', { name: 'Send comment' }).click();
		await expect(comment(page, 202).getByRole('img')).toBeVisible();
		expect(backend.comments.get(202).body).toBe('');
		const first = backend.comments.get(202).image_url;
		await comment(page, 202).getByRole('button', { name: 'Edit comment', exact: true }).click();
		await comment(page, 202).getByLabel('Edit comment', { exact: true }).fill('With text');
		await comment(page, 202).locator('input[type=file]').setInputFiles(IMAGE);
		await comment(page, 202).getByRole('button', { name: 'Save comment' }).click();
		await expect(comment(page, 202)).toContainText('With text');
		expect(backend.comments.get(202).image_url).not.toBe(first);
		await comment(page, 202).getByRole('button', { name: 'Edit comment', exact: true }).click();
		await comment(page, 202).getByRole('button', { name: 'Remove image' }).click();
		await comment(page, 202).getByRole('button', { name: 'Save comment' }).click();
		await expect(comment(page, 202).getByRole('img')).toHaveCount(0);
		expect(uploads).toHaveLength(2);
	});
	test('post and comment reactions remove and switch without optimistic counts', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		await installContentFixtures(page, backend, { id: 7 });
		await page.goto('/posts/101');
		for (const area of [postReaction(page), comment(page, 201).locator('.discussion-reactions')]) {
			await area.getByRole('button', { name: 'Like · 0', exact: true }).click();
			await expect(area.getByRole('button', { name: 'Like · 1', exact: true })).toHaveAttribute(
				'aria-pressed',
				'true',
			);
			await area.getByRole('button', { name: 'Like · 1', exact: true }).click();
			await expect(area.getByRole('button', { name: 'Like · 0', exact: true })).toHaveAttribute(
				'aria-pressed',
				'false',
			);
			await area.getByRole('button', { name: 'Dislike · 0', exact: true }).click();
			await expect(area.getByRole('button', { name: 'Dislike · 1', exact: true })).toHaveAttribute(
				'aria-pressed',
				'true',
			);
			await area.getByRole('button', { name: 'Like · 0', exact: true }).click();
			await expect(area.getByRole('button', { name: 'Dislike · 0', exact: true })).toHaveAttribute(
				'aria-pressed',
				'false',
			);
		}
		backend.faults.push({ method: 'POST', path: /\/like$/u, commit: true });
		await postReaction(page).getByRole('button', { name: 'Like · 1', exact: true }).click();
		await expect(postReaction(page)).toContainText('could not be confirmed');
		await expect(
			postReaction(page).getByRole('button', { name: 'Like · 0', exact: true }),
		).toHaveAttribute('aria-pressed', 'false');
	});
	test('profile activity stays public-only and private history reuses drafts and filters forbidden parents', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		backend.addPost({
			id: 102,
			body: 'Secret selected',
			audience: 'selected',
			selected_follow_ids: [71],
		});
		backend.addPost({ id: 103, status: 'draft', body: 'Draft secret' });
		backend.reactions.set('7:posts:102', 1);
		const { sockets, viewer } = await installContentFixtures(page, backend, { id: 42 });
		await page.goto('/activity');
		await page.getByLabel('Post status').selectOption('draft');
		await expect(page.locator('[data-post-id]')).toHaveCount(1);
		await page.getByRole('link', { name: 'Continue draft', exact: false }).click();
		await expect(page).toHaveURL(/\/posts\/103\/edit$/u);
		viewer.id = 7;
		await page.goto('/users/42');
		await expect(page.locator('[data-post-id]')).toHaveCount(2);
		await expect(page.getByRole('button', { name: 'Liked', exact: true })).toHaveCount(0);
		await expect(page.getByText('Draft secret', { exact: true })).toHaveCount(0);
		await page.goto('/activity');
		await page.getByRole('button', { name: 'Liked', exact: true }).click();
		await expect(page.getByText('Secret selected', { exact: true })).toBeVisible();
		backend.removeFollow(backend.users.get(7), '71');
		await invalidate(sockets);
		await expect(page.getByText('Secret selected', { exact: true })).toHaveCount(0);
		await expect(page.getByRole('status').filter({ hasText: '0 posts' })).toBeVisible();
	});
	test('notification links open exact comments and permission loss clears targets, totals and media', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		backend.notifications.push({
			id: 501,
			type: 'comment_like',
			recipient_id: 7,
			actor: { id: 42 },
			target: { kind: 'comment', post_id: 101, comment_id: 201, title: null, excerpt: 'Reply' },
			created_at: backend.clock,
			is_read: false,
			actions: [],
		});
		const { sockets } = await installContentFixtures(page, backend, { id: 7 });
		await page.goto('/feed');
		await page.getByRole('button', { name: /Notifications/u }).click();
		await page.locator('[data-notice-id="501"] .notice__context').click();
		await expect(page).toHaveURL(/\/comments\/201$/u);
		await expect(comment(page, 201)).toBeVisible();
		backend.posts.get(101).audience = 'selected';
		backend.posts.get(101).selected_follow_ids = [];
		await invalidate(sockets);
		await expect(page.getByText('This discussion isn’t available.', { exact: true })).toBeVisible();
		await expect(page.locator('[data-comment-id]')).toHaveCount(0);
		await expect(page.locator('.discussion-view img')).toHaveCount(0);
		await page.getByRole('button', { name: /Notifications/u }).click();
		await expect(page.locator('[data-notice-id="501"]')).toHaveCount(0);
		await page.goto('/posts/101');
		await expect(page.getByText('This discussion isn’t available.', { exact: true })).toBeVisible();
	});
	test('navigation, paging and account/logout/back recovery retain no protected state', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		backend.addPost({ id: 102, created_at: '2026-10-06T12:01:00Z' });
		for (let id = 202; id <= 225; id++)
			backend.comments.set(id, { ...backend.comments.get(201), id, body: `Reply ${id}` });
		const { viewer } = await installContentFixtures(page, backend, { id: 7 });
		await page.goto('/posts/101?feed=following');
		await page.getByRole('link', { name: 'Next post', exact: true }).click();
		await expect(page).toHaveURL(/\/posts\/102\?feed=following$/u);
		await page.goBack();
		await expect(comment(page, 201)).toBeVisible();
		await page.getByRole('link', { name: 'Next', exact: true }).click();
		await expect(comment(page, 225)).toBeVisible();
		await page.goto('/comments/225');
		await expect(page.locator('.focused-comment')).toContainText('Reply 225');
		await page.getByLabel('Your comment', { exact: true }).fill('Unsent by Ada');
		viewer.id = 99;
		await page.goto('/posts/101');
		await expect(page.getByLabel('Your comment', { exact: true })).toHaveValue('');
		await expect(page.getByRole('button', { name: 'Edit comment', exact: true })).toHaveCount(0);
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(page).toHaveURL(/\/login$/u);
		await page.goBack();
		await expect(page.locator('[data-screen="discussion"]')).toHaveCount(0);
	});
	test('failed reads and stale edits recover with accessible explicit actions', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		backend.faults.push({ method: 'GET', path: /\/comments$/u, repeat: true });
		await installContentFixtures(page, backend, { id: 7 });
		await page.goto('/posts/101');
		await expect(page.getByRole('alert')).toContainText('We can’t load');
		backend.faults = [];
		await page.getByRole('button', { name: 'Try again', exact: true }).click();
		await expect(comment(page, 201)).toBeVisible();
		await comment(page, 201).getByRole('button', { name: 'Edit comment', exact: true }).click();
		await comment(page, 201).getByLabel('Edit comment', { exact: true }).fill('Unsent');
		backend.comments.get(201).version = 2;
		backend.comments.get(201).body = 'Changed remotely';
		await comment(page, 201).getByRole('button', { name: 'Save comment' }).click();
		await expect(comment(page, 201).getByRole('alert')).toContainText('This comment changed');
		await expect(comment(page, 201).getByLabel('Edit comment', { exact: true })).toHaveValue(
			'Unsent',
		);
		await comment(page, 201).getByRole('button', { name: 'Load latest comment' }).click();
		await expect(comment(page, 201).getByLabel('Edit comment', { exact: true })).toHaveValue(
			'Changed remotely',
		);
	});
	test('360px and desktop discussion/activity layouts wrap long text and retain usable controls', async ({
		page,
	}) => {
		const backend = new DiscussionBackend();
		backend.posts.get(101).body = 'LongWord'.repeat(90);
		backend.comments.get(201).body = 'CommentWord'.repeat(80);
		await installContentFixtures(page, backend, { id: 7 });
		for (const width of [360, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto('/posts/101');
			await expect(comment(page, 201)).toBeVisible();
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				),
			).toBeLessThanOrEqual(1);
			for (const b of await page.locator('.discussion-view button').all())
				expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a13-discussion-${width}.png`, fullPage: true });
			await page.goto('/activity');
			await expect(page.locator('[data-screen="activity-panel"]')).toBeVisible();
			await page.getByRole('button', { name: 'Comments', exact: true }).click();
			await expect(comment(page, 201)).toBeVisible();
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				),
			).toBeLessThanOrEqual(1);
			await page.screenshot({ path: `.tmp/a13-activity-${width}.png`, fullPage: true });
		}
	});
});
