import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// Browser fetch and WebSocket APIs supply real Origin and Cookie headers.
// No route fixtures; full UI journeys and browser reopen belong to SN-A07.
async function browserRequest(page, path, body, includeWriteHeader = true) {
	return page.evaluate(
		async ({ path, body, includeWriteHeader }) => {
			const response = await fetch(path, {
				method: body === undefined ? 'GET' : 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
					...(includeWriteHeader ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
				},
				body: body == null ? undefined : JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() };
		},
		{ path, body, includeWriteHeader },
	);
}

async function socketSnapshot(page) {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const url = new URL('/ws', location.href);
				url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
				const socket = new WebSocket(url);
				window.transportSocket = socket;
				window.transportSocketClosed = false;
				const timer = setTimeout(() => {
					socket.close();
					reject(new Error('Timed out waiting for real WebSocket snapshot'));
				}, 5000);
				socket.onclose = () => {
					window.transportSocketClosed = true;
				};
				socket.onerror = () => {
					clearTimeout(timer);
					reject(new Error('WebSocket upgrade failed'));
				};
				socket.onmessage = ({ data }) => {
					const message = JSON.parse(data);
					if (message.type === 'presence.snapshot') {
						clearTimeout(timer);
						resolve(message);
					}
				};
			}),
	);
}

test('serves built routes/assets and proxies real health and unauthorized status', async ({
	request,
	baseURL,
}) => {
	for (const route of ['/login', '/register', '/protected/deep-link']) {
		const response = await request.get(route, { headers: { Accept: 'text/html' } });
		expect(response.status()).toBe(200);
		const html = await response.text();
		const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)];
		expect(assets.length).toBeGreaterThanOrEqual(2);
		for (const [, asset] of assets) {
			const response = await request.get(asset);
			expect(response.status()).toBe(200);
			expect(await response.text()).not.toContain('server-only.invalid');
		}
	}
	expect((await request.get('/assets/missing.js')).status()).toBe(404);
	expect((await request.get('/healthz')).status()).toBe(200);
	const health = await request.get('/api/v1/health');
	expect(health.status()).toBe(200);
	expect(await health.json()).toMatchObject({ data: { status: 'ok' } });
	expect((await request.get('/api/v1/users/me')).status()).toBe(401);
	expect((await request.get('/ws', { headers: { Origin: baseURL } })).status()).toBe(401);
});

test('browser cookies cross the proxy; WebSocket upgrades and closes on logout', async ({
	page,
	context,
	baseURL,
}) => {
	// A same-origin document without the app's own session/socket lifecycle.
	await page.goto('/healthz');
	const account = {
		email: `b07-${randomUUID()}@example.com`,
		password: 'correct horse battery',
		first_name: 'Transport',
		last_name: 'Smoke',
		date_of_birth: '2000-01-01',
	};
	const registered = await browserRequest(page, '/api/v1/users/register', account);
	expect(registered.status).toBe(201);
	const cookies = await context.cookies();
	const cookie = cookies.find(({ name }) => name === 'session_token');
	expect(cookie).toMatchObject({
		domain: new URL(baseURL).hostname,
		path: '/',
		httpOnly: true,
		sameSite: 'Lax',
		secure: false,
	});
	expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 12 * 60 * 60);
	expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');
	const me = await browserRequest(page, '/api/v1/users/me');
	expect(me.status).toBe(200);
	expect(me.body.data.email).toBe(account.email);
	expect(await socketSnapshot(page)).toMatchObject({ type: 'presence.snapshot' });

	// Denial must survive the proxy, while the legitimate session stays valid.
	expect((await browserRequest(page, '/api/v1/users/logout', null, false)).status).toBe(403);
	const foreign = await context.request.post('/api/v1/users/logout', {
		headers: { Origin: 'http://untrusted.invalid', 'X-Requested-With': 'XMLHttpRequest' },
	});
	expect(foreign.status()).toBe(403);
	expect((await browserRequest(page, '/api/v1/users/me')).status).toBe(200);

	expect((await browserRequest(page, '/api/v1/users/logout', null)).status).toBe(200);
	await expect.poll(() => page.evaluate(() => window.transportSocketClosed)).toBe(true);
	expect((await context.cookies()).some(({ name }) => name === 'session_token')).toBe(false);
	expect((await browserRequest(page, '/api/v1/users/me')).status).toBe(401);
	const replay = await context.request.get('/api/v1/users/me', {
		headers: { Cookie: `session_token=${cookie.value}` },
	});
	expect(replay.status()).toBe(401);

	const login = await browserRequest(page, '/api/v1/users/login', {
		email: account.email,
		password: account.password,
	});
	expect(login.status).toBe(200);
	expect((await browserRequest(page, '/api/v1/users/me')).body.data.email).toBe(account.email);
	expect((await browserRequest(page, '/api/v1/users/logout', null)).status).toBe(200);
});
