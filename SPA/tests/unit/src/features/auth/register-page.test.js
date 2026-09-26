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

const account = { id: 42, email: 'alex@example.com', display_name: 'Alex Example' };
const lost = () => Promise.reject(new TypeError('Failed to fetch'));

// Contract fixture: routes each request to a per-endpoint queue of handlers.
// The last handler in a queue repeats; an unrouted request fails the test.
function contractFetch(routes) {
	const queues = Object.fromEntries(
		Object.entries(routes).map(([path, list]) => [path, [...list]]),
	);
	return vi.fn(async (path, request) => {
		const queue = queues[path];
		if (!queue) throw new Error(`Unexpected request to ${path}`);
		const handler = queue.length > 1 ? queue.shift() : queue[0];
		return handler(request);
	});
}

function callsTo(fetchRef, path) {
	return fetchRef.mock.calls.filter(([called]) => called === path);
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function selectAvatar(wrapper, file) {
	const input = wrapper.get('[name="avatar"]');
	Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
	return input.trigger('change');
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
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValueOnce(response({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503));
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

		expect(wrapper.get('[data-recovery-state]').attributes('data-recovery-state')).toBe('unknown');
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

	describe('avatar replacement', () => {
		test('an invalid replacement discards the earlier valid avatar and blocks submit', async () => {
			const fetchRef = contractFetch({
				'/api/v1/users/register': [async () => response({ data: account })],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await selectAvatar(wrapper, new File(['jpg'], 'valid.jpg', { type: 'image/jpeg' }));
			expect(wrapper.find('.avatar-preview img').exists()).toBe(true);

			await selectAvatar(wrapper, new File(['txt'], 'notes.txt', { type: 'text/plain' }));
			expect(wrapper.find('.avatar-preview img').exists()).toBe(false);
			expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar');
			expect(wrapper.get('#avatar-error').text()).toContain('valid JPEG, PNG or GIF');

			await wrapper.get('form').trigger('submit');
			await flushPromises();
			expect(fetchRef).not.toHaveBeenCalled();
			expect(wrapper.get('#avatar-error').exists()).toBe(true);
			expect(document.activeElement).toBe(wrapper.get('[name="avatar"]').element);

			await wrapper.get('.text-button').trigger('click');
			expect(wrapper.find('#avatar-error').exists()).toBe(false);
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			const [, request] = callsTo(fetchRef, '/api/v1/users/register')[0];
			expect(typeof request.body).toBe('string');
			expect(request.body).not.toContain('valid.jpg');
		});

		test('an oversized replacement cannot upload the earlier file either', async () => {
			const wrapper = mountPage();
			await selectAvatar(wrapper, new File(['png'], 'valid.png', { type: 'image/png' }));
			const huge = new File(['gif'], 'huge.gif', { type: 'image/gif' });
			Object.defineProperty(huge, 'size', { value: 5 * 1024 * 1024 + 1 });
			await selectAvatar(wrapper, huge);

			expect(wrapper.text()).toContain('under 5 MiB');
			expect(wrapper.text()).toContain('Choose an avatar');
			expect(wrapper.text()).toContain('Clear image selection');
		});

		test('a new valid avatar after an invalid one is the file that uploads', async () => {
			const fetchRef = contractFetch({
				'/api/v1/users/register': [async () => response({ data: account })],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await selectAvatar(wrapper, new File(['jpg'], 'valid.jpg', { type: 'image/jpeg' }));
			await selectAvatar(wrapper, new File(['bmp'], 'bad.bmp', { type: 'image/bmp' }));
			const replacement = new File(['gif'], 'replacement.gif', { type: 'image/gif' });
			await selectAvatar(wrapper, replacement);

			expect(wrapper.find('#avatar-error').exists()).toBe(false);
			expect(wrapper.get('.avatar-preview img').attributes('src')).toBe('blob:avatar');
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			const [, request] = callsTo(fetchRef, '/api/v1/users/register')[0];
			expect(request.body.get('avatar')).toBe(replacement);
		});

		test('a removed avatar is omitted from the registration request', async () => {
			const fetchRef = contractFetch({
				'/api/v1/users/register': [async () => response({ data: account })],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await selectAvatar(wrapper, new File(['jpg'], 'valid.jpg', { type: 'image/jpeg' }));
			await wrapper.get('.text-button').trigger('click');
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			const [, request] = callsTo(fetchRef, '/api/v1/users/register')[0];
			expect(typeof request.body).toBe('string');
		});

		test('associates the avatar hint and error with the file input', async () => {
			const wrapper = mountPage();
			const input = wrapper.get('[name="avatar"]');
			expect(input.attributes('aria-describedby')).toBe('avatar-hint');
			expect(input.attributes('aria-invalid')).toBe('false');

			await selectAvatar(wrapper, new File(['txt'], 'notes.txt', { type: 'text/plain' }));
			expect(input.attributes('aria-describedby')).toBe('avatar-hint avatar-error');
			expect(input.attributes('aria-invalid')).toBe('true');
			expect(document.getElementById('avatar-error').textContent).toContain('valid JPEG');
			// The hidden input precedes its label so CSS can mirror keyboard focus.
			expect(input.element.nextElementSibling).toBe(wrapper.get('label.file-button').element);
		});
	});

	describe('ambiguous registration recovery', () => {
		const REGISTER = '/api/v1/users/register';
		const ME = '/api/v1/users/me';
		const LOGIN = '/api/v1/users/login';

		test('fixture A: lost response, /users/me 200 completes registration without a resubmit', async () => {
			const fetchRef = contractFetch({
				[REGISTER]: [lost],
				[ME]: [async () => response({ data: account }, 200)],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			expect(fetchRef.mock.calls.map(([path]) => path)).toEqual([REGISTER, ME]);
			expect(callsTo(fetchRef, ME)[0][1].credentials).toBe('include');
			const success = wrapper.get('.registration-success');
			expect(success.attributes('data-recovered-by')).toBe('session');
			expect(success.text()).toContain('Welcome, Alex Example');
			expect(success.text()).toContain('your account was created');
		});

		test('treats a success status with an unreadable body as ambiguous', async () => {
			const fetchRef = contractFetch({
				[REGISTER]: [
					async () => ({
						ok: true,
						status: 201,
						json: async () => Promise.reject(new SyntaxError()),
					}),
				],
				[ME]: [async () => response({ data: account }, 200)],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			expect(callsTo(fetchRef, REGISTER)).toHaveLength(1);
			expect(wrapper.get('.registration-success').attributes('data-recovered-by')).toBe('session');
		});

		test('shows the checking state and blocks every request while /users/me is pending', async () => {
			const me = deferred();
			const fetchRef = contractFetch({ [REGISTER]: [lost], [ME]: [() => me.promise] });
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			const panel = wrapper.get('[data-recovery-state]');
			expect(panel.attributes('data-recovery-state')).toBe('checking');
			expect(panel.text()).toContain('Checking whether your account was created');
			expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
			await wrapper.get('form').trigger('submit');
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			expect(callsTo(fetchRef, REGISTER)).toHaveLength(1);
			expect(callsTo(fetchRef, ME)).toHaveLength(1);

			me.resolve(response({ data: account }, 200));
			await flushPromises();
			expect(wrapper.find('.registration-success').exists()).toBe(true);
		});

		test('fixture B: /users/me 401 offers login first, then an explicit registration retry', async () => {
			const fetchRef = contractFetch({
				[REGISTER]: [lost, async () => response({ data: account })],
				[ME]: [async () => response({ error: { code: 'UNAUTHORIZED' } }, 401)],
				[LOGIN]: [
					async () =>
						response(
							{ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } },
							401,
						),
				],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			const panel = () => wrapper.get('[data-recovery-state]');
			expect(panel().attributes('data-recovery-state')).toBe('login-available');
			expect(document.activeElement).toBe(panel().element);
			expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
			expect(wrapper.text()).not.toContain('Retry creating my account');

			// Enter/submit cannot bypass the login step.
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			expect(callsTo(fetchRef, REGISTER)).toHaveLength(1);
			expect(callsTo(fetchRef, LOGIN)).toHaveLength(0);

			await wrapper.get('.recovery-panel__action').trigger('click');
			await flushPromises();
			const [, login] = callsTo(fetchRef, LOGIN)[0];
			expect(JSON.parse(login.body)).toEqual({
				email: 'alex@example.com',
				password: 'correct horse battery',
			});
			expect(login.headers['X-Requested-With']).toBe('XMLHttpRequest');
			expect(panel().attributes('data-recovery-state')).toBe('retry-available');
			expect(callsTo(fetchRef, REGISTER)).toHaveLength(1);

			const retry = wrapper.get('button[type="submit"]');
			expect(retry.text()).toBe('Retry creating my account');
			expect(retry.attributes('disabled')).toBeUndefined();
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			expect(fetchRef.mock.calls.map(([path]) => path)).toEqual([REGISTER, ME, LOGIN, REGISTER]);
			expect(wrapper.get('.registration-success').attributes('data-recovered-by')).toBeUndefined();
		});

		test('fixture B: a successful recovery login uses the returned account and never re-registers', async () => {
			const fetchRef = contractFetch({
				[REGISTER]: [lost],
				[ME]: [async () => response({ error: { code: 'UNAUTHORIZED' } }, 401)],
				[LOGIN]: [async () => response({ data: account }, 200)],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			await wrapper.get('.recovery-panel__action').trigger('click');
			await flushPromises();

			expect(fetchRef.mock.calls.map(([path]) => path)).toEqual([REGISTER, ME, LOGIN]);
			const success = wrapper.get('.registration-success');
			expect(success.attributes('data-recovered-by')).toBe('login');
			expect(success.text()).toContain('Welcome, Alex Example');
		});

		test('repeated login clicks send a single recovery login', async () => {
			const login = deferred();
			const fetchRef = contractFetch({
				[REGISTER]: [lost],
				[ME]: [async () => response({ error: { code: 'UNAUTHORIZED' } }, 401)],
				[LOGIN]: [() => login.promise],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			const action = wrapper.get('.recovery-panel__action');
			action.element.click();
			action.element.click();
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			expect(callsTo(fetchRef, LOGIN)).toHaveLength(1);
			expect(callsTo(fetchRef, REGISTER)).toHaveLength(1);
			expect(wrapper.get('[data-recovery-state]').attributes('data-recovery-state')).toBe(
				'signing-in',
			);

			login.resolve(response({ data: account }, 200));
			await flushPromises();
			expect(wrapper.find('.registration-success').exists()).toBe(true);
		});

		test('repeated retry clicks send a single explicit registration retry', async () => {
			const retry = deferred();
			const fetchRef = contractFetch({
				[REGISTER]: [lost, () => retry.promise],
				[ME]: [async () => response({ error: { code: 'UNAUTHORIZED' } }, 401)],
				[LOGIN]: [async () => response({ error: { code: 'INVALID_CREDENTIALS' } }, 401)],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			await wrapper.get('.recovery-panel__action').trigger('click');
			await flushPromises();

			await wrapper.get('form').trigger('submit');
			await wrapper.get('form').trigger('submit');
			await wrapper.get('form').trigger('submit');
			await flushPromises();
			expect(callsTo(fetchRef, REGISTER)).toHaveLength(2);

			retry.resolve(response({ data: account }));
			await flushPromises();
			expect(wrapper.find('.registration-success').exists()).toBe(true);
		});

		test('an unavailable recovery step stays unknown and restarts at /users/me', async () => {
			const fetchRef = contractFetch({
				[REGISTER]: [lost],
				[ME]: [
					lost,
					async () => response({ error: { code: 'UNAUTHORIZED' } }, 401),
					async () => response({ data: account }, 200),
				],
				[LOGIN]: [async () => response({ error: { code: 'INTERNAL_SERVER_ERROR' } }, 500)],
			});
			const wrapper = mountPage(fetchRef);
			await fillRequired(wrapper);
			await wrapper.get('form').trigger('submit');
			await flushPromises();

			const state = () => wrapper.get('[data-recovery-state]').attributes('data-recovery-state');
			expect(state()).toBe('unknown');
			expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();

			await wrapper.get('.recovery-panel__action').trigger('click');
			await flushPromises();
			expect(state()).toBe('login-available');

			await wrapper.get('.recovery-panel__action').trigger('click');
			await flushPromises();
			expect(state()).toBe('unknown');
			expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();

			await wrapper.get('.recovery-panel__action').trigger('click');
			await flushPromises();
			expect(fetchRef.mock.calls.map(([path]) => path)).toEqual([REGISTER, ME, ME, LOGIN, ME]);
			expect(wrapper.get('.registration-success').attributes('data-recovered-by')).toBe('session');
		});
	});
});
