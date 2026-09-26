// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';

import {
	REGISTER_PATH,
	RegistrationError,
	registerAccount,
	registrationPayload,
} from '../../../../src/api/registration.js';

const values = {
	email: ' Alex@Example.com ',
	password: ' correct horse ',
	firstName: ' Alex ',
	lastName: ' Example ',
	dateOfBirth: '1998-03-14',
	nickname: ' ',
	aboutMe: '',
	avatar: null,
};

describe('registration contract adapter', () => {
	test('normalizes contract fields without modifying the password', () => {
		expect(registrationPayload(values)).toEqual({
			email: 'Alex@Example.com',
			password: ' correct horse ',
			first_name: 'Alex',
			last_name: 'Example',
			date_of_birth: '1998-03-14',
			nickname: null,
			about_me: null,
		});
	});

	test('sends required-only registration as credentialed JSON', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: { id: 42, display_name: 'Alex Example' } }),
		}));

		await expect(registerAccount(values, fetchRef)).resolves.toMatchObject({ id: 42 });
		const [path, request] = fetchRef.mock.calls[0];
		expect(path).toBe(REGISTER_PATH);
		expect(request.credentials).toBe('include');
		expect(request.headers['X-Requested-With']).toBe('XMLHttpRequest');
		expect(JSON.parse(request.body)).toMatchObject({
			email: 'Alex@Example.com',
			nickname: null,
			about_me: null,
		});
		expect(request.body).toContain(' correct horse ');
	});

	test('uses multipart with populated optionals and an avatar', async () => {
		const avatar = new File(['png'], 'face.png', { type: 'image/png' });
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 201,
			json: async () => ({ data: { id: 42 } }),
		}));

		await registerAccount(
			{ ...values, nickname: ' Alex E ', aboutMe: ' Hello ', avatar },
			fetchRef,
		);
		const request = fetchRef.mock.calls[0][1];
		expect(request.body).toBeInstanceOf(FormData);
		expect(request.body.get('nickname')).toBe('Alex E');
		expect(request.body.get('about_me')).toBe('Hello');
		expect(request.body.get('avatar')).toBe(avatar);
		expect(request.headers['Content-Type']).toBeUndefined();
	});

	test('returns structured server and network failures without logging secrets', async () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const duplicate = vi.fn(async () => ({
			ok: false,
			status: 409,
			json: async () => ({
				error: {
					code: 'EMAIL_TAKEN',
					message: 'Email is already registered',
					fields: { email: 'EMAIL_TAKEN' },
				},
			}),
		}));

		await expect(registerAccount(values, duplicate)).rejects.toMatchObject({
			code: 'EMAIL_TAKEN',
			status: 409,
			fields: { email: 'EMAIL_TAKEN' },
		});
		await expect(
			registerAccount(
				values,
				vi.fn(async () => Promise.reject(new TypeError())),
			),
		).rejects.toBeInstanceOf(RegistrationError);
		expect(consoleSpy).not.toHaveBeenCalled();
	});
});
