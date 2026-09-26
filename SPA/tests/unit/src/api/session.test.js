import { describe, expect, test, vi } from 'vitest';

import {
	CURRENT_ACCOUNT_PATH,
	fetchCurrentAccount,
	LOGIN_PATH,
	loginAccount,
} from '../../../../src/api/session.js';

const account = { id: 42, email: 'alex@example.com', display_name: 'Alex Example' };

function reply(status, body) {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => (body === undefined ? Promise.reject(new SyntaxError()) : body),
	}));
}

const offline = () => vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));

describe('session contract adapter', () => {
	test('reads the current account with the session cookie', async () => {
		const fetchRef = reply(200, { data: account });
		await expect(fetchCurrentAccount(fetchRef)).resolves.toEqual({
			status: 'authenticated',
			account,
		});
		const [path, request] = fetchRef.mock.calls[0];
		expect(path).toBe(CURRENT_ACCOUNT_PATH);
		expect(request).toMatchObject({ method: 'GET', credentials: 'include' });
	});

	test('treats only 401 as signed out; failures stay unavailable', async () => {
		await expect(
			fetchCurrentAccount(reply(401, { error: { code: 'UNAUTHORIZED' } })),
		).resolves.toEqual({ status: 'unauthenticated' });
		for (const fetchRef of [
			reply(500, { error: { code: 'INTERNAL_SERVER_ERROR' } }),
			reply(200),
			offline(),
		]) {
			await expect(fetchCurrentAccount(fetchRef)).resolves.toEqual({ status: 'unavailable' });
		}
	});

	test('logs in with normalized email and the untouched password', async () => {
		const fetchRef = reply(200, { data: account });
		await expect(
			loginAccount({ email: ' alex@example.com ', password: ' correct horse ' }, fetchRef),
		).resolves.toEqual({ status: 'authenticated', account });
		const [path, request] = fetchRef.mock.calls[0];
		expect(path).toBe(LOGIN_PATH);
		expect(request).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(request.headers['X-Requested-With']).toBe('XMLHttpRequest');
		expect(JSON.parse(request.body)).toEqual({
			email: 'alex@example.com',
			password: ' correct horse ',
		});
	});

	test('only INVALID_CREDENTIALS counts as rejected credentials', async () => {
		const credentials = { email: 'alex@example.com', password: 'correct horse battery' };
		await expect(
			loginAccount(credentials, reply(401, { error: { code: 'INVALID_CREDENTIALS' } })),
		).resolves.toEqual({ status: 'invalid-credentials' });
		for (const fetchRef of [
			reply(401, null),
			reply(503, { error: { code: 'SERVICE_UNAVAILABLE' } }),
			reply(200),
			offline(),
		]) {
			await expect(loginAccount(credentials, fetchRef)).resolves.toEqual({ status: 'unavailable' });
		}
	});
});
