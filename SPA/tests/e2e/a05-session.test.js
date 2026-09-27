import { expect, test } from '@playwright/test';

const account = {
	id: 42,
	email: 'alex@example.com',
	first_name: 'Alex',
	last_name: 'Example',
	date_of_birth: '1998-03-14',
	nickname: null,
	about_me: null,
	display_name: 'Alex Example',
	avatar_url: null,
};

function json(route, status, body) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('SN-A05 fixture-backed session UI', () => {
	test('gates a deep link, signs in, reports logout failure, then prevents protected replay', async ({
		page,
	}) => {
		await page.route('**/api/v1/users/me', (route) =>
			json(route, 401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
		);
		let loginAttempts = 0;
		await page.route('**/api/v1/users/login', async (route) => {
			loginAttempts += 1;
			expect(route.request().headers()['x-requested-with']).toBe('XMLHttpRequest');
			expect(route.request().postDataJSON()).toEqual({
				email: 'alex@example.com',
				password: 'correct horse battery',
			});
			if (loginAttempts === 1) {
				await json(route, 401, {
					error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
				});
				return;
			}
			await json(route, 200, { data: account });
		});
		let logoutAttempts = 0;
		await page.route('**/api/v1/users/logout', async (route) => {
			logoutAttempts += 1;
			if (logoutAttempts === 1) {
				await json(route, 503, {
					error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again' },
				});
				return;
			}
			await json(route, 200, { data: { message: 'Logged out' } });
		});

		await page.goto('/');
		await expect(page).toHaveURL(/\/login\?redirect=\/$/);
		await expect(page.locator('[data-screen="home"]')).toHaveCount(0);
		await page.getByLabel('Email').fill('alex@example.com');
		await page.getByLabel('Password').fill('correct horse battery');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toContainText('wasn’t recognized');
		await expect(page.getByLabel('Password')).toHaveValue('correct horse battery');

		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(page.locator('[data-screen="home"]')).toContainText('Alex Example');
		await page.evaluate(() => history.pushState({}, '', '/?from=protected'));

		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page.getByRole('alert')).toContainText('still shown as signed in');
		await expect(page.locator('[data-screen="home"]')).toBeVisible();
		await page.getByRole('button', { name: 'Try sign out again' }).click();
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.locator('[data-screen="home"]')).toHaveCount(0);

		await page.goBack();
		await expect(page).toHaveURL(/\/login\?redirect=/);
		await expect(page.locator('[data-screen="home"]')).toHaveCount(0);
	});

	test('restores a session and keeps logout accessible without mobile overflow', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 360, height: 800 });
		await page.route('**/api/v1/users/me', (route) => json(route, 200, { data: account }));
		await page.goto('/login');

		await expect(page).toHaveURL(/\/$/);
		await expect(page.locator('[data-screen="home"]')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
		const width = await page.evaluate(() => ({
			client: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth,
		}));
		expect(width.scroll).toBeLessThanOrEqual(width.client);
	});

	test('keeps protected content hidden during outage and recovers without calling it logout', async ({
		page,
	}) => {
		let checks = 0;
		await page.route('**/api/v1/users/me', async (route) => {
			checks += 1;
			if (checks === 1) {
				await json(route, 503, {
					error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again' },
				});
				return;
			}
			await json(route, 200, { data: account });
		});

		await page.goto('/');
		await expect(page).toHaveURL(/\/$/);
		await expect(page.locator('[data-screen="home"]')).toHaveCount(0);
		await expect(page.getByText('Your place is still private.')).toBeVisible();
		await page.getByRole('button', { name: 'Try session again' }).click();
		await expect(page.locator('[data-screen="home"]')).toContainText('Alex Example');
	});
});
