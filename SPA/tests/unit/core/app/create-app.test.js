// SPA/tests/unit/core/app/create-app.test.js

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../../../core/app/create-app.js';
import { matchRoute, normalizePathname } from '../../../../core/router/routes.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import * as authHandlers from '../../../../features/auth/auth.handlers.js';
import * as notificationPage from '../../../../features/notification/notification.page.js';
import * as postPage from '../../../../features/post/post.page.js';
import { createMockBrowser } from '../../helpers/browser-mock.js';

// The session/presence slices are one module-level store shared by every slice
// (issue #76), so each case starts from a clean slot set rather than inheriting
// the previous one's identity and presence.
beforeEach(() => {
	resetAppState();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('SPA routing for A03/A04', () => {
	test('normalizes and matches required routes', () => {
		expect(normalizePathname('')).toBe('/');
		expect(normalizePathname('/view-post/42')).toBe('/posts/42');
		expect(normalizePathname('/post/42')).toBe('/posts/42');
		expect(normalizePathname('/activity/')).toBe('/activity');

		expect(matchRoute('/')?.route.id).toBe('feed');
		expect(matchRoute('/posts/7')?.params.id).toBe('7');
		expect(matchRoute('/post/7')?.params.id).toBe('7');
		expect(matchRoute('/edit-post/15')?.params.id).toBe('15');
		expect(matchRoute('/does-not-exist')).toBeNull();

		// Regression: A03 Malformed URI should not crash
		expect(matchRoute('/posts/%E0%A4%A')).toBeNull();
	});
});

describe('SPA Application Engine', () => {
	test('boot applies auth guard and redirects protected deep links', async () => {
		const browser = createMockBrowser('/activity');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			setTimeoutRef: (fn) => {
				fn();
				return 1;
			},
		});

		await app.boot();

		expect(browser.windowRef.location.pathname).toBe('/login');
		expect(browser.mainContent.innerHTML).toContain('data-screen="login"');
		expect(browser.overlay.style.opacity).toBe('0');
		expect(browser.overlay.removed).toBe(true);
	});

	test('boot checks session via GET /api/v1/users/me with cookie credentials', async () => {
		const browser = createMockBrowser('/login');
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();

		expect(fetchRef).toHaveBeenCalledTimes(1);
		expect(fetchRef).toHaveBeenCalledWith('/api/v1/users/me', {
			method: 'GET',
			credentials: 'include',
			headers: {
				Accept: 'application/json',
			},
		});
	});

	test('unauthenticated boot blocks every protected route and redirects to login', async () => {
		const protectedRoutes = ['/', '/posts/9', '/create-post', '/edit-post/3', '/activity'];

		for (const path of protectedRoutes) {
			const browser = createMockBrowser(path);
			const app = createApp({
				windowRef: browser.windowRef,
				documentRef: browser.documentRef,
				fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			});

			await app.boot();

			expect(browser.windowRef.location.pathname).toBe('/login');
			expect(browser.mainContent.innerHTML).toContain('data-screen="login"');
		}
	});

	test('authenticated boot starts notification polling', async () => {
		const browser = createMockBrowser('/');
		const notificationCenter = { start: vi.fn(), stop: vi.fn() };
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter,
		});

		await app.boot();

		expect(notificationCenter.start).toHaveBeenCalledTimes(1);
		expect(notificationCenter.stop).not.toHaveBeenCalled();
	});

	test('unauthenticated boot does not start notification polling', async () => {
		const browser = createMockBrowser('/login');
		const notificationCenter = { start: vi.fn(), stop: vi.fn() };
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			notificationCenter,
		});

		await app.boot();

		expect(notificationCenter.start).not.toHaveBeenCalled();
	});

	test('logout stops notification polling', async () => {
		const browser = createMockBrowser('/');
		const notificationCenter = { start: vi.fn(), stop: vi.fn() };
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter,
		});

		await app.boot();
		browser.clickLogout();
		await Promise.resolve();
		await Promise.resolve();

		expect(notificationCenter.stop).toHaveBeenCalled();
		expect(browser.windowRef.location.pathname).toBe('/login');
	});

	test('app stop tears down notification polling', async () => {
		const browser = createMockBrowser('/');
		const notificationCenter = { start: vi.fn(), stop: vi.fn() };
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			notificationCenter,
		});

		await app.boot();
		app.stop();

		expect(notificationCenter.stop).toHaveBeenCalled();
	});

	test('authenticated boot redirects public-only entry states into forum shell', async () => {
		const browser = createMockBrowser('/register');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
		});

		await app.boot();

		expect(browser.windowRef.location.pathname).toBe('/');
		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).toContain('data-screen="feed"');
	});

	test('internal link navigation updates route without reload', async () => {
		const browser = createMockBrowser('/login');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
		});

		await app.boot();
		const clickEvent = browser.clickLink('/register');

		expect(clickEvent.preventDefault).toHaveBeenCalledTimes(1);
		expect(browser.windowRef.location.pathname).toBe('/register');
		expect(browser.mainContent.innerHTML).toContain('data-screen="register"');
		expect(browser.windowRef.location.assign).not.toHaveBeenCalled();
		expect(
			browser.historyCalls.some((call) => call.type === 'push' && call.path === '/register'),
		).toBe(true);
	});

	test('browser back and forward render supported routes', async () => {
		const browser = createMockBrowser('/');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
		});

		await app.boot();
		app.navigate('/create-post');
		app.navigate('/posts/42');

		expect(browser.mainContent.innerHTML).toContain('data-screen="post-detail"');

		browser.windowRef.history.back();
		expect(browser.mainContent.innerHTML).toContain('data-screen="create-post"');

		browser.windowRef.history.back();
		expect(browser.mainContent.innerHTML).toContain('data-screen="feed"');

		browser.windowRef.history.forward();
		expect(browser.mainContent.innerHTML).toContain('data-screen="create-post"');
	});

	test('deep-link boot renders expected authenticated routes', async () => {
		const cases = [
			{ path: '/', expected: 'data-screen="feed"' },
			{ path: '/posts/9', expected: 'data-screen="post-detail"' },
			{ path: '/create-post', expected: 'data-screen="create-post"' },
			{ path: '/edit-post/3', expected: 'data-screen="edit-post"' },
			{ path: '/activity', expected: 'data-screen="activity"' },
		];

		for (const testCase of cases) {
			const browser = createMockBrowser(testCase.path);
			const app = createApp({
				windowRef: browser.windowRef,
				documentRef: browser.documentRef,
				fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			});

			await app.boot();
			expect(browser.mainContent.innerHTML).toContain(testCase.expected);
		}
	});

	test('create/edit routes initialize through the SPA route lifecycle', async () => {
		const initPostFormPage = vi.spyOn(postPage, 'initPostFormPage').mockResolvedValue(null);

		for (const path of ['/create-post', '/edit-post/12']) {
			const browser = createMockBrowser(path);
			const app = createApp({
				windowRef: browser.windowRef,
				documentRef: browser.documentRef,
				fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
			});

			await app.boot();
		}

		expect(initPostFormPage).toHaveBeenCalledTimes(2);
		expect(initPostFormPage.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				windowRef: expect.any(Object),
				documentRef: expect.any(Object),
				fetchRef: expect.any(Function),
				navigate: expect.any(Function),
			}),
		);
	});

	test('authenticated routes render inside a shared shell with reserved chat regions', async () => {
		const browser = createMockBrowser('/');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
		});

		await app.boot();

		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).toContain('aria-label="Forum navigation"');
		expect(browser.mainContent.innerHTML).toContain('data-action="logout"');
		expect(browser.mainContent.innerHTML).toContain('data-chat-roster');
		expect(browser.mainContent.innerHTML).toContain('data-chat-active');
		expect(browser.mainContent.innerHTML).toContain('data-screen="feed"');
	});

	test('navigation and logout stay visible across protected route changes', async () => {
		const browser = createMockBrowser('/');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
		});

		await app.boot();
		app.navigate('/create-post');
		app.navigate('/activity');

		expect(browser.mainContent.innerHTML).toContain('data-screen="activity"');
		expect(browser.mainContent.innerHTML).toContain('aria-label="Forum navigation"');
		expect(browser.mainContent.innerHTML).toContain('data-action="logout"');
		expect(browser.mainContent.innerHTML).toContain('data-chat-roster');
		expect(browser.mainContent.innerHTML).toContain('data-chat-active');
	});

	test('create/edit navigation keeps the shell mounted and logout visible', async () => {
		const browser = createMockBrowser('/create-post');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
		});

		await app.boot();
		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).toContain('data-action="logout"');
		expect(browser.mainContent.innerHTML).toContain('data-screen="create-post"');

		app.navigate('/edit-post/8');

		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).toContain('data-action="logout"');
		expect(browser.mainContent.innerHTML).toContain('data-screen="edit-post"');
	});

	test('public routes render outside authenticated shell', async () => {
		const browser = createMockBrowser('/login');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
		});

		await app.boot();
		expect(browser.mainContent.innerHTML).toContain('data-screen="login"');
		expect(browser.mainContent.innerHTML).not.toContain('data-auth-shell');

		browser.clickLink('/register');
		expect(browser.mainContent.innerHTML).toContain('data-screen="register"');
		expect(browser.mainContent.innerHTML).not.toContain('data-auth-shell');
	});

	test('login and registration routes render inside the SPA auth flow', async () => {
		const cases = [
			{ path: '/login', expected: 'data-screen="login"' },
			{ path: '/register', expected: 'data-screen="register"' },
		];

		for (const testCase of cases) {
			const browser = createMockBrowser(testCase.path);
			const app = createApp({
				windowRef: browser.windowRef,
				documentRef: browser.documentRef,
				fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			});

			await app.boot();

			expect(browser.mainContent.innerHTML).toContain(testCase.expected);
			expect(browser.mainContent.innerHTML).not.toContain('data-auth-shell');
		}
	});

	test('registration route renders all required D10 fields', async () => {
		const browser = createMockBrowser('/register');
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
		});

		await app.boot();

		expect(browser.mainContent.innerHTML).toContain('name="first_name"');
		expect(browser.mainContent.innerHTML).toContain('name="last_name"');
		expect(browser.mainContent.innerHTML).toContain('name="age"');
		expect(browser.mainContent.innerHTML).toContain('name="gender"');
		expect(browser.mainContent.innerHTML).toContain('name="username"');
		expect(browser.mainContent.innerHTML).toContain('name="email"');
		expect(browser.mainContent.innerHTML).toContain('name="password"');
	});

	test('auth entry routes do not expose guest or OAuth options', async () => {
		for (const path of ['/login', '/register']) {
			const browser = createMockBrowser(path);
			const app = createApp({
				windowRef: browser.windowRef,
				documentRef: browser.documentRef,
				fetchRef: vi.fn(async () => ({ ok: false, status: 401 })),
			});

			await app.boot();

			expect(browser.mainContent.innerHTML).not.toContain('Continue with Google');
			expect(browser.mainContent.innerHTML).not.toContain('/api/v1/auth/google');
			expect(browser.mainContent.innerHTML).not.toContain('/api/v1/auth/github');
			expect(browser.mainContent.innerHTML).not.toContain('Continue as guest');
			expect(browser.mainContent.innerHTML).not.toContain('guest-login');
		}
	});

	test('logout button calls API and returns user to login flow', async () => {
		const browser = createMockBrowser('/activity');
		const fetchRef = vi.fn(async (url) => {
			if (url === '/api/v1/users/me') {
				return { ok: true, status: 200 };
			}
			if (url === '/api/v1/users/logout') {
				return { ok: true, status: 200 };
			}
			return { ok: false, status: 404 };
		});

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();
		expect(browser.mainContent.innerHTML).toContain('data-action="logout"');

		const event = browser.clickLogout();
		await Promise.resolve();

		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(fetchRef).toHaveBeenCalledWith('/api/v1/users/logout', {
			method: 'POST',
			credentials: 'include',
			headers: {
				Accept: 'application/json',
			},
		});
		expect(app.getState().isAuthenticated).toBe(false);
		expect(browser.windowRef.location.pathname).toBe('/login');
		expect(browser.mainContent.innerHTML).toContain('data-screen="login"');
		expect(browser.mainContent.innerHTML).not.toContain('data-auth-shell');
	});

	test('logout does not force local logout when backend returns non-OK response', async () => {
		const browser = createMockBrowser('/activity');
		let resolveLogoutRequest;
		const logoutRequest = new Promise((resolve) => {
			resolveLogoutRequest = resolve;
		});

		const fetchRef = vi.fn((url) => {
			if (url === '/api/v1/users/me') {
				return Promise.resolve({ ok: true, status: 200 });
			}
			if (url === '/api/v1/users/logout') {
				return logoutRequest;
			}
			return Promise.resolve({ ok: false, status: 404 });
		});

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();

		const event = browser.clickLogout();

		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(fetchRef).toHaveBeenCalledWith('/api/v1/users/logout', {
			method: 'POST',
			credentials: 'include',
			headers: {
				Accept: 'application/json',
			},
		});

		resolveLogoutRequest({ ok: false, status: 500 });
		await Promise.resolve();
		await Promise.resolve();

		expect(app.getState().isAuthenticated).toBe(true);
		expect(browser.windowRef.location.pathname).toBe('/activity');
		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).not.toContain('data-screen="login"');
	});

	test('logout does not force local logout when request rejects', async () => {
		const browser = createMockBrowser('/activity');
		let rejectLogoutRequest;
		const logoutRequest = new Promise((_, reject) => {
			rejectLogoutRequest = reject;
		});

		const fetchRef = vi.fn((url) => {
			if (url === '/api/v1/users/me') {
				return Promise.resolve({ ok: true, status: 200 });
			}
			if (url === '/api/v1/users/logout') {
				return logoutRequest;
			}
			return Promise.resolve({ ok: false, status: 404 });
		});

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();

		const event = browser.clickLogout();

		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(fetchRef).toHaveBeenCalledWith('/api/v1/users/logout', {
			method: 'POST',
			credentials: 'include',
			headers: {
				Accept: 'application/json',
			},
		});

		rejectLogoutRequest(new TypeError('Network failure'));
		await Promise.resolve();
		await Promise.resolve();

		expect(app.getState().isAuthenticated).toBe(true);
		expect(browser.windowRef.location.pathname).toBe('/activity');
		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).not.toContain('data-screen="login"');
	});

	test('logout still finalizes locally when backend reports session is already invalid', async () => {
		const browser = createMockBrowser('/activity');
		const fetchRef = vi.fn(async (url) => {
			if (url === '/api/v1/users/me') {
				return { ok: true, status: 200 };
			}
			if (url === '/api/v1/users/logout') {
				return { ok: false, status: 401 };
			}
			return { ok: false, status: 404 };
		});

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();

		browser.clickLogout();
		await Promise.resolve();

		expect(app.getState().isAuthenticated).toBe(false);
		expect(browser.windowRef.location.pathname).toBe('/login');
		expect(browser.mainContent.innerHTML).toContain('data-screen="login"');
		expect(browser.mainContent.innerHTML).not.toContain('data-auth-shell');
	});

	test('logout is usable from every authenticated route', async () => {
		const protectedRoutes = ['/', '/posts/9', '/create-post', '/edit-post/3', '/activity'];

		for (const path of protectedRoutes) {
			const browser = createMockBrowser(path);
			const fetchRef = vi.fn(async (url) => {
				if (url === '/api/v1/users/me') {
					return { ok: true, status: 200 };
				}
				if (url === '/api/v1/users/logout') {
					return { ok: true, status: 200 };
				}
				return { ok: false, status: 404 };
			});

			const app = createApp({
				windowRef: browser.windowRef,
				documentRef: browser.documentRef,
				fetchRef,
			});

			await app.boot();
			expect(browser.mainContent.innerHTML).toContain('data-action="logout"');

			browser.clickLogout();
			await Promise.resolve();

			expect(browser.windowRef.location.pathname).toBe('/login');
			expect(app.getState().isAuthenticated).toBe(false);
		}
	});

	test('login-form submit is delegated through the auth feature and prevented', async () => {
		const browser = createMockBrowser('/login');
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		const canHandleAuthForm = vi
			.spyOn(authHandlers, 'canHandleAuthForm')
			.mockImplementation((form) => form?.id === 'login-form' || form?.id === 'register-form');
		const handleAuthFormSubmit = vi
			.spyOn(authHandlers, 'handleAuthFormSubmit')
			.mockResolvedValue({ handled: true });
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();

		const event = browser.submitForm('login-form');
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(canHandleAuthForm).toHaveBeenCalled();
		expect(handleAuthFormSubmit).toHaveBeenCalledWith({
			form: expect.objectContaining({ id: 'login-form' }),
			fetchRef,
			navigate: expect.any(Function),
			onSuccess: expect.any(Function),
		});
	});

	test('register-form submit is delegated through the auth feature and prevented', async () => {
		const browser = createMockBrowser('/register');
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		const canHandleAuthForm = vi
			.spyOn(authHandlers, 'canHandleAuthForm')
			.mockImplementation((form) => form?.id === 'login-form' || form?.id === 'register-form');
		const handleAuthFormSubmit = vi
			.spyOn(authHandlers, 'handleAuthFormSubmit')
			.mockResolvedValue({ handled: true });
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();

		const event = browser.submitForm('register-form');
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(canHandleAuthForm).toHaveBeenCalled();
		expect(handleAuthFormSubmit).toHaveBeenCalledWith({
			form: expect.objectContaining({ id: 'register-form' }),
			fetchRef,
			navigate: expect.any(Function),
			onSuccess: expect.any(Function),
		});
	});

	test('non-critical forms should not be intercepted by default', async () => {
		const browser = createMockBrowser('/');
		const handleAuthFormSubmit = vi
			.spyOn(authHandlers, 'handleAuthFormSubmit')
			.mockResolvedValue({ handled: true });
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: vi.fn(async () => ({ ok: true, status: 200 })),
		});

		await app.boot();

		const event = browser.submitForm('search-form');
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(handleAuthFormSubmit).not.toHaveBeenCalled();
	});

	test('successful delegated auth marks the session as authenticated and lands on /', async () => {
		const browser = createMockBrowser('/login');
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		vi.spyOn(authHandlers, 'canHandleAuthForm').mockImplementation(
			(form) => form?.id === 'login-form' || form?.id === 'register-form',
		);
		vi.spyOn(authHandlers, 'handleAuthFormSubmit').mockImplementation(
			async ({ navigate, onSuccess }) => {
				onSuccess?.({
					kind: 'login',
					response: { ok: true, status: 200 },
					responseBody: { data: { message: 'ok' } },
				});
				navigate?.('/', { replace: true });
				return { handled: true, ok: true, kind: 'login' };
			},
		);
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();
		browser.submitForm('login-form');

		expect(app.getState().isAuthenticated).toBe(true);
		expect(browser.windowRef.location.pathname).toBe('/');
		expect(browser.mainContent.innerHTML).toContain('data-auth-shell');
		expect(browser.mainContent.innerHTML).toContain('data-screen="feed"');
	});

	test('failed delegated auth stays on the current auth route', async () => {
		const browser = createMockBrowser('/register');
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401 }));
		vi.spyOn(authHandlers, 'canHandleAuthForm').mockImplementation(
			(form) => form?.id === 'login-form' || form?.id === 'register-form',
		);
		vi.spyOn(authHandlers, 'handleAuthFormSubmit').mockImplementation(async () => ({
			handled: true,
			ok: false,
			kind: 'register',
			message: 'Registration failed.',
		}));
		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef,
		});

		await app.boot();
		browser.submitForm('register-form');

		expect(app.getState().isAuthenticated).toBe(false);
		expect(browser.windowRef.location.pathname).toBe('/register');
		expect(browser.mainContent.innerHTML).toContain('data-screen="register"');
	});

	test('session recovery: a post-boot 401 response downgrades session, stops notifications & chat, and redirects to /login', async () => {
		const browser = createMockBrowser('/');
		const chatSocket = { open: vi.fn(), close: vi.fn() };

		let capturedFetch = null;
		const mockNotificationCenter = {
			start: vi.fn(),
			stop: vi.fn(),
		};

		vi.spyOn(notificationPage, 'createNotificationCenter').mockImplementation((opts) => {
			capturedFetch = opts.fetchRef;
			return mockNotificationCenter;
		});

		let callCount = 0;
		const fetchMock = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				return { ok: true, status: 200, json: async () => ({}) };
			}
			return { ok: false, status: 401 };
		});

		const app = createApp({
			windowRef: browser.windowRef,
			documentRef: browser.documentRef,
			fetchRef: fetchMock,
			chatSocket,
		});

		await app.boot();

		expect(app.getState().isAuthenticated).toBe(true);
		expect(mockNotificationCenter.start).toHaveBeenCalledTimes(1);
		expect(chatSocket.open).toHaveBeenCalledTimes(1);
		expect(capturedFetch).toBeTypeOf('function');

		const response = await capturedFetch('/api/v1/posts');
		expect(response.status).toBe(401);

		expect(app.getState().isAuthenticated).toBe(false);
		expect(mockNotificationCenter.stop).toHaveBeenCalledTimes(1);
		expect(chatSocket.close).toHaveBeenCalledTimes(1);
		expect(browser.windowRef.location.pathname).toBe('/login');
	});
});
