import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	canHandleAuthForm,
	handleAuthFormSubmit,
} from '../../../../features/auth/auth.handlers.js';

const originalDocument = globalThis.document;
const originalFormData = globalThis.FormData;

function installAuthTestGlobals() {
	globalThis.document = {
		createElement() {
			return {
				className: '',
				dataset: {},
				textContent: '',
				role: null,
				setAttribute(name, value) {
					this[name] = value;
				},
			};
		},
	};

	globalThis.FormData = class MockFormData {
		constructor(form) {
			this.form = form;
		}

		get(name) {
			return this.form.fields[name] ?? null;
		}
	};
}

function restoreAuthTestGlobals() {
	if (typeof originalDocument === 'undefined') {
		delete globalThis.document;
	} else {
		globalThis.document = originalDocument;
	}

	if (typeof originalFormData === 'undefined') {
		delete globalThis.FormData;
	} else {
		globalThis.FormData = originalFormData;
	}
}

function createMockAuthForm({ id, fields, submitLabel }) {
	const submitButton = {
		disabled: false,
		textContent: submitLabel,
		dataset: {},
	};

	let currentErrorNode = null;

	return {
		id,
		fields,
		submitButton,
		querySelector(selector) {
			if (selector === 'button[type="submit"]') {
				return submitButton;
			}

			if (selector === '[data-auth-error]') {
				return currentErrorNode;
			}

			return null;
		},
		prepend(node) {
			node.remove = () => {
				currentErrorNode = null;
			};
			currentErrorNode = node;
		},
		getErrorNode() {
			return currentErrorNode;
		},
	};
}

function createDeferred() {
	let resolve;
	let reject;

	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

beforeEach(() => {
	installAuthTestGlobals();
});

afterEach(() => {
	restoreAuthTestGlobals();
});

describe('SPA auth handlers', () => {
	test('identifies auth forms and ignores unrelated forms', () => {
		expect(canHandleAuthForm({ id: 'login-form' })).toBe(true);
		expect(canHandleAuthForm({ id: 'register-form' })).toBe(true);
		expect(canHandleAuthForm({ id: 'search-form' })).toBe(false);
		expect(canHandleAuthForm(null)).toBe(false);
	});

	test('returns handled false for non-auth form submissions', async () => {
		const result = await handleAuthFormSubmit({
			form: createMockAuthForm({
				id: 'search-form',
				fields: {},
				submitLabel: 'Search',
			}),
		});

		expect(result).toEqual({ handled: false });
	});

	test('maps login username submissions to the username contract', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { message: 'ok' } }),
		}));
		const navigate = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/users/login',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
			}),
		);
		const [, requestOptions] = fetchRef.mock.calls[0];
		expect(JSON.parse(requestOptions.body)).toEqual({
			username: 'alex',
			password: 'password123',
		});
	});

	test('maps login email submissions to the email contract', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex@example.com',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { message: 'ok' } }),
		}));
		const navigate = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/users/login',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
			}),
		);
		const [, requestOptions] = fetchRef.mock.calls[0];
		expect(JSON.parse(requestOptions.body)).toEqual({
			email: 'alex@example.com',
			password: 'password123',
		});
	});

	test('trims auth text fields but preserves password whitespace exactly', async () => {
		const form = createMockAuthForm({
			id: 'register-form',
			fields: {
				first_name: '  Alex  ',
				last_name: '  Smyro  ',
				age: ' 24 ',
				gender: '  male  ',
				username: '  alex  ',
				email: '  alex@example.com  ',
				password: '  password123  ',
			},
			submitLabel: 'Create Account',
		});
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: { id: 1 } }),
		}));
		const navigate = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate });

		const [, requestOptions] = fetchRef.mock.calls[0];
		expect(JSON.parse(requestOptions.body)).toEqual({
			first_name: 'Alex',
			last_name: 'Smyro',
			age: 24,
			gender: 'male',
			username: 'alex',
			email: 'alex@example.com',
			password: '  password123  ',
		});
	});

	test('omits invalid age values instead of serializing them as strings', async () => {
		const form = createMockAuthForm({
			id: 'register-form',
			fields: {
				first_name: 'Alex',
				last_name: 'Smyro',
				age: '24 years',
				gender: 'male',
				username: 'alex',
				email: 'alex@example.com',
				password: 'password123',
			},
			submitLabel: 'Create Account',
		});
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: { id: 1 } }),
		}));
		const navigate = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate });

		const [, requestOptions] = fetchRef.mock.calls[0];
		expect(JSON.parse(requestOptions.body)).toEqual({
			first_name: 'Alex',
			last_name: 'Smyro',
			gender: 'male',
			username: 'alex',
			email: 'alex@example.com',
			password: 'password123',
		});
	});

	test('successful auth routes users into the forum root', async () => {
		const form = createMockAuthForm({
			id: 'register-form',
			fields: {
				first_name: 'Alex',
				last_name: 'Smyro',
				age: '24',
				gender: 'male',
				username: 'alex',
				email: 'alex@example.com',
				password: 'password123',
			},
			submitLabel: 'Create Account',
		});
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: { id: 1 } }),
		}));
		const navigate = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/users/register',
			expect.objectContaining({
				method: 'POST',
				credentials: 'include',
			}),
		);
		const [, requestOptions] = fetchRef.mock.calls[0];
		expect(JSON.parse(requestOptions.body)).toEqual({
			first_name: 'Alex',
			last_name: 'Smyro',
			age: 24,
			gender: 'male',
			username: 'alex',
			email: 'alex@example.com',
			password: 'password123',
		});
		expect(navigate).toHaveBeenCalledWith('/', { replace: true });
		expect(form.submitButton.disabled).toBe(false);
		expect(form.submitButton.textContent).toBe('Create Account');
	});

	test('invokes onSuccess with the expected auth result details', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const responseBody = { data: { message: 'ok' } };
		const response = {
			ok: true,
			status: 200,
			json: async () => responseBody,
		};
		const fetchRef = vi.fn(async () => response);
		const navigate = vi.fn();
		const onSuccess = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate, onSuccess });

		expect(onSuccess).toHaveBeenCalledWith({
			response,
			responseBody,
			kind: 'login',
		});
	});

	test('calls onSuccess before navigate so the app shell can unlock protected routes first', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { message: 'ok' } }),
		}));
		const callOrder = [];
		const onSuccess = vi.fn(() => {
			callOrder.push('success');
		});
		const navigate = vi.fn(() => {
			callOrder.push('navigate');
		});

		await handleAuthFormSubmit({ form, fetchRef, navigate, onSuccess });

		expect(callOrder).toEqual(['success', 'navigate']);
	});

	test('failed auth shows an inline error without leaving the current route', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'wrong-password',
			},
			submitLabel: 'Sign In',
		});
		const fetchRef = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => ({
				error: {
					message: 'invalid credentials',
				},
			}),
		}));
		const navigate = vi.fn();

		const result = await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(result.ok).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
		expect(form.getErrorNode()?.textContent).toBe('invalid credentials');
		expect(form.submitButton.disabled).toBe(false);
		expect(form.submitButton.textContent).toBe('Sign In');
	});

	test('invokes onError with the expected server-error details', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'wrong-password',
			},
			submitLabel: 'Sign In',
		});
		const responseBody = {
			error: {
				message: 'invalid credentials',
			},
		};
		const response = {
			ok: false,
			status: 401,
			json: async () => responseBody,
		};
		const fetchRef = vi.fn(async () => response);
		const navigate = vi.fn();
		const onError = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate, onError });

		expect(onError).toHaveBeenCalledWith('invalid credentials', {
			response,
			responseBody,
			kind: 'login',
		});
	});

	test('failed registration shows an inline error without navigating away', async () => {
		const form = createMockAuthForm({
			id: 'register-form',
			fields: {
				first_name: 'Alex',
				last_name: 'Smyro',
				age: '24',
				gender: 'male',
				username: 'alex',
				email: 'alex@example.com',
				password: 'password123',
			},
			submitLabel: 'Create Account',
		});
		const fetchRef = vi.fn(async () => ({
			ok: false,
			status: 400,
			json: async () => ({
				error: {
					message: 'age must be positive',
				},
			}),
		}));
		const navigate = vi.fn();

		const result = await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(result.ok).toBe(false);
		expect(result.kind).toBe('register');
		expect(result.message).toBe('age must be positive');
		expect(navigate).not.toHaveBeenCalled();
		expect(form.getErrorNode()?.textContent).toBe('age must be positive');
		expect(form.submitButton.disabled).toBe(false);
		expect(form.submitButton.textContent).toBe('Create Account');
	});

	test('shows a fallback login error when the server response has no usable message', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'wrong-password',
			},
			submitLabel: 'Sign In',
		});
		const fetchRef = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => {
				throw new Error('invalid json');
			},
		}));
		const navigate = vi.fn();

		const result = await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(result.ok).toBe(false);
		expect(result.kind).toBe('login');
		expect(result.message).toBe('Login failed. Please check your credentials.');
		expect(navigate).not.toHaveBeenCalled();
		expect(form.getErrorNode()?.textContent).toBe('Login failed. Please check your credentials.');
		expect(form.submitButton.disabled).toBe(false);
		expect(form.submitButton.textContent).toBe('Sign In');
	});

	test('throws a TypeError when fetchRef is missing for an auth form', async () => {
		await expect(
			handleAuthFormSubmit({
				form: createMockAuthForm({
					id: 'login-form',
					fields: {
						identifier: 'alex',
						password: 'password123',
					},
					submitLabel: 'Sign In',
				}),
			}),
		).rejects.toThrow('fetchRef must be a function');
	});

	test('shows a network error when the auth request rejects', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const fetchRef = vi.fn(async () => {
			throw new TypeError('Network offline');
		});
		const navigate = vi.fn();

		const result = await handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(result.ok).toBe(false);
		expect(result.kind).toBe('login');
		expect(result.message).toBe('Network error. Please try again.');
		expect(result.response).toBeNull();
		expect(navigate).not.toHaveBeenCalled();
		expect(form.getErrorNode()?.textContent).toBe('Network error. Please try again.');
		expect(form.submitButton.disabled).toBe(false);
		expect(form.submitButton.textContent).toBe('Sign In');
	});

	test('invokes onError with the expected network-error details', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const requestError = new TypeError('Network offline');
		const fetchRef = vi.fn(async () => {
			throw requestError;
		});
		const navigate = vi.fn();
		const onError = vi.fn();

		await handleAuthFormSubmit({ form, fetchRef, navigate, onError });

		expect(onError).toHaveBeenCalledWith('Network error. Please try again.', {
			error: requestError,
			response: null,
			responseBody: null,
			kind: 'login',
		});
	});

	test('disables the submit button while the auth request is in flight and restores it after completion', async () => {
		const form = createMockAuthForm({
			id: 'login-form',
			fields: {
				identifier: 'alex',
				password: 'password123',
			},
			submitLabel: 'Sign In',
		});
		const request = createDeferred();
		const fetchRef = vi.fn(() => request.promise);
		const navigate = vi.fn();

		const submission = handleAuthFormSubmit({ form, fetchRef, navigate });

		expect(form.submitButton.disabled).toBe(true);
		expect(form.submitButton.textContent).toBe('Working...');

		request.resolve({
			ok: true,
			status: 200,
			json: async () => ({ data: { message: 'ok' } }),
		});
		await submission;

		expect(form.submitButton.disabled).toBe(false);
		expect(form.submitButton.textContent).toBe('Sign In');
		expect(navigate).toHaveBeenCalledWith('/', { replace: true });
	});
});
