// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import RegisterPage from '../../../../../src/features/auth/RegisterPage.vue';

function response(data, status = 201) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
	};
}

function mountPage(fetchRef = vi.fn()) {
	vi.stubGlobal('fetch', fetchRef);
	return mount(RegisterPage, {
		attachTo: document.body,
		global: {
			stubs: { RouterLink: { template: '<a><slot /></a>' } },
		},
	});
}

async function fillRequired(wrapper) {
	await wrapper.get('[name="email"]').setValue('alex@example.com');
	await wrapper.get('[name="password"]').setValue('correct horse battery');
	await wrapper.get('[name="firstName"]').setValue('Alex');
	await wrapper.get('[name="lastName"]').setValue('Example');
	await wrapper.get('[name="dateOfBirth"]').setValue('1998-03-14');
}

describe('SN-A04 registration UI', () => {
	beforeEach(() => {
		vi.stubGlobal('URL', {
			createObjectURL: vi.fn(() => 'blob:avatar'),
			revokeObjectURL: vi.fn(),
		});
	});

	afterEach(() => {
		document.body.innerHTML = '';
		vi.unstubAllGlobals();
	});

	test('shows accessible required errors and focuses the first invalid field', async () => {
		const wrapper = mountPage();
		await wrapper.get('form').trigger('submit');

		expect(wrapper.findAll('.field-error')).toHaveLength(5);
		expect(wrapper.get('[name="email"]').attributes('aria-invalid')).toBe('true');
		expect(document.activeElement).toBe(wrapper.get('[name="email"]').element);
		expect(fetch).not.toHaveBeenCalled();
	});

	test('submits omitted and populated optional fields with contract names', async () => {
		const fetchRef = vi.fn(async () =>
			response({ data: { id: 42, display_name: 'Alex Example' } }),
		);
		const wrapper = mountPage(fetchRef);
		await fillRequired(wrapper);
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		const omitted = JSON.parse(fetchRef.mock.calls[0][1].body);
		expect(omitted).toMatchObject({ nickname: null, about_me: null, date_of_birth: '1998-03-14' });

		const second = mountPage(fetchRef);
		await fillRequired(second);
		await second.get('[name="nickname"]').setValue('Alex E');
		await second.get('[name="aboutMe"]').setValue('I like hiking.');
		await second.get('form').trigger('submit');
		await flushPromises();
		const populated = JSON.parse(fetchRef.mock.calls[1][1].body);
		expect(populated).toMatchObject({ nickname: 'Alex E', about_me: 'I like hiking.' });
		expect(second.text()).toContain('Welcome, Alex Example');
	});

	test.each([
		['portrait.jpg', 'image/jpeg'],
		['portrait.png', 'image/png'],
		['portrait.gif', 'image/gif'],
	])('previews and can remove a selected %s avatar', async (name, type) => {
		const wrapper = mountPage();
		const input = wrapper.get('[name="avatar"]');
		const avatar = new File(['image'], name, { type });
		Object.defineProperty(input.element, 'files', { configurable: true, value: [avatar] });
		await input.trigger('change');

		expect(wrapper.get('.avatar-preview img').attributes('src')).toBe('blob:avatar');
		expect(wrapper.text()).toContain('Remove selected image');
		await wrapper.get('.text-button').trigger('click');
		expect(wrapper.find('.avatar-preview img').exists()).toBe(false);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar');
	});

	test('maps duplicate email and avatar upload failures while preserving values', async () => {
		const fetchRef = vi
			.fn()
			.mockResolvedValueOnce(
				response(
					{
						error: {
							code: 'EMAIL_TAKEN',
							message: 'Email is already registered',
							fields: { email: 'EMAIL_TAKEN' },
						},
					},
					409,
				),
			)
			.mockRejectedValueOnce(new TypeError('offline'));
		const wrapper = mountPage(fetchRef);
		await fillRequired(wrapper);
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(wrapper.text()).toContain('already belongs to an account');
		expect(wrapper.get('[name="email"]').element.value).toBe('alex@example.com');

		const input = wrapper.get('[name="avatar"]');
		const avatar = new File(['gif'], 'portrait.gif', { type: 'image/gif' });
		Object.defineProperty(input.element, 'files', { configurable: true, value: [avatar] });
		await input.trigger('change');
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(wrapper.get('[role="alert"]').text()).toContain('could not confirm');
		expect(wrapper.get('[name="password"]').element.value).toBe('correct horse battery');
		expect(wrapper.find('.avatar-preview img').exists()).toBe(true);
	});

	test('prevents a duplicate submit while the request is pending', async () => {
		let finish;
		const fetchRef = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const wrapper = mountPage(fetchRef);
		await fillRequired(wrapper);
		await wrapper.get('form').trigger('submit');
		await wrapper.get('form').trigger('submit');

		expect(fetchRef).toHaveBeenCalledTimes(1);
		expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
		finish(response({ data: { id: 42, display_name: 'Alex Example' } }));
		await flushPromises();
	});
});
