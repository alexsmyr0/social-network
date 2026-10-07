import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Same API journey runs against native binaries and the isolated two-image stack.
// No UI fixtures or mocked responses; retained content rendering belongs to A.
test('private attachments lose outsider access through the frontend proxy', async ({
	playwright,
	baseURL,
}) => {
	const options = {
		baseURL,
		extraHTTPHeaders: { Origin: baseURL, 'X-Requested-With': 'XMLHttpRequest' },
	};
	const owner = await playwright.request.newContext(options);
	const viewer = await playwright.request.newContext(options);
	const anonymous = await playwright.request.newContext({ baseURL });
	try {
		for (const [client, firstName] of [
			[owner, 'Owner'],
			[viewer, 'Viewer'],
		]) {
			const response = await client.post('/api/v1/users/register', {
				data: {
					email: `b13-${randomUUID()}@example.com`,
					password: 'correct horse battery',
					first_name: firstName,
					last_name: 'Media',
					date_of_birth: '2000-01-01',
				},
			});
			expect(response.status()).toBe(201);
		}
		const png = readFileSync('SPA/tests/fixtures/a07/avatar.png');
		const created = await owner.post('/api/v1/posts', {
			multipart: {
				title: 'B13 attachment',
				body: 'retained content',
				category_ids: '1',
				image: { name: 'image.png', mimeType: 'image/png', buffer: png },
			},
		});
		expect(created.status()).toBe(201);
		const post = (await created.json()).data;
		expect(post.image_url).toMatch(/^\/api\/v1\/media\/[1-9]\d*$/);
		const read = await viewer.get(post.image_url);
		expect(read.status()).toBe(200);
		expect(await read.body()).toEqual(png);
		expect(read.headers()['cache-control']).toBe('no-store');
		expect((await anonymous.get(post.image_url)).status()).toBe(401);
		const privacy = await owner.patch('/api/v1/users/me/privacy', {
			data: { visibility: 'private', expected_version: 1 },
		});
		expect(privacy.status()).toBe(200);
		expect((await viewer.get(post.image_url)).status()).toBe(404);
		expect((await viewer.get(`/api/v1/posts/${post.id}`)).status()).toBe(404);
		expect((await owner.get(post.image_url)).status()).toBe(200);
		for (const path of ['/static/uploads/guess.png', '/static/uploads/dm/guess.png']) {
			expect((await anonymous.get(path)).status()).toBe(401);
			expect((await viewer.get(path)).status()).toBe(404);
		}
		const follow = await viewer.post('/api/v1/follows', {
			data: { user_id: post.author_id },
		});
		expect(follow.status()).toBe(201);
		const request = (await follow.json()).data;
		expect((await viewer.get(post.image_url)).status()).toBe(404);
		expect(
			(
				await owner.patch(`/api/v1/follow-requests/${request.id}`, {
					data: { decision: 'accept' },
				})
			).status(),
		).toBe(200);
		expect((await viewer.get(post.image_url)).status()).toBe(200);
		expect((await viewer.delete(`/api/v1/follows/${request.id}`)).status()).toBe(204);
		expect((await viewer.get(post.image_url)).status()).toBe(404);
		expect(
			(await owner.delete(`/api/v1/posts/${post.id}?expected_version=${post.version}`)).status(),
		).toBe(204);
		expect((await owner.get(post.image_url)).status()).toBe(404);
	} finally {
		await owner.dispose();
		await viewer.dispose();
		await anonymous.dispose();
	}
});
