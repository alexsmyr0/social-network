import { expect, test } from '@playwright/test';

import { FixtureBackend, makeUser } from '../fixtures/phase2/fixture-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application. A11 owns
// real-service delivery, persistence, authorization and container acceptance.
function model() {
	const backend = new FixtureBackend();
	backend.users.get(7).visibility = 'private';
	backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	backend.request(99, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	return backend;
}
async function install(page, backend, viewer = { id: 42 }) {
	const sockets = [];
	await page.routeWebSocket('**/ws', (socket) => {
		sockets.push(socket);
	});
	await page.route('**/api/v1/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (url.pathname.endsWith('/users/logout')) {
			viewer.id = null;
			await route.fulfill({ json: { data: { logged_out: true } } });
			return;
		}
		if (url.pathname.endsWith('/users/login')) {
			viewer.id = 99;
			await route.fulfill({ json: { data: backend.account(backend.user(99)) } });
			return;
		}
		const body = req.postData();
		const result = backend.request(viewer.id, req.method(), `${url.pathname}${url.search}`, {
			json: body ? JSON.parse(body) : undefined,
		});
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: 'application/json',
			body: result.body ? JSON.stringify(result.body) : '',
		});
	});
	return { sockets, viewer };
}
const trigger = (page) => page.getByRole('button', { name: /^Notifications/u });
async function open(page) {
	await trigger(page).click();
	await expect(page.getByRole('heading', { name: 'Keeping you posted.' })).toBeFocused();
	await expect(page.locator('[data-notice-id]')).toHaveCount(2);
}
const notice = (page, id) => page.locator(`[data-notice-id="${id}"]`);

test.describe('SN-A10 fixture-backed global notices and request review', () => {
	test('receives a request signal, accepts/declines by keyboard and reads history', async ({
		page,
	}) => {
		const backend = model();
		const { sockets } = await install(page, backend);
		await page.goto('/people');
		await open(page);
		await expect(page.locator('.notice img')).toHaveCount(0);
		await notice(page, 501)
			.getByRole('button', { name: 'Accept follow request from Ada Lovelace' })
			.focus();
		await page.keyboard.press('Enter');
		await expect(notice(page, 501)).toContainText('Request accepted');
		await expect(page.getByRole('heading', { name: 'Keeping you posted.' })).toBeFocused();
		await notice(page, 502)
			.getByRole('button', { name: 'Decline follow request from Robin' })
			.focus();
		await page.keyboard.press('Space');
		await expect(notice(page, 502)).toContainText('Request declined');
		await expect(trigger(page)).toContainText('0');
		backend.request(99, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
		sockets[0].send('{"type":"notification.new"}');
		await expect(notice(page, 503)).toContainText('Wants to follow you');
		await expect(trigger(page)).toContainText('1');
		await page.getByRole('button', { name: 'Mark all read' }).click();
		await expect(trigger(page)).toContainText('0');
		await expect(
			notice(page, 503).getByRole('button', { name: 'Accept follow request from Robin' }),
		).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(trigger(page)).toBeFocused();
		await expect(page.locator('#notification-panel')).toHaveCount(0);
	});

	test('stale decision cannot operate a new request and reconnect catches a missed privacy switch', async ({
		page,
	}) => {
		const backend = model();
		const { sockets } = await install(page, backend);
		await page.goto('/');
		await open(page);
		backend.request(7, 'DELETE', '/api/v1/follows/201');
		backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
		await notice(page, 501)
			.getByRole('button', { name: 'Accept follow request from Ada Lovelace' })
			.click();
		await expect(page.locator('#notification-panel')).toContainText('relationship changed');
		await expect(notice(page, 501)).toContainText('Request cancelled');
		expect(backend.follows.find((f) => f.id === 203).state).toBe('pending');
		sockets[0].close({ code: 1001, reason: 'offline fixture' });
		backend.request(42, 'PATCH', '/api/v1/users/me/privacy', {
			json: { visibility: 'public', expected_version: 1 },
		});
		await expect.poll(() => sockets.length).toBe(2);
		await expect(page.locator('.notice__actions')).toHaveCount(0);
		await expect(trigger(page)).toContainText('0');
		await page.getByRole('button', { name: 'Follow requests (0)' }).click();
		await expect(page.locator('#notification-panel')).toContainText('No pending requests here.');
	});

	test('global controls work across all protected routes without duplicate sockets', async ({
		page,
	}) => {
		const { sockets } = await install(page, model());
		await page.goto('/');
		for (const name of ['Home', 'People', 'Profile']) {
			await page.getByRole('link', { name, exact: true }).click();
			await open(page);
			await page.getByRole('button', { name: 'Close notifications' }).click();
		}
		for (const name of ['0 followers', '0 following']) {
			await page.getByRole('link', { name: 'Profile', exact: true }).click();
			await page.getByRole('link', { name }).click();
			await open(page);
			await page.keyboard.press('Escape');
		}
		expect(sockets).toHaveLength(1);
	});

	test('outage removes cached notices and retry recovers without signing out', async ({ page }) => {
		await install(page, model());
		await page.goto('/');
		await open(page);
		await page.route('**/api/v1/notifications*', (route) => route.abort());
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.locator('#notification-panel')).toContainText(
			'We can’t load your notices right now.',
		);
		await expect(page.locator('.notice')).toHaveCount(0);
		await expect(trigger(page)).toContainText('—');
		await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
		await page.unroute('**/api/v1/notifications*');
		await page.getByRole('button', { name: 'Try notifications again' }).click();
		await expect(page.locator('.notice')).toHaveCount(2);
	});

	test('logout and login as someone else release the old socket, state and panel', async ({
		page,
	}) => {
		const { sockets } = await install(page, model());
		await page.goto('/');
		await open(page);
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.locator('.notification-trigger')).toHaveCount(0);
		await page.getByLabel('Email', { exact: true }).fill('robin@example.com');
		await page.getByLabel('Password', { exact: true }).fill('correct-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(trigger(page)).toContainText('0');
		await trigger(page).click();
		await expect(page.locator('#notification-panel')).toContainText('You’re all caught up.');
		await expect(page.locator('#notification-panel')).not.toContainText('Ada Lovelace');
		expect(sockets).toHaveLength(2);
	});

	for (const [label, viewport] of [
		['360px', { width: 360, height: 800 }],
		['desktop', { width: 1280, height: 900 }],
	]) {
		test(`notification panel and pagination fit ${label} with keyboard access`, async ({
			page,
		}) => {
			const backend = model();
			for (let id = 100; id < 122; id += 1) {
				backend.users.set(
					id,
					makeUser(id, { display_name: `A-very-long-name-without-spaces-${id}` }),
				);
				backend.request(id, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
			}
			await page.setViewportSize(viewport);
			await install(page, backend);
			await page.goto('/people');
			await trigger(page).focus();
			await page.keyboard.press('Enter');
			await expect(page.locator('.notice')).toHaveCount(20);
			await page.getByRole('button', { name: 'Next', exact: true }).click();
			await expect(page.locator('.notice')).toHaveCount(4);
			await page.getByRole('button', { name: 'Follow requests (24)' }).click();
			await expect(page.locator('[data-request-id]')).toHaveCount(20);
			const dimensions = await page.locator('#notification-panel').evaluate((panel) => ({
				width: panel.scrollWidth - panel.clientWidth,
				right: panel.getBoundingClientRect().right,
				left: panel.getBoundingClientRect().left,
			}));
			expect(dimensions.width).toBeLessThanOrEqual(0);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				),
			).toBeLessThanOrEqual(0);
			expect(dimensions.left).toBeGreaterThanOrEqual(0);
			expect(dimensions.right).toBeLessThanOrEqual(viewport.width);
			for (const control of await page.locator('#notification-panel button').all()) {
				const box = await control.boundingBox();
				expect(box.height).toBeGreaterThanOrEqual(43.5);
			}
			await page.screenshot({ path: `.tmp/a10-${label}.png`, fullPage: true });
			await page.keyboard.press('Escape');
			await expect(trigger(page)).toBeFocused();
		});
	}
});
