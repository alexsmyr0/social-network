// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import { createAppRouter } from '../../../../../src/app/router.js';
import LoginPage from '../../../../../src/features/auth/LoginPage.vue';
import { createSessionState, sessionKey } from '../../../../../src/features/auth/session-state.js';

const account = { id: 42, email: 'alex@example.com', display_name: 'Alex Example' };

async function mountPage(login, path = '/login') {
	const session = createSessionState({ login });
	const router = createAppRouter(createMemoryHistory());
	await router.push(path);
	const wrapper = mount(LoginPage, {
		attachTo: document.body,
		global: { plugins: [router], provide: { [sessionKey]: session } },
	});
	return { router, session, wrapper };
}

async function fill(wrapper) {
	await wrapper.get('[name="email"]').setValue(' alex@example.com ');
	await wrapper.get('[name="password"]').setValue(' correct horse ');
}

beforeEach(() => vi.stubGlobal('scrollTo', vi.fn()));

afterEach(() => {
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('SN-A05 login UI', () => {
	test('validates required fields accessibly before sending', async () => {
		const login = vi.fn();
		const { wrapper } = await mountPage(login);
		await wrapper.get('form').trigger('submit');
		expect(wrapper.findAll('.field-error')).toHaveLength(2);
		expect(document.activeElement).toBe(wrapper.get('[name="email"]').element);
		expect(login).not.toHaveBeenCalled();
	});

	test('signs in once, keeps the password exact and returns to the requested route', async () => {
		let finish;
		const login = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { router, session, wrapper } = await mountPage(login, '/login?redirect=/');
		await fill(wrapper);
		await wrapper.get('form').trigger('submit');
		await wrapper.get('form').trigger('submit');
		expect(login).toHaveBeenCalledTimes(1);
		expect(login).toHaveBeenCalledWith({
			email: 'alex@example.com',
			password: ' correct horse ',
		});
		expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();

		finish({ status: 'authenticated', account });
		await flushPromises();
		expect(session.state.account).toEqual(account);
		expect(router.currentRoute.value.fullPath).toBe('/');
	});

	test('uses the same message for invalid credentials and preserves recoverable fields', async () => {
		const login = vi.fn(async () => ({ status: 'invalid-credentials' }));
		const { wrapper } = await mountPage(login);
		await fill(wrapper);
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(wrapper.get('[role="alert"]').text()).toContain('wasn’t recognized');
		expect(wrapper.get('[name="email"]').element.value).toBe('alex@example.com');
		expect(wrapper.get('[name="password"]').element.value).toBe(' correct horse ');
	});

	test('shows service failure without claiming logout and supports retry', async () => {
		const login = vi
			.fn()
			.mockResolvedValueOnce({ status: 'unavailable' })
			.mockResolvedValueOnce({ status: 'authenticated', account });
		const { router, wrapper } = await mountPage(login);
		await fill(wrapper);
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(wrapper.get('[role="alert"]').text()).toContain('isn’t responding');
		expect(wrapper.get('[name="password"]').element.value).toBe(' correct horse ');

		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(login).toHaveBeenCalledTimes(2);
		expect(router.currentRoute.value.fullPath).toBe('/');
	});

	test('rejects external return URLs after successful login', async () => {
		const { router, wrapper } = await mountPage(
			vi.fn(async () => ({ status: 'authenticated', account })),
			'/login?redirect=//evil.example',
		);
		await fill(wrapper);
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(router.currentRoute.value.fullPath).toBe('/');
	});
});
