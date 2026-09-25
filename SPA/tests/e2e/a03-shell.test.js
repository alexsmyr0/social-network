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
});
