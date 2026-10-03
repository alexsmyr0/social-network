import { expect, test } from '@playwright/test';

import { contractUsers, FixtureBackend, makeUser } from '../fixtures/phase2/fixture-backend.js';

// SN-A09 is frontend-only: the stateful contract model answers every /api/v1
// call from the browser. Real authorization and persistence are SN-A11.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
	'base64',
);

async function installBackend(page, backend, viewer) {
	await page.route('**/api/v1/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const body = request.postData();
		const result = backend.request(viewer.id, request.method(), `${url.pathname}${url.search}`, {
			json: body ? JSON.parse(body) : undefined,
		});
		if (result.headers['Content-Type'] === 'image/png') {
			await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
			return;
		}
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: 'application/json',
			body: result.body ? JSON.stringify(result.body) : '',
		});
	});
}

async function overflow(page) {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
}

function directory() {
	const crowd = [];
	for (let id = 100; id < 130; id += 1) {
		crowd.push(makeUser(id, { first_name: `Guest${id}`, last_name: 'Longsurname-Example' }));
	}
	const users = contractUsers();
	users[0].avatar_url = '/api/v1/users/7/avatar';
	return new FixtureBackend({ users: [...users, ...crowd] });
}

test.describe('SN-A09 people, profiles and follow controls (fixture-backed)', () => {
	test('searches, follows and cancels by keyboard on desktop', async ({ page }) => {
		const backend = directory();
		await installBackend(page, backend, { id: 7 });
		await page.goto('/people');
		await expect(page.locator('[data-screen="people"]')).toBeVisible();
		await expect(page).toHaveTitle('People · Commonplace');

		await page.getByLabel('Search people by name').fill('alex');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/people\?q=alex$/);
		const row = page.locator('[data-person-id="42"]');
		await expect(row).toContainText('Private profile · name only');
		await expect(row.locator('img')).toHaveCount(0);

		const follow = row.getByRole('button', { name: 'Follow Alex Example' });
		await follow.focus();
		await page.keyboard.press('Enter');
		await expect(row).toContainText('Request pending');
		const cancel = row.getByRole('button', { name: 'Cancel follow request to Alex Example' });
		await expect(cancel).toBeFocused();
		await page.keyboard.press('Space');
		await expect(row.getByRole('button', { name: 'Follow Alex Example' })).toBeVisible();
		expect(backend.follows).toEqual([]);
	});

	test('keeps a name-only teaser free of private details across reload and history', async ({
		page,
	}) => {
		const backend = directory();
		await installBackend(page, backend, { id: 7 });
		const avatarRequests = [];
		page.on('request', (request) => {
			if (request.url().endsWith('/users/42/avatar')) avatarRequests.push(request.url());
		});

		await page.goto('/users/42');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alex Example');
		await expect(page.locator('[data-state="teaser"]')).toBeVisible();
		await page.reload();
		await expect(page.locator('[data-state="teaser"]')).toBeVisible();
		const bodyText = await page.locator('main').innerText();
		for (const hidden of ['alex@example.com', '1998', 'followers', 'About']) {
			expect(bodyText).not.toContain(hidden);
		}
		expect(avatarRequests).toEqual([]);

		await page.getByRole('link', { name: 'People', exact: true }).click();
		await expect(page).toHaveURL(/\/people$/);
		await page.goBack();
		await expect(page.locator('[data-state="teaser"]')).toBeVisible();
	});

	test('reveals details only after the owner accepts, then removes them on unfollow', async ({
		page,
	}) => {
		const backend = directory();
		await installBackend(page, backend, { id: 7 });
		await page.goto('/users/42');
		await page.getByRole('button', { name: 'Follow Alex Example' }).click();
		await expect(page.locator('.follow-control')).toContainText('Request pending');
		await expect(page.locator('main')).not.toContainText('alex@example.com');

		backend.request(42, 'PATCH', '/api/v1/follow-requests/201', { json: { decision: 'accept' } });
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.locator('.profile-details')).toContainText('alex@example.com');
		await expect(page.locator('.avatar img')).toHaveAttribute('src', '/api/v1/users/42/avatar');

		await page.getByRole('button', { name: 'Unfollow Alex Example' }).click();
		await expect(page.locator('[data-state="teaser"]')).toBeVisible();
		await expect(page.locator('main')).not.toContainText('alex@example.com');
		await expect(page.locator('.avatar img')).toHaveCount(0);
	});

	test('switches privacy with an explicit confirmation by keyboard', async ({ page }) => {
		const backend = directory();
		backend.follows.push({
			id: 300,
			follower_id: 99,
			followed_id: 42,
			state: 'pending',
			created_at: '2026-10-02T12:00:00Z',
			accepted_at: null,
		});
		await installBackend(page, backend, { id: 42 });
		await page.goto('/users/42');
		await expect(page.locator('[data-visibility]')).toContainText('Private profile');

		const make = page.getByRole('button', { name: 'Make profile public' });
		await make.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('group', { name: 'Make your profile public?' })).toContainText(
			'accepted automatically',
		);
		expect(backend.users.get(42).visibility).toBe('private');
		await page.getByRole('button', { name: 'Make public and accept requests' }).click();
		await expect(page.locator('[data-visibility]')).toContainText('Public profile');
		await expect(page.locator('.profile-counts')).toContainText('1 follower');
		expect(backend.follows[0].state).toBe('accepted');
	});

	test('lists followers with name-only private members and pages through links', async ({
		page,
	}) => {
		const backend = directory();
		for (let id = 100; id < 125; id += 1) {
			backend.follows.push({
				id: 1000 + id,
				follower_id: id,
				followed_id: 7,
				state: 'accepted',
				created_at: '2026-10-02T12:00:00Z',
				accepted_at: '2026-10-02T12:00:00Z',
			});
		}
		await installBackend(page, backend, { id: 7 });
		await page.goto('/users/7/followers');
		await expect(page.locator('.person')).toHaveCount(20);
		await page.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(/followers\?page=2$/);
		await expect(page.locator('.person')).toHaveCount(5);
		await page.goBack();
		await expect(page.locator('.person')).toHaveCount(20);
	});

	for (const [label, size] of [
		['360px', { width: 360, height: 800 }],
		['desktop', { width: 1280, height: 900 }],
	]) {
		test(`has no horizontal overflow and usable targets at ${label}`, async ({ page }) => {
			const backend = directory();
			backend.follows.push({
				id: 300,
				follower_id: 99,
				followed_id: 7,
				state: 'accepted',
				created_at: '2026-10-02T12:00:00Z',
				accepted_at: '2026-10-02T12:00:00Z',
			});
			await page.setViewportSize(size);
			await installBackend(page, backend, { id: 7 });

			for (const path of [
				'/people',
				'/users/42',
				'/users/7',
				'/users/99',
				'/users/7/followers',
				'/users/9999',
			]) {
				await page.goto(path);
				await expect(page.locator('main')).toBeVisible();
				await expect(page.getByText('Loading')).toHaveCount(0);
				expect(await overflow(page), path).toBeLessThanOrEqual(0);
			}

			await page.goto('/people');
			await expect(page.locator('.person').first()).toBeVisible();
			for (const control of await page
				.locator('main button, .site-nav a, .site-nav button')
				.all()) {
				const box = await control.boundingBox();
				expect(box.height).toBeGreaterThanOrEqual(43.5);
			}
			await page.keyboard.press('Tab');
			await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
			await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
		});
	}

	test('shows an honest outage state without protected details, then recovers', async ({
		page,
	}) => {
		const backend = directory();
		backend.follows.push({
			id: 300,
			follower_id: 7,
			followed_id: 42,
			state: 'accepted',
			created_at: '2026-10-02T12:00:00Z',
			accepted_at: '2026-10-02T12:00:00Z',
		});
		await installBackend(page, backend, { id: 7 });
		await page.goto('/users/42');
		await expect(page.locator('.profile-details')).toContainText('alex@example.com');

		await page.route('**/api/v1/users/42/profile', (route) => route.abort());
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.getByRole('alert')).toContainText('We can’t load this profile right now.');
		await expect(page.locator('main')).not.toContainText('alex@example.com');

		await page.unroute('**/api/v1/users/42/profile');
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(page.locator('.profile-details')).toContainText('alex@example.com');
	});

	test('signs out of a revoked session from a social page without leaving stale people', async ({
		page,
	}) => {
		const backend = directory();
		const viewer = { id: 7 };
		await installBackend(page, backend, viewer);
		await page.goto('/people');
		await expect(page.locator('.person').first()).toBeVisible();

		viewer.id = null;
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page).toHaveURL(/\/login\?redirect=\/people$/);
		await expect(page.locator('.person')).toHaveCount(0);
		await expect(page.locator('main')).not.toContainText('Alex Example');
		await page.goBack();
		await expect(page.locator('.person')).toHaveCount(0);
	});
});
