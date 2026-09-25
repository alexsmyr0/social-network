import { describe, expect, test, vi } from 'vitest';

import { checkBackendHealth, HEALTH_PATH } from '../../../../src/api/health.js';

describe('checkBackendHealth', () => {
	test('uses the same-origin health endpoint and accepts the backend envelope', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { status: 'ok' } }),
		}));

		await expect(checkBackendHealth(fetchRef)).resolves.toEqual({
			ok: true,
			status: 200,
			message: 'Backend connected',
		});
		expect(fetchRef).toHaveBeenCalledWith(HEALTH_PATH, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			credentials: 'include',
		});
	});

	test('reports a non-success response without throwing', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: false,
			status: 503,
			json: async () => ({ error: { code: 'SERVICE_UNAVAILABLE' } }),
		}));

		await expect(checkBackendHealth(fetchRef)).resolves.toEqual({
			ok: false,
			status: 503,
			message: 'The service is not responding normally.',
		});
	});

	test('turns a transport failure into an actionable connection state', async () => {
		const fetchRef = vi.fn(async () => {
			throw new TypeError('network unavailable');
		});

		await expect(checkBackendHealth(fetchRef)).resolves.toEqual({
			ok: false,
			status: 0,
			message: 'Connection interrupted. Check the backend and try again.',
		});
	});
});
