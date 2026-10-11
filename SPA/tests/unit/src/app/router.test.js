import { describe, expect, test, vi } from 'vitest';
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
		'/edit-post/12',
		'/view-post/12',
		'/create-post',
		'/chat',
		'/profile/8',
	])('keeps retired route %s in place and renders the migration state', async (path) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);

		expect(router.currentRoute.value.name).toBe('not-found');
		expect(router.currentRoute.value.fullPath).toBe(path);
	});

	test.each([
		['/groups/301/posts', 'group-posts'],
		['/groups/301/posts/new', 'group-compose'],
		['/groups/301/posts?feed=following&category=2&page=3', 'group-posts'],
	])('resolves the group content route %s', async (path, expectedName) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);

		expect(router.currentRoute.value.name).toBe(expectedName);
		expect(router.currentRoute.value.fullPath).toBe(path);
		expect(router.currentRoute.value.params.id).toBe('301');
	});

	test('group post filters recover to the nearest valid state and keep the group', async () => {
		const router = createAppRouter(createMemoryHistory());
		await router.push('/groups/301/posts?feed=nope&category=abc&page=0&x=1');

		expect(router.currentRoute.value.name).toBe('group-posts');
		expect(router.currentRoute.value.params.id).toBe('301');
		expect(router.currentRoute.value.fullPath).toBe('/groups/301/posts');
		await router.push('/groups/301/posts?feed=following&feed=all&category=2&category=3');
		expect(router.currentRoute.value.fullPath).toBe('/groups/301/posts?feed=following&category=2');
	});

	test.each([
		'/groups/0/posts',
		'/groups/007/posts',
		'/groups/abc/posts/new',
		'/groups/301/posts/old',
	])('rejects the malformed group content address %s', async (path) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);

		expect(router.currentRoute.value.name).toBe('not-found');
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

	test('rechecks a cached account when another tab revokes its cookie', async () => {
		let valid = true;
		const fetchCurrent = vi.fn(async () =>
			valid
				? { status: 'authenticated', account: { id: 42, display_name: 'Alex Example' } }
				: { status: 'unauthenticated' },
		);
		const session = createSessionState({ fetchCurrent });
		const router = createAppRouter(createMemoryHistory(), session);
		await router.push('/');
		valid = false;
		await router.push('/login');

		expect(fetchCurrent).toHaveBeenCalledTimes(2);
		expect(router.currentRoute.value.name).toBe('login');
		expect(session.state.account).toBeNull();
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
