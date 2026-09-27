// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import App from '../../../../src/app/App.vue';
import { createAppRouter } from '../../../../src/app/router.js';
import { createSessionState, sessionKey } from '../../../../src/features/auth/session-state.js';

const account = { id: 42, email: 'alex@example.com', display_name: 'Alex Example' };

async function mountAt(
	path,
	fetchRef,
	{
		current = { status: 'authenticated', account },
		logout = vi.fn(async () => ({ status: 'logged-out' })),
	} = {},
) {
	vi.stubGlobal('fetch', fetchRef);
	vi.stubGlobal('scrollTo', vi.fn());
	const session = createSessionState({
		fetchCurrent: vi.fn(async () => current),
		logout,
	});
	const router = createAppRouter(createMemoryHistory(), session);
	await router.push(path);
	await router.isReady();

	const wrapper = mount(App, {
		attachTo: document.body,
		global: { plugins: [router], provide: { [sessionKey]: session } },
	});
	await flushPromises();

	return { router, session, wrapper };
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('framework shell', () => {
	test('renders the home route and successful proxy health state', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { status: 'ok' } }),
		}));
		const { wrapper } = await mountAt('/', fetchRef);

		expect(wrapper.get('[data-screen="home"]').isVisible()).toBe(true);
		expect(wrapper.get('.health-status').text()).toContain('Backend connected');
		expect(document.title).toBe('Home · Commonplace');
	});

	test('shows an honest error with a retry action when transport fails', async () => {
		const fetchRef = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ data: { status: 'ok' } }),
			});
		const { wrapper } = await mountAt('/login', fetchRef, {
			current: { status: 'unauthenticated' },
		});

		expect(wrapper.get('[role="alert"]').text()).toContain('Connection interrupted');
		await wrapper.get('.health-status__retry').trigger('click');
		await flushPromises();

		expect(wrapper.get('.health-status').text()).toContain('Backend connected');
		expect(fetchRef).toHaveBeenCalledTimes(2);
	});

	test('does not expose protected content when session restoration is unavailable', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { status: 'ok' } }),
		}));
		const { wrapper } = await mountAt('/', fetchRef, {
			current: { status: 'unavailable' },
		});

		expect(wrapper.find('[data-screen="home"]').exists()).toBe(false);
		expect(wrapper.get('.session-gate').text()).toContain('still private');
	});

	test('keeps protected state on failed logout and clears it after a successful retry', async () => {
		const logout = vi
			.fn()
			.mockResolvedValueOnce({ status: 'unavailable' })
			.mockResolvedValueOnce({ status: 'logged-out' });
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { status: 'ok' } }),
		}));
		const { router, session, wrapper } = await mountAt('/', fetchRef, { logout });

		await wrapper.get('.site-nav__logout').trigger('click');
		await flushPromises();
		expect(session.state.status).toBe('authenticated');
		expect(wrapper.get('[role="alert"]').text()).toContain('still shown as signed in');
		expect(wrapper.get('[data-screen="home"]').exists()).toBe(true);

		await wrapper.get('.session-banner button').trigger('click');
		await flushPromises();
		expect(session.state.status).toBe('unauthenticated');
		expect(router.currentRoute.value.name).toBe('login');
		expect(wrapper.find('[data-screen="home"]').exists()).toBe(false);

		await router.back();
		await flushPromises();
		expect(router.currentRoute.value.name).toBe('login');
	});

	test('renders retired routes as a migration state without redirecting', async () => {
		const { router, wrapper } = await mountAt(
			'/posts/42',
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ data: { status: 'ok' } }),
			})),
		);

		expect(router.currentRoute.value.fullPath).toBe('/posts/42');
		expect(wrapper.get('[data-screen="route-unavailable"]').text()).toContain(
			'This forum route is resting.',
		);
	});
});
