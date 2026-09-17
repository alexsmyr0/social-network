import { expect, test } from '@playwright/test';

const PASSWORD = 'password123';
const BOX_TOLERANCE = 8;

function createCredentials(prefix) {
	const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
		.toString(36)
		.padStart(2, '0')}`;
	const maxPrefixLength = Math.max(3, 30 - suffix.length - 1);
	const username = `${prefix.slice(0, maxPrefixLength)}_${suffix}`;
	return {
		username,
		email: `${username}@example.com`,
		password: PASSWORD,
		firstName: 'First',
		lastName: 'Last',
		age: 25,
		gender: 'Other',
	};
}

function pathOf(url) {
	return new URL(url).pathname;
}

async function expectPathname(page, expectedPath) {
	await expect.poll(() => pathOf(page.url())).toBe(expectedPath);
}

async function ensureLoggedOut(page) {
	await page.request.post('/api/v1/users/logout', {
		failOnStatusCode: false,
	});
	await page.context().clearCookies();
}

async function registerUser(page, credentials) {
	const response = await page.request.post('/api/v1/users/register', {
		data: {
			username: credentials.username,
			email: credentials.email,
			password: credentials.password,
			first_name: credentials.firstName,
			last_name: credentials.lastName,
			age: credentials.age,
			gender: credentials.gender,
		},
		failOnStatusCode: false,
	});

	expect(response.status()).toBe(201);
	return response;
}

async function loginUser(page, credentials) {
	const response = await page.request.post('/api/v1/users/login', {
		data: {
			username: credentials.username,
			password: credentials.password,
		},
		failOnStatusCode: false,
	});

	expect(response.status()).toBe(200);
	return response;
}

function startDiagnostics(page) {
	const diagnostics = {
		console: [],
		pageErrors: [],
		requestFailures: [],
	};

	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') {
			diagnostics.console.push({
				type: message.type(),
				text: message.text(),
			});
		}
	});

	page.on('pageerror', (error) => {
		diagnostics.pageErrors.push(String(error));
	});

	page.on('requestfailed', (request) => {
		diagnostics.requestFailures.push({
			url: request.url(),
			method: request.method(),
			errorText: request.failure()?.errorText ?? 'unknown',
		});
	});

	return diagnostics;
}

async function attachDiagnostics(page, testInfo, label, diagnostics) {
	await testInfo.attach(`${label}-diagnostics.json`, {
		body: Buffer.from(
			JSON.stringify(
				{
					url: page.url(),
					diagnostics,
				},
				null,
				2,
			),
		),
		contentType: 'application/json',
	});

	await testInfo.attach(`${label}-dom.html`, {
		body: Buffer.from(await page.content()),
		contentType: 'text/html',
	});

	await testInfo.attach(`${label}-screenshot.png`, {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png',
	});
}

async function runWithDiagnostics(page, testInfo, label, callback) {
	const diagnostics = startDiagnostics(page);
	try {
		await callback(diagnostics);
	} catch (error) {
		await attachDiagnostics(page, testInfo, label, diagnostics);
		throw error;
	}
}

function expectStableBox(box, baseline, tolerance = BOX_TOLERANCE) {
	expect(Math.abs(box.x - baseline.x)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(box.y - baseline.y)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(box.width - baseline.width)).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(box.height - baseline.height)).toBeLessThanOrEqual(tolerance);
}

test.describe('Ticket Manual E2E Verification', () => {
	test.describe('A02', () => {
		test('A02-01: root access serves application shell', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a02-root-access', async () => {
				await ensureLoggedOut(page);

				const response = await page.goto('/');
				expect(response).not.toBeNull();
				expect(response?.status()).toBe(200);
				expect(response?.headers()['content-type'] ?? '').toContain('text/html');

				await expect(page.locator('#app')).toBeVisible();
				await expect(page.locator('#main-content')).toBeVisible();
				await expect(page.locator('[data-screen="login"]')).toBeVisible();
				await expect(page).toHaveURL(/\/login$/);
			});
		});

		test('A02-02: /spa/ serves SPA shell entry document', async ({ browser }, testInfo) => {
			const context = await browser.newContext({ javaScriptEnabled: false });
			const page = await context.newPage();
			const diagnostics = startDiagnostics(page);

			try {
				const response = await page.goto('http://localhost:3000/spa/');
				expect(response).not.toBeNull();
				expect(response?.status()).toBe(200);
				expect(response?.headers()['content-type'] ?? '').toContain('text/html');

				await expect(page).toHaveURL(/\/spa\/?$/);
				await expect(page).toHaveTitle(/Real-Time Forum/i);
				await expect(page.locator('#app')).toBeVisible();
				await expect(page.locator('#main-content')).toBeVisible();
				await expect(page.locator('script[type="module"][src="/main.js"]')).toHaveCount(1);
			} catch (error) {
				await attachDiagnostics(page, testInfo, 'a02-spa-path', diagnostics);
				throw error;
			} finally {
				await context.close();
			}
		});
	});

	test.describe('A03', () => {
		test('A03-01: internal route changes occur without full reload', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a03-no-reload', async () => {
				await ensureLoggedOut(page);

				let loadEvents = 0;
				page.on('load', () => {
					loadEvents += 1;
				});

				await page.goto('/login');
				await expect(page.locator('[data-screen="login"]')).toBeVisible();

				const baseline = await page.evaluate(() => {
					const sentinel = Math.random().toString(36).slice(2);
					window.__a03Sentinel = sentinel;
					document.documentElement.setAttribute('data-a03-sentinel', sentinel);
					return {
						sentinel,
						navCount: performance.getEntriesByType('navigation').length,
					};
				});
				const loadEventsAfterInitialNavigation = loadEvents;

				await page.locator('a[data-link][href="/register"]').click();
				await expect(page).toHaveURL(/\/register$/);
				await expect(page.locator('[data-screen="register"]')).toBeVisible();

				const afterRegisterNavigation = await page.evaluate(() => ({
					sentinel: window.__a03Sentinel,
					domSentinel: document.documentElement.getAttribute('data-a03-sentinel'),
					navCount: performance.getEntriesByType('navigation').length,
				}));

				expect(afterRegisterNavigation.sentinel).toBe(baseline.sentinel);
				expect(afterRegisterNavigation.domSentinel).toBe(baseline.sentinel);
				expect(afterRegisterNavigation.navCount).toBe(baseline.navCount);
				expect(loadEvents).toBe(loadEventsAfterInitialNavigation);

				await page.locator('a[data-link][href="/login"]').click();
				await expect(page).toHaveURL(/\/login$/);
				await expect(page.locator('[data-screen="login"]')).toBeVisible();

				const afterLoginNavigation = await page.evaluate(() => ({
					sentinel: window.__a03Sentinel,
					navCount: performance.getEntriesByType('navigation').length,
				}));

				expect(afterLoginNavigation.sentinel).toBe(baseline.sentinel);
				expect(afterLoginNavigation.navCount).toBe(baseline.navCount);
				expect(loadEvents).toBe(loadEventsAfterInitialNavigation);
			});
		});

		test('A03-02: browser back and forward work for supported routes', async ({
			page,
		}, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a03-history', async () => {
				await ensureLoggedOut(page);
				await page.goto('/login');
				await expect(page.locator('[data-screen="login"]')).toBeVisible();

				await page.locator('a[data-link][href="/register"]').click();
				await expect(page).toHaveURL(/\/register$/);
				await expect(page.locator('[data-screen="register"]')).toBeVisible();

				await page.goBack();
				await expect(page).toHaveURL(/\/login$/);
				await expect(page.locator('[data-screen="login"]')).toBeVisible();

				await page.goForward();
				await expect(page).toHaveURL(/\/register$/);
				await expect(page.locator('[data-screen="register"]')).toBeVisible();
			});
		});

		test('A03-03: pasted deep links resolve to expected screens', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a03-deeplink', async () => {
				await ensureLoggedOut(page);

				const unauthCases = [
					{ path: '/login', expectedPath: '/login', screen: 'login' },
					{ path: '/register', expectedPath: '/register', screen: 'register' },
					{ path: '/posts/7', expectedPath: '/login', screen: 'login' },
					{ path: '/view-post/7', expectedPath: '/login', screen: 'login' },
				];

				for (const testCase of unauthCases) {
					await page.goto(testCase.path);
					await expectPathname(page, testCase.expectedPath);
					await expect(page.locator(`[data-screen="${testCase.screen}"]`)).toBeVisible();
				}

				const credentials = createCredentials('a03_deep');
				await registerUser(page, credentials);

				const authCases = [
					{ path: '/', expectedPath: '/', screen: 'feed' },
					{ path: '/activity', expectedPath: '/activity', screen: 'activity' },
					{ path: '/create-post', expectedPath: '/create-post', screen: 'create-post' },
					{
						path: '/edit-post/7',
						expectedPath: '/edit-post/7',
						screen: 'edit-post',
						postID: '7',
					},
					{ path: '/posts/7', expectedPath: '/posts/7', screen: 'post-detail', postID: '7' },
					{
						path: '/view-post/7',
						expectedPath: '/posts/7',
						screen: 'post-detail',
						postID: '7',
					},
				];

				for (const testCase of authCases) {
					await page.goto(testCase.path);
					await expectPathname(page, testCase.expectedPath);
					await expect(page.locator(`[data-screen="${testCase.screen}"]`)).toBeVisible();

					if (testCase.postID) {
						await expect(page.locator(`[data-post-id="${testCase.postID}"]`)).toBeVisible();
					}
				}
			});
		});
	});

	test.describe('A04', () => {
		test('A04-01: authenticated routes render inside shared shell', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a04-shared-shell', async () => {
				const credentials = createCredentials('a04_shell');
				await registerUser(page, credentials);

				const routes = [
					{ path: '/', screen: 'feed' },
					{ path: '/posts/9', screen: 'post-detail' },
					{ path: '/create-post', screen: 'create-post' },
					{ path: '/edit-post/3', screen: 'edit-post' },
					{ path: '/activity', screen: 'activity' },
				];

				for (const route of routes) {
					await page.goto(route.path);
					expect(pathOf(page.url())).toBe(route.path);
					await expect(page.locator('[data-auth-shell]')).toBeVisible();
					await expect(page.locator('[data-action="logout"]')).toBeVisible();
					await expect(page.locator('[aria-label="Forum navigation"]')).toBeVisible();
					await expect(page.locator('[data-chat-roster]')).toBeVisible();
					await expect(page.locator(`[data-screen="${route.screen}"]`)).toBeVisible();
				}
			});
		});

		test('A04-02: navigation and logout remain visible during route changes', async ({
			page,
		}, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a04-nav-logout-persistence', async () => {
				const credentials = createCredentials('a04_nav');
				await registerUser(page, credentials);

				await page.goto('/');
				await expect(page.locator('[data-auth-shell]')).toBeVisible();
				await expect(page.locator('[aria-label="Forum navigation"]')).toBeVisible();
				await expect(page.locator('[data-action="logout"]')).toBeVisible();

				const transitions = [
					{ href: '/activity', expectedPath: '/activity', screen: 'activity' },
					{ href: '/create-post', expectedPath: '/create-post', screen: 'create-post' },
					{ href: '/', expectedPath: '/', screen: 'feed' },
				];

				for (const step of transitions) {
					await page.locator(`[aria-label="Forum navigation"] a[href="${step.href}"]`).click();
					expect(pathOf(page.url())).toBe(step.expectedPath);
					await expect(page.locator(`[data-screen="${step.screen}"]`)).toBeVisible();
					await expect(page.locator('[aria-label="Forum navigation"]')).toBeVisible();
					await expect(page.locator('[data-action="logout"]')).toBeVisible();
				}
			});
		});

		test('A04-03: chat layout keeps stable roster and active regions', async ({
			page,
		}, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a04-chat-layout-stability', async () => {
				const credentials = createCredentials('a04_chat');
				await registerUser(page, credentials);

				await page.goto('/');

				const roster = page.locator('[data-chat-roster]');
				const activeChat = page.locator('[data-chat-active]');
				const outlet = page.locator('.app-shell__outlet');

				await expect(roster).toBeVisible();
				await expect(activeChat).toBeVisible();
				await expect(outlet).toBeVisible();

				const baselineRosterBox = await roster.boundingBox();
				const baselineActiveBox = await activeChat.boundingBox();
				const outletBox = await outlet.boundingBox();

				expect(baselineRosterBox).not.toBeNull();
				expect(baselineActiveBox).not.toBeNull();
				expect(outletBox).not.toBeNull();

				const baselineRoster = baselineRosterBox;
				const baselineActive = baselineActiveBox;
				const currentOutlet = outletBox;

				expect(baselineRoster.width).toBeGreaterThan(180);
				expect(baselineActive.width).toBeGreaterThan(180);
				expect(baselineRoster.x).toBeGreaterThan(currentOutlet.x);
				expect(baselineActive.y).toBeGreaterThan(baselineRoster.y);

				for (const path of ['/activity', '/create-post', '/']) {
					await page.goto(path);
					await expect(page.locator('[data-chat-roster]')).toBeVisible();
					await expect(page.locator('[data-chat-active]')).toBeVisible();

					const currentRosterBox = await roster.boundingBox();
					const currentActiveBox = await activeChat.boundingBox();

					expect(currentRosterBox).not.toBeNull();
					expect(currentActiveBox).not.toBeNull();

					expectStableBox(currentRosterBox, baselineRoster);
					expectStableBox(currentActiveBox, baselineActive);
				}
			});
		});
	});

	test.describe('A05', () => {
		test('A05-01: unauthenticated protected-route entry resolves to login flow', async ({
			page,
		}, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a05-unauth-routes', async () => {
				await ensureLoggedOut(page);

				const protectedRoutes = ['/', '/activity', '/create-post', '/posts/7', '/edit-post/7'];
				for (const route of protectedRoutes) {
					await page.goto(route);
					await expect(page.locator('[data-screen="login"]')).toBeVisible();
					await expectPathname(page, '/login');
					await expect(page.locator('[data-auth-shell]')).toHaveCount(0);
				}
			});
		});

		test('A05-02: authenticated entry from public-only routes resolves to forum shell', async ({
			page,
		}, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a05-auth-from-public-only', async () => {
				const credentials = createCredentials('a05_public');
				await registerUser(page, credentials);

				for (const route of ['/login', '/register']) {
					await page.goto(route);
					await expect(page.locator('[data-auth-shell]')).toBeVisible();
					await expect(page.locator('[data-screen="feed"]')).toBeVisible();
					await expectPathname(page, '/');
				}
			});
		});

		test('A05-03: forum endpoints are guarded by authenticated session checks', async ({
			page,
		}) => {
			await ensureLoggedOut(page);

			const protectedEndpoints = [
				'/api/v1/users/me',
				'/api/v1/categories',
				'/api/v1/posts?page=1&per_page=5',
				'/api/v1/users/activity',
			];

			for (const endpoint of protectedEndpoints) {
				const response = await page.request.get(endpoint, { failOnStatusCode: false });
				expect(response.status(), `expected 401 for ${endpoint}`).toBe(401);
			}

			const credentials = createCredentials('a05_guard');
			await registerUser(page, credentials);

			for (const endpoint of protectedEndpoints) {
				const response = await page.request.get(endpoint, { failOnStatusCode: false });
				expect(response.status(), `expected successful auth access for ${endpoint}`).toBe(200);
			}

			await page.request.post('/api/v1/users/logout', { failOnStatusCode: false });
			const meAfterLogout = await page.request.get('/api/v1/users/me', { failOnStatusCode: false });
			expect(meAfterLogout.status()).toBe(401);
		});
	});

	test.describe('A06', () => {
		test('A06-01: logout control is visible and usable on each protected route', async ({
			page,
		}, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a06-logout-visibility', async () => {
				const credentials = createCredentials('a06_visible');
				await registerUser(page, credentials);

				const protectedRoutes = [
					{ path: '/', screen: 'feed' },
					{ path: '/posts/9', screen: 'post-detail' },
					{ path: '/create-post', screen: 'create-post' },
					{ path: '/edit-post/3', screen: 'edit-post' },
					{ path: '/activity', screen: 'activity' },
				];

				for (const route of protectedRoutes) {
					await page.goto(route.path);
					await expect(page.locator(`[data-screen="${route.screen}"]`)).toBeVisible();
					await expect(page.locator('[data-auth-shell]')).toBeVisible();
					await expect(page.locator('[data-action="logout"]')).toBeVisible();
					await expect(page.locator('[data-action="logout"]')).toBeEnabled();
				}
			});
		});

		test('A06-02: logout from protected routes redirects to /login', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a06-logout-redirect', async () => {
				const credentials = createCredentials('a06_redirect');
				await registerUser(page, credentials);

				const protectedRoutes = ['/', '/activity', '/create-post'];
				for (let index = 0; index < protectedRoutes.length; index += 1) {
					if (index > 0) {
						await loginUser(page, credentials);
					}

					const route = protectedRoutes[index];
					await page.goto(route);
					await expect(page.locator('[data-action="logout"]')).toBeVisible();

					const logoutResponsePromise = page.waitForResponse((response) => {
						return (
							pathOf(response.url()) === '/api/v1/users/logout' &&
							response.request().method() === 'POST'
						);
					});

					await page.click('[data-action="logout"]');
					const logoutResponse = await logoutResponsePromise;

					expect(logoutResponse.status()).toBe(200);
					await expect(page).toHaveURL(/\/login$/);
					await expect(page.locator('[data-screen="login"]')).toBeVisible();
					await expect(page.locator('[data-auth-shell]')).toHaveCount(0);
				}
			});
		});

		test('A06-03: post-logout protected content is not rendered', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a06-post-logout-guard', async () => {
				const credentials = createCredentials('a06_guard');
				await registerUser(page, credentials);

				await page.goto('/activity');
				await expect(page.locator('[data-screen="activity"]')).toBeVisible();

				await page.click('[data-action="logout"]');
				await expect(page).toHaveURL(/\/login$/);
				await expect(page.locator('[data-screen="login"]')).toBeVisible();
				await expect(page.locator('[data-auth-shell]')).toHaveCount(0);

				for (const route of ['/', '/activity', '/create-post', '/posts/7']) {
					await page.goto(route);
					await expectPathname(page, '/login');
					await expect(page.locator('[data-screen="login"]')).toBeVisible();
					await expect(page.locator('[data-auth-shell]')).toHaveCount(0);
				}
			});
		});
	});

	test.describe('A07', () => {
		test('A07-01: profile displays extended registration fields', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a07-profile-fields', async () => {
				const credentials = createCredentials('a07_fields');
				await ensureLoggedOut(page);
				await registerUser(page, credentials);

				// Navigate to my own profile via API ID if possible, or manual link
				const response = await page.request.get('/api/v1/users/me');
				const me = await response.json();
				const myID = me.data.id;

				await page.goto(`/profile/${myID}`);
				await expectPathname(page, `/profile/${myID}`);
				await expect(page.locator('[data-screen="profile"]')).toBeVisible();

				await expect(page.locator('.profile-name')).toContainText(credentials.firstName);
				await expect(page.locator('.profile-name')).toContainText(credentials.lastName);
				await expect(page.locator('.profile-username')).toContainText(credentials.username);
				await expect(page.locator('.stat-value').nth(0)).toContainText(String(credentials.age));
				await expect(page.locator('.stat-value').nth(1)).toContainText(credentials.gender);
			});
		});

		test('A07-02: profile is accessible from post author links', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a07-post-author-link', async () => {
				const credentials = createCredentials('a07_link');
				await registerUser(page, credentials);

				// Create a post
				await page.request.post('/api/v1/posts', {
					data: {
						title: 'Profile Link Test',
						body: 'Check my profile link',
						category_ids: [1],
					},
				});

				await page.goto('/');
				await expect(page.locator('[data-screen="feed"]')).toBeVisible();

				const authorLink = page.locator('.profile-link').first();
				await expect(authorLink).toBeVisible();
				await authorLink.click();

				await expect(page.locator('[data-screen="profile"]')).toBeVisible();
				await expect(page.url()).toContain('/profile/');
			});
		});
	});

	test.describe('A10', () => {
		test('A10-01: visiting / loads SPA shell', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a10-root-shell', async () => {
				await ensureLoggedOut(page);
				const response = await page.goto('/');

				expect(response).not.toBeNull();
				expect(response?.status()).toBe(200);
				expect(response?.headers()['content-type'] ?? '').toContain('text/html');

				await expect(page).toHaveTitle('Real-Time Forum');
				await expect(page.locator('#app')).toBeVisible();
				await expect(page.locator('#main-content')).toBeVisible();
				await expect(page.locator('script[type="module"][src="/main.js"]')).toHaveCount(1);
				await expect(
					page.locator('link[rel="stylesheet"][href="/assets/css/main.css"]'),
				).toHaveCount(1);
				await expect(page.locator('[data-screen="login"]')).toBeVisible();
			});
		});

		test('A10-02: direct /login loads SPA shell without 404', async ({ page }, testInfo) => {
			await runWithDiagnostics(page, testInfo, 'a10-direct-login', async () => {
				await ensureLoggedOut(page);
				const response = await page.goto('/login');

				expect(response).not.toBeNull();
				expect(response?.status()).toBe(200);
				expect(response?.status()).not.toBe(404);
				expect(response?.headers()['content-type'] ?? '').toContain('text/html');

				await expect(page).toHaveURL(/\/login$/);
				await expect(page).toHaveTitle('Real-Time Forum');
				await expect(page.locator('#app')).toBeVisible();
				await expect(page.locator('#main-content')).toBeVisible();
				await expect(page.locator('[data-screen="login"]')).toBeVisible();

				const pageMarkup = await page.content();
				expect(pageMarkup.toLowerCase()).not.toContain('404 page not found');
			});
		});

		test('A10-03: static assets main.js and main.css are served correctly', async ({ request }) => {
			const jsResponse = await request.get('/main.js', { failOnStatusCode: false });
			expect(jsResponse.status()).toBe(200);
			expect(jsResponse.headers()['content-type'] ?? '').toMatch(/(javascript|ecmascript)/i);
			const jsBody = await jsResponse.text();
			expect(jsBody).toContain('createApp');
			expect(jsBody).not.toContain('<!DOCTYPE html>');

			const cssResponse = await request.get('/assets/css/main.css', {
				failOnStatusCode: false,
			});
			expect(cssResponse.status()).toBe(200);
			expect(cssResponse.headers()['content-type'] ?? '').toMatch(/text\/css/i);
			const cssBody = await cssResponse.text();
			expect(cssBody).toContain('@import');
			expect(cssBody).not.toContain('<!DOCTYPE html>');
		});

		test('A10-04: /api proxy behavior remains intact', async ({ request }) => {
			const healthResponse = await request.get('/api/v1/health', { failOnStatusCode: false });
			expect(healthResponse.status()).toBe(200);
			expect(healthResponse.headers()['content-type'] ?? '').toContain('application/json');

			const healthBody = await healthResponse.json();
			expect(healthBody?.data?.status).toBe('ok');

			const badRequestResponse = await request.get('/api/v1/health?error=400', {
				failOnStatusCode: false,
			});
			expect(badRequestResponse.status()).toBe(400);
			const badRequestBody = await badRequestResponse.json();
			expect(badRequestBody?.error?.code).toBe('BAD_REQUEST');
		});
	});
});
