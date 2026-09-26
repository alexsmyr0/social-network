import { expect, test } from '@playwright/test';

test.describe('SN-A03 framework shell', () => {
	test('supports direct entry, refresh and browser history on retained routes', async ({
		page,
	}) => {
		await page.goto('/login');
		await expect(page.locator('[data-screen="login"]')).toBeVisible();
		await expect(page).toHaveTitle('Sign in · Commonplace');

		await page.reload();
		await expect(page.locator('[data-screen="login"]')).toBeVisible();

		await page.getByRole('link', { name: 'New here? Create an account' }).click();
		await expect(page).toHaveURL(/\/register$/);
		await expect(page.locator('[data-screen="register"]')).toBeVisible();

		await page.goBack();
		await expect(page).toHaveURL(/\/login$/);
		await page.goForward();
		await expect(page).toHaveURL(/\/register$/);
	});

	test('reaches backend health through the same-origin proxy', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByText('Backend connected')).toBeVisible();
		const healthResponse = await page.request.get('/api/v1/health');

		expect(healthResponse.status()).toBe(200);
		expect(await healthResponse.json()).toMatchObject({ data: { status: 'ok' } });
	});

	test('surfaces transport failure and recovers through retry', async ({ page }) => {
		await page.route('**/api/v1/health', (route) => route.abort());
		await page.goto('/');
		await expect(page.getByRole('alert')).toContainText('Connection interrupted');

		await page.unroute('**/api/v1/health');
		await page.getByRole('button', { name: 'Retry' }).click();
		await expect(page.getByText('Backend connected')).toBeVisible();
	});

	test('keeps missing and retired routes explicit while missing assets stay 404', async ({
		page,
		request,
	}) => {
		await page.goto('/posts/42');
		await expect(page).toHaveURL(/\/posts\/42$/);
		await expect(page.locator('[data-screen="route-unavailable"]')).toContainText(
			'This forum route is resting.',
		);

		const missingAsset = await request.get('/assets/definitely-missing.js', {
			failOnStatusCode: false,
		});
		expect(missingAsset.status()).toBe(404);
		expect(await missingAsset.text()).not.toContain('<!DOCTYPE html>');
	});

	test('is keyboard-usable without horizontal overflow at 360px', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 800 });
		await page.goto('/');

		await page.keyboard.press('Tab');
		await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

		const width = await page.evaluate(() => ({
			client: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth,
		}));
		expect(width.scroll).toBeLessThanOrEqual(width.client);
		await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
	});
	test('completes registration against a contract fixture on desktop', async ({ page }) => {
		await page.route('**/api/v1/users/register', async (route) => {
			const request = route.request();
			expect(request.method()).toBe('POST');
			expect(request.headers()['x-requested-with']).toBe('XMLHttpRequest');
			const payload = request.postDataJSON();
			expect(payload).toMatchObject({
				email: 'alex@example.com',
				first_name: 'Alex',
				last_name: 'Example',
				date_of_birth: '1998-03-14',
				nickname: null,
				about_me: null,
			});
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ data: { id: 42, display_name: 'Alex Example' } }),
			});
		});
		await page.goto('/register');
		await page.getByLabel('Email *').fill('alex@example.com');
		await page.getByLabel('Password *').fill('correct horse battery');
		await page.getByLabel('First name *').fill('Alex');
		await page.getByLabel('Last name *').fill('Example');
		await page.getByLabel('Date of birth *').fill('1998-03-14');
		await page.getByRole('button', { name: 'Create my account' }).click();

		await expect(page.locator('.registration-success')).toContainText('Welcome, Alex Example');
	});

	test('keeps the registration form keyboard-usable without 360px overflow', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 800 });
		await page.goto('/register');
		await page.keyboard.press('Tab');
		await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();

		const width = await page.evaluate(() => ({
			client: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth,
		}));
		expect(width.scroll).toBeLessThanOrEqual(width.client);
		await expect(page.getByRole('button', { name: 'Create my account' })).toBeVisible();
	});

	test('recovers a lost registration response from /users/me without resubmitting', async ({
		page,
	}) => {
		let registrations = 0;
		await page.route('**/api/v1/users/register', async (route) => {
			registrations += 1;
			await route.abort('connectionreset');
		});
		await page.route('**/api/v1/users/me', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: { id: 42, display_name: 'Alex Example' } }),
			}),
		);
		await page.goto('/register');
		await page.getByLabel('Email *').fill('alex@example.com');
		await page.getByLabel('Password *').fill('correct horse battery');
		await page.getByLabel('First name *').fill('Alex');
		await page.getByLabel('Last name *').fill('Example');
		await page.getByLabel('Date of birth *').fill('1998-03-14');
		await page.getByRole('button', { name: 'Create my account' }).click();

		const success = page.locator('.registration-success');
		await expect(success).toContainText('Welcome, Alex Example');
		await expect(success).toHaveAttribute('data-recovered-by', 'session');
		expect(registrations).toBe(1);
	});

	test('shows a visible keyboard focus ring on the avatar control', async ({ page }) => {
		await page.goto('/register');
		const label = page.locator('label.file-button');
		const outline = () => label.evaluate((node) => getComputedStyle(node).outlineStyle);

		const chooser = page.waitForEvent('filechooser');
		await label.click();
		await chooser;
		expect(await outline()).toBe('none');

		await page.getByLabel('Nickname').focus();
		await page.keyboard.press('Shift+Tab');
		await expect(page.locator('#register-avatar')).toBeFocused();
		expect(await outline()).toBe('solid');
	});
});
