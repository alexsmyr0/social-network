import { describe, expect, test, vi } from 'vitest';
import { fetchRoster } from '../../../../features/chat/chat.roster.api.js';

describe('fetchRoster', () => {
	test('calls GET /api/v1/chats with credentials and JSON Accept header', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [] }),
		}));

		await fetchRoster(fetchRef);

		expect(fetchRef).toHaveBeenCalledTimes(1);
		expect(fetchRef).toHaveBeenCalledWith('/api/v1/chats', {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
	});

	test('returns the data array on a successful response', async () => {
		const entries = [
			{
				user_id: 12,
				username: 'maria',
				is_online: true,
				last_message_at: '2026-04-09T14:20:00Z',
				last_message_preview: 'see you soon',
				last_sender_id: 7,
			},
			{
				user_id: 21,
				username: 'alex',
				is_online: false,
				last_message_at: null,
				last_message_preview: null,
				last_sender_id: null,
			},
		];

		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: entries }),
		}));

		const result = await fetchRoster(fetchRef);
		expect(result).toEqual(entries);
	});

	test('returns an empty array when the response is not ok', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
		}));

		const result = await fetchRoster(fetchRef);
		expect(result).toEqual([]);
	});

	test('returns an empty array when fetch rejects', async () => {
		const fetchRef = vi.fn(async () => {
			throw new TypeError('network down');
		});

		const result = await fetchRoster(fetchRef);
		expect(result).toEqual([]);
	});

	test('returns an empty array when payload has no data field', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({}),
		}));

		const result = await fetchRoster(fetchRef);
		expect(result).toEqual([]);
	});

	test('returns an empty array when fetchRef is missing', async () => {
		const result = await fetchRoster(undefined);
		expect(result).toEqual([]);
	});
});
