// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import App from '../../../../src/app/App.vue';
import { createAppRouter } from '../../../../src/app/router.js';

async function mountAt(path, fetchRef) {
	vi.stubGlobal('fetch', fetchRef);
	vi.stubGlobal('scrollTo', vi.fn());
	const router = createAppRouter(createMemoryHistory());
	await router.push(path);
	await router.isReady();

	const wrapper = mount(App, {
		attachTo: document.body,
		global: { plugins: [router] },
	});
	await flushPromises();

	return { router, wrapper };
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
		const { wrapper } = await mountAt('/login', fetchRef);

		expect(wrapper.get('[role="alert"]').text()).toContain('Connection interrupted');
		await wrapper.get('.health-status__retry').trigger('click');
		await flushPromises();

		expect(wrapper.get('.health-status').text()).toContain('Backend connected');
		expect(fetchRef).toHaveBeenCalledTimes(2);
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
