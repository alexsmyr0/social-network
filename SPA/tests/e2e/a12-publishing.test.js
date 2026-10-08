import path from 'node:path';

import { expect, test } from '@playwright/test';

import { ContentBackend, pngBytes, readForm } from '../fixtures/phase3/content-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application against the
// owner-approved SN-B14 contract model. SN-A14 owns real-service persistence,
// authorization and container acceptance.
const IMAGE = path.resolve('SPA/tests/fixtures/a07/avatar.png');

async function install(page, backend, viewer = { id: 42 }) {
	const sockets = [];
	const uploads = [];
	await page.routeWebSocket('**/ws', (socket) => {
		sockets.push(socket);
	});
	await page.route('**/api/v1/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const type = req.headers()['content-type'] ?? '';
		let json;
		let form;
		if (type.startsWith('multipart/form-data')) {
			const data = await new Response(req.postDataBuffer(), {
				headers: { 'content-type': type },
			}).formData();
			form = await readForm(data);
			// Chromium interception omits uploaded file bytes, so record the part
			// the browser sent and model it as the chosen fixture image. Byte
			// validation is covered by the unit-level fixture replay.
			if (form.image) {
				uploads.push({ name: form.image.name, type: form.image.type });
				const bytes = pngBytes();
				form.image = { ...form.image, bytes, size: bytes.length };
			}
		} else if (req.postData()) {
			json = JSON.parse(req.postData());
		}
		const headers = { 'X-Requested-With': req.headers()['x-requested-with'] };
		const result = backend.request(viewer.id, req.method(), `${url.pathname}${url.search}`, {
			json,
			form,
			headers,
		});
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: result.bytes ? 'image/png' : 'application/json',
			body: result.bytes ?? (result.body ? JSON.stringify(result.body) : ''),
		});
	});
	return { sockets, viewer, uploads };
}

const card = (page, id) => page.locator(`[data-post-id="${id}"]`);

async function noHorizontalOverflow(page) {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
}

test.describe('SN-A12 fixture-backed feeds and publishing', () => {
	test('publishes by keyboard to selected followers, then the recipient alone sees it', async ({
		page,
	}) => {
		const backend = new ContentBackend();
		const { viewer } = await install(page, backend);
		await page.goto('/feed');
		await page.getByRole('link', { name: 'Write a post' }).click();
		await expect(page.getByRole('radio', { name: /^Public/u })).toBeChecked();
		await page.getByLabel('Title').focus();
		await page.keyboard.type('Weekend plans');
		await page.keyboard.press('Tab');
		await expect(page.getByLabel('Post', { exact: true })).toBeFocused();
		await page.keyboard.type('Only for Sam.');
		await page.getByRole('radio', { name: /^Public/u }).focus();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('radio', { name: /^Selected followers/u })).toBeChecked();
		await page.getByRole('checkbox', { name: 'Sam Example' }).focus();
		await page.keyboard.press('Space');
		await expect(page.getByText('1 follower selected')).toBeVisible();
		await page.getByRole('button', { name: 'Publish' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/feed$/u);
		await expect(
			page.getByRole('status').filter({ hasText: 'Your post is published.' }),
		).toBeVisible();
		await expect(card(page, 102)).toContainText('Shared with 1 selected follower.');
		expect(backend.posts.get(102).selected_follow_ids).toEqual([72]);

		for (const [id, visible] of [
			[8, 1],
			[7, 0],
			[99, 0],
		]) {
			viewer.id = id;
			await page.goto('/feed');
			await expect(page.locator('.social-status').first()).toContainText('post');
			await expect(card(page, 102)).toHaveCount(visible);
		}
		viewer.id = 8;
		await page.goto('/feed');
		await expect(card(page, 102)).not.toContainText('Shared with');
	});

	test('uploads an image-only post with preview, removal and replacement', async ({ page }) => {
		const backend = new ContentBackend();
		const { uploads } = await install(page, backend);
		await page.goto('/posts/new');
		await page.locator('#compose-image').setInputFiles(IMAGE);
		await expect(page.getByAltText('Preview of the image you chose')).toBeVisible();
		await page.getByRole('button', { name: 'Remove selected image' }).click();
		await expect(page.getByAltText('Preview of the image you chose')).toHaveCount(0);
		await page.getByRole('button', { name: 'Publish' }).click();
		await expect(
			page.getByText('Write something or add an image before publishing.').first(),
		).toBeVisible();
		await page.locator('#compose-image').setInputFiles(IMAGE);
		await page.getByRole('button', { name: 'Publish' }).click();
		await expect(page).toHaveURL(/\/feed$/u);
		const image = card(page, 102).getByRole('img', { name: 'Image shared by Alex Example' });
		await expect(image).toBeVisible();
		expect(await image.evaluate((node) => node.naturalWidth)).toBeGreaterThan(0);
		expect(backend.posts.get(102)).toMatchObject({ body: '', image_url: '/api/v1/media/403' });
		expect(uploads).toEqual([{ name: 'avatar.png', type: 'image/png' }]);
	});

	test('drafts persist across reloads, publish, unpublish and delete by keyboard', async ({
		page,
	}) => {
		const backend = new ContentBackend();
		await install(page, backend);
		await page.goto('/posts/new');
		await page.getByLabel('Title').fill('Half-written');
		await page.getByRole('button', { name: 'Save as draft' }).click();
		await expect(page).toHaveURL(/\/posts\/102\/edit$/u);
		await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
		await page.getByLabel('Post', { exact: true }).fill('Now finished.');
		await page.getByRole('button', { name: 'Save draft' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
		await page.reload();
		await expect(page.getByLabel('Post', { exact: true })).toHaveValue('Now finished.');
		await page.getByRole('button', { name: 'Publish' }).click();
		await expect(page.getByText('Published. It’s now visible to its audience.')).toBeVisible();
		await page.getByRole('button', { name: 'Move to drafts' }).click();
		await expect(page.getByText('Moved to drafts. Only you can see it now.')).toBeVisible();
		expect(backend.posts.get(102)).toMatchObject({
			status: 'draft',
			title: 'Half-written',
			version: 4,
		});

		await page.goto('/posts/new');
		await expect(page.locator('[data-latest-draft]')).toContainText('“Half-written”');
		await page.getByRole('link', { name: 'Continue that draft' }).click();
		await page.getByRole('button', { name: 'Delete draft' }).focus();
		await page.keyboard.press('Enter');
		await page.getByRole('button', { name: 'Delete permanently' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/posts\/mine$/u);
		await expect(page.getByText('Draft deleted.')).toBeVisible();
		expect(backend.posts.has(102)).toBe(false);
	});

	test('filters, paging and direct links recover to permitted states', async ({ page }) => {
		const backend = new ContentBackend();
		for (let index = 0; index < 22; index += 1) {
			backend.addPost({
				id: 300 + index,
				author_id: index % 2 ? 99 : 42,
				body: `Item ${index}`,
				categories: index % 3 ? [] : [{ id: 1, name: 'General' }],
				created_at: `2026-10-06T13:${String(index).padStart(2, '0')}:00Z`,
			});
		}
		const { viewer } = await install(page, backend, { id: 7 });
		await page.goto('/feed?feed=bogus&category=abc&unknown=1');
		await expect(page).toHaveURL(/\/feed$/u);
		await expect(page.locator('.social-status')).toHaveText('23 posts');
		await page.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(/\/feed\?page=2$/u);
		await expect(page.locator('[data-post-id]')).toHaveCount(3);
		await page.getByRole('link', { name: 'Following', exact: true }).click();
		await expect(page).toHaveURL(/\/feed\?feed=following$/u);
		await expect(page.locator('.social-status')).toHaveText('12 posts from people you follow');
		await page.locator('.category-filter').getByRole('link', { name: 'General' }).click();
		await expect(page).toHaveURL(/\/feed\?feed=following&category=1$/u);
		await expect(page.locator('.social-status')).toHaveText(
			'4 posts from people you follow in General',
		);
		await page.reload();
		await expect(page.locator('.category-filter [aria-current="page"]')).toHaveText('General');

		await page.goto('/posts/101/edit');
		await expect(
			page.getByRole('heading', { name: 'You can only edit your own posts.' }),
		).toBeVisible();
		viewer.id = 42;
		await page.goto('/posts/999/edit');
		await expect(
			page.getByRole('heading', { name: 'This post isn’t available to edit.' }),
		).toBeVisible();
	});

	test('a permission signal removes a revoked selected post without a reload', async ({ page }) => {
		const backend = new ContentBackend();
		backend.addPost({ id: 102, title: 'For Ada', audience: 'selected', selected_follow_ids: [71] });
		const { sockets } = await install(page, backend, { id: 7 });
		await page.goto('/feed');
		await expect(card(page, 102)).toBeVisible();
		backend.request(42, 'PATCH', '/api/v1/posts/102', {
			json: { expected_version: 1, selected_follower_ids: [8] },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await expect.poll(() => sockets.length).toBeGreaterThan(0);
		sockets.at(-1).send('{"type":"social.invalidate"}');
		await expect(card(page, 102)).toHaveCount(0);
		await expect(card(page, 101)).toBeVisible();
	});

	for (const [label, viewport] of [
		['360px', { width: 360, height: 800 }],
		['desktop', { width: 1280, height: 900 }],
	]) {
		test(`feed and composer fit ${label} with 44px controls`, async ({ page }) => {
			const backend = new ContentBackend();
			backend.addPost({
				id: 102,
				title: 'A-very-long-title-without-any-spaces-that-must-wrap-inside-the-card',
				body: 'A body with a long-unbroken-token-that-also-needs-to-wrap-cleanly-on-small-screens',
				audience: 'selected',
				selected_follow_ids: [71],
				categories: [{ id: 1, name: 'General' }],
			});
			await page.setViewportSize(viewport);
			await install(page, backend);
			await page.goto('/feed');
			await expect(card(page, 102)).toBeVisible();
			expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
			await page.screenshot({ path: `.tmp/a12-feed-${label}.png`, fullPage: true });

			await page.goto('/posts/102/edit');
			await expect(page.getByRole('checkbox', { name: 'Ada Lovelace' })).toBeChecked();
			expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
			for (const control of await page
				.locator(
					'.post-form button, .post-form .file-button, .audience-option, .choice-chip, .recipient',
				)
				.all()) {
				const box = await control.boundingBox();
				expect(box.height).toBeGreaterThanOrEqual(43.5);
			}
			await page.screenshot({ path: `.tmp/a12-editor-${label}.png`, fullPage: true });
		});
	}
});
