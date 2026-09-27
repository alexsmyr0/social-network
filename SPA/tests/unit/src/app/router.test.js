import { describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import { createAppRouter } from '../../../../src/app/router.js';
import { createSessionState } from '../../../../src/features/auth/session-state.js';

describe('Vue route contract', () => {
	test.each([
		['/', 'home'],
		['/login', 'login'],
		['/register', 'register'],
	])('resolves the retained route %s', async (path, expectedName) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);

		expect(router.currentRoute.value.name).toBe(expectedName);
		expect(router.currentRoute.value.fullPath).toBe(path);
	});

	test.each([
		'/posts/12',
		'/view-post/12',
		'/create-post',
		'/activity',
		'/profile/8',
	])('keeps retired route %s in place and renders the migration state', async (path) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);

		expect(router.currentRoute.value.name).toBe('not-found');
		expect(router.currentRoute.value.fullPath).toBe(path);
	});

	test('uses the catch-all route for an unknown address', async () => {
		const router = createAppRouter(createMemoryHistory());
		await router.push('/not-a-real-place');

		expect(router.currentRoute.value.name).toBe('not-found');
	});

	test('redirects unauthenticated protected deep links and remembers the destination', async () => {
		const session = createSessionState({
			fetchCurrent: async () => ({ status: 'unauthenticated' }),
		});
		const router = createAppRouter(createMemoryHistory(), session);
		await router.push('/');

		expect(router.currentRoute.value.name).toBe('login');
		expect(router.currentRoute.value.query.redirect).toBe('/');
	});

	test('redirects restored sessions away from public-only routes', async () => {
		const session = createSessionState({
			fetchCurrent: async () => ({
				status: 'authenticated',
				account: { id: 42, display_name: 'Alex Example' },
			}),
		});
		const router = createAppRouter(createMemoryHistory(), session);
		await router.push('/login');

		expect(router.currentRoute.value.name).toBe('home');
	});

	test('keeps a protected route pending when the session service is unavailable', async () => {
		const session = createSessionState({
			fetchCurrent: async () => ({ status: 'unavailable' }),
		});
		const router = createAppRouter(createMemoryHistory(), session);
		await router.push('/');

		expect(router.currentRoute.value.name).toBe('home');
		expect(session.state.status).toBe('unavailable');
	});
});
