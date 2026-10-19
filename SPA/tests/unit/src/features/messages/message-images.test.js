import { describe, expect, test, vi } from 'vitest';

import { createImageCache } from '../../../../../src/features/messages/message-images.js';

function setup({ limit = 60, results = {} } = {}) {
	const revoked = [];
	let counter = 0;
	const fetchImage = vi.fn(
		async (url) => results[url] ?? { status: 'ok', blob: { size: url.length } },
	);
	const cache = createImageCache({
		fetchImage,
		createUrl: () => {
			counter += 1;
			return `blob:${counter}`;
		},
		revokeUrl: (url) => revoked.push(url),
		limit,
	});
	return { cache, fetchImage, revoked };
}

describe('private image cache', () => {
	test('reads an image once and shares it between views', async () => {
		const { cache, fetchImage } = setup();
		const [first, second] = await Promise.all([cache.acquire('/a'), cache.acquire('/a')]);
		expect(first).toEqual({ status: 'ok', src: 'blob:1' });
		expect(second.src).toBe('blob:1');
		expect(fetchImage).toHaveBeenCalledTimes(1);
	});

	test('failures are never cached, so a later view tries again', async () => {
		const results = { '/a': { status: 'not-found' } };
		const { cache, fetchImage } = setup({ results });
		expect((await cache.acquire('/a')).status).toBe('not-found');
		expect(cache.size()).toBe(0);
		delete results['/a'];
		expect((await cache.acquire('/a')).status).toBe('ok');
		expect(fetchImage).toHaveBeenCalledTimes(2);
	});

	test('clearing revokes every URL and a response that lands afterwards is revoked on arrival', async () => {
		const { cache, revoked } = setup();
		await cache.acquire('/a');
		await cache.acquire('/b');
		cache.clear();
		expect(revoked).toEqual(['blob:1', 'blob:2']);
		expect(cache.size()).toBe(0);

		let release;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const late = createImageCache({
			fetchImage: async () => {
				await gate;
				return { status: 'ok', blob: {} };
			},
			createUrl: () => 'blob:late',
			revokeUrl: (url) => revoked.push(url),
		});
		const pending = late.acquire('/c');
		late.clear();
		release();
		expect((await pending).status).toBe('unavailable');
		expect(revoked).toContain('blob:late');
	});

	test('evicts only images nothing is showing', async () => {
		const { cache, revoked } = setup({ limit: 2 });
		await cache.acquire('/a');
		await cache.acquire('/b');
		cache.release('/a');
		await cache.acquire('/c');
		expect(revoked).toEqual(['blob:1']);
		expect(cache.size()).toBe(2);
		// A and C are gone/held; B is still on screen and never evicted.
		cache.release('/c');
		await cache.acquire('/d');
		expect(revoked).toEqual(['blob:1', 'blob:3']);
	});
});
