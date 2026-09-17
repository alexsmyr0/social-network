import { describe, expect, test, vi } from 'vitest';
import {
	fetchConversation,
	uploadDMImage,
} from '../../../../features/chat/chat.conversation.api.js';

describe('fetchConversation', () => {
	test('returns empty conversation when fetchRef is not a function', async () => {
		const result = await fetchConversation(null, 1);
		expect(result).toEqual({ ok: false, messages: [], hasMore: false });
	});

	test('returns empty conversation for an invalid user id', async () => {
		const fetchRef = vi.fn();
		expect(await fetchConversation(fetchRef, 0)).toEqual({
			ok: false,
			messages: [],
			hasMore: false,
		});
		expect(await fetchConversation(fetchRef, -3)).toEqual({
			ok: false,
			messages: [],
			hasMore: false,
		});
		expect(await fetchConversation(fetchRef, Number.NaN)).toEqual({
			ok: false,
			messages: [],
			hasMore: false,
		});
		expect(fetchRef).not.toHaveBeenCalled();
	});

	test('requests the C03 history endpoint and unwraps data', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					messages: [{ id: 1, sender_id: 9, body: 'hi', created_at: '2026-01-01T00:00:00Z' }],
					has_more: true,
				},
			}),
		}));

		const result = await fetchConversation(fetchRef, 42);

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/chats/42/messages',
			expect.objectContaining({ credentials: 'include' }),
		);
		expect(result.messages).toHaveLength(1);
		expect(result.hasMore).toBe(true);
	});

	test('appends before_id when paging older history', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { messages: [], has_more: false } }),
		}));

		await fetchConversation(fetchRef, 42, { beforeId: 91 });

		expect(fetchRef).toHaveBeenCalledWith(
			'/api/v1/chats/42/messages?before_id=91',
			expect.objectContaining({ credentials: 'include' }),
		);
	});

	test('omits before_id for non-positive or non-finite values', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { messages: [], has_more: false } }),
		}));

		await fetchConversation(fetchRef, 42, { beforeId: 0 });
		await fetchConversation(fetchRef, 42, { beforeId: -5 });
		await fetchConversation(fetchRef, 42, { beforeId: Number.NaN });

		for (const [url] of fetchRef.mock.calls) {
			expect(url).toBe('/api/v1/chats/42/messages');
		}
	});

	test('returns empty conversation on non-ok responses', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
		expect(await fetchConversation(fetchRef, 5)).toEqual({
			ok: false,
			messages: [],
			hasMore: false,
		});
	});

	test('returns empty conversation when fetch throws', async () => {
		const fetchRef = vi.fn(async () => {
			throw new Error('network');
		});
		expect(await fetchConversation(fetchRef, 5)).toEqual({
			ok: false,
			messages: [],
			hasMore: false,
		});
	});

	test('defaults messages to an array when payload is malformed', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { messages: 'nope' } }),
		}));
		const result = await fetchConversation(fetchRef, 5);
		expect(result.messages).toEqual([]);
		expect(result.hasMore).toBe(false);
	});
});

describe('uploadDMImage (D08)', () => {
	const file = new File(['bytes'], 'pic.png', { type: 'image/png' });

	test('returns an empty string for invalid arguments without calling fetch', async () => {
		const fetchRef = vi.fn();
		expect(await uploadDMImage(null, 5, file)).toBe('');
		expect(await uploadDMImage(fetchRef, 0, file)).toBe('');
		expect(await uploadDMImage(fetchRef, Number.NaN, file)).toBe('');
		expect(await uploadDMImage(fetchRef, 5, null)).toBe('');
		expect(fetchRef).not.toHaveBeenCalled();
	});

	test('posts a multipart image field and returns the saved url', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: { image_url: '/static/uploads/dm/pic.png' } }),
		}));

		const url = await uploadDMImage(fetchRef, 42, file);

		expect(url).toBe('/static/uploads/dm/pic.png');
		const [calledUrl, options] = fetchRef.mock.calls[0];
		expect(calledUrl).toBe('/api/v1/chats/42/images');
		expect(options.method).toBe('POST');
		expect(options.credentials).toBe('include');
		expect(options.body).toBeInstanceOf(FormData);
		expect(options.body.get('image')).toBe(file);
	});

	test('returns an empty string on a non-ok response', async () => {
		const fetchRef = vi.fn(async () => ({ ok: false, status: 413, json: async () => ({}) }));
		expect(await uploadDMImage(fetchRef, 42, file)).toBe('');
	});

	test('returns an empty string when the url is missing from the payload', async () => {
		const fetchRef = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: {} }),
		}));
		expect(await uploadDMImage(fetchRef, 42, file)).toBe('');
	});

	test('returns an empty string when fetch throws', async () => {
		const fetchRef = vi.fn(async () => {
			throw new Error('network');
		});
		expect(await uploadDMImage(fetchRef, 42, file)).toBe('');
	});
});
