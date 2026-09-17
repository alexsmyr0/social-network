import { describe, expect, test, vi } from 'vitest';
import { fetchCurrentUserId } from '../../../../core/api/session.api.js';

describe('fetchCurrentUserId', () => {
	test('returns null when fetchRef is not a function', async () => {
		expect(await fetchCurrentUserId(undefined)).toBeNull();
	});

	test('returns the id from the data wrapper', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { id: 17, username: 'alice' } }),
		}));
		expect(await fetchCurrentUserId(fetchRef)).toBe(17);
		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/users/me',
			expect.objectContaining({ credentials: 'include' }),
		);
	});

	test('returns null on non-ok response', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
		expect(await fetchCurrentUserId(fetchRef)).toBeNull();
	});

	test('returns null when id is missing', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: {} }),
		}));
		expect(await fetchCurrentUserId(fetchRef)).toBeNull();
	});

	test('returns null when fetch throws', async () => {
		const fetchRef = vi.fn(async () => {
			throw new Error('network');
		});
		expect(await fetchCurrentUserId(fetchRef)).toBeNull();
	});
});
