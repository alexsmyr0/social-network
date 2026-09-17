import { describe, expect, test, vi } from 'vitest';
import {
	createPost,
	createPostComment,
	getPostComments,
	loadEditablePost,
	updatePost,
} from '../../../../features/post/post.api.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
	return { ok, status, json: async () => body };
}

function makeImage(name = 'pic.png') {
	return new File(['bytes'], name, { type: 'image/png' });
}

describe('createPost', () => {
	test('sends a JSON request with normalized category ids when no image is attached', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: { id: 9 } }, { status: 201 }));

		const result = await createPost(fetchRef, {
			title: 'Hi',
			body: 'Body',
			categoryIds: ['3', 1, { id: 2 }],
		});

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ id: 9 });
		const [url, options] = fetchRef.mock.calls[0];
		expect(url).toBe('/api/v1/posts');
		expect(options.method).toBe('POST');
		expect(options.credentials).toBe('include');
		expect(options.headers['Content-Type']).toBe('application/json');
		expect(JSON.parse(options.body).category_ids).toEqual([1, 2, 3]);
	});

	test('sends a multipart request that carries the image and draft status', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: { id: 1 } }, { status: 201 }));
		const image = makeImage();

		await createPost(fetchRef, {
			title: 'Draft',
			body: 'Body',
			categoryIds: [5],
			imageFile: image,
			status: 'draft',
		});

		const [, options] = fetchRef.mock.calls[0];
		expect(options.body).toBeInstanceOf(FormData);
		expect(options.headers?.['Content-Type']).toBeUndefined();
		expect(options.body.get('image')).toBe(image);
		expect(options.body.get('status')).toBe('draft');
		expect(options.body.getAll('category_ids')).toEqual(['5']);
	});

	test('ignores an unsupported status value and lets the backend default apply', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: {} }, { status: 201 }));

		await createPost(fetchRef, { title: 't', body: 'b', status: 'archived' });

		const [, options] = fetchRef.mock.calls[0];
		expect(JSON.parse(options.body)).not.toHaveProperty('status');
	});

	test('reports a failed request without throwing when fetch rejects', async () => {
		const fetchRef = vi.fn(async () => {
			throw new TypeError('offline');
		});

		const result = await createPost(fetchRef, { title: 't', body: 'b' });

		expect(result).toEqual({ ok: false, status: 0, data: null, payload: null });
	});
});

describe('updatePost', () => {
	test('PATCHes the post and forwards the remove_image flag as JSON', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: { id: 4 } }));

		await updatePost(fetchRef, 4, { title: 'T', body: 'B', categoryIds: [2], removeImage: true });

		const [url, options] = fetchRef.mock.calls[0];
		expect(url).toBe('/api/v1/posts/4');
		expect(options.method).toBe('PATCH');
		expect(JSON.parse(options.body)).toMatchObject({ remove_image: true, category_ids: [2] });
	});

	test('PATCHes with a multipart body when a replacement image is attached', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: { id: 4 } }));
		const image = makeImage();

		await updatePost(fetchRef, 4, { title: 'T', body: 'B', imageFile: image });

		const [, options] = fetchRef.mock.calls[0];
		expect(options.body).toBeInstanceOf(FormData);
		expect(options.body.get('image')).toBe(image);
	});
});

describe('loadEditablePost', () => {
	test('normalizes category ids and trims the persisted image url', async () => {
		const fetchRef = vi.fn(async () =>
			jsonResponse({
				data: {
					id: 1,
					categories: [{ id: 3 }, { id: 1 }],
					image_url: '  /uploads/a.png  ',
				},
			}),
		);

		const result = await loadEditablePost(fetchRef, 1);

		expect(result.ok).toBe(true);
		expect(result.data.category_ids).toEqual([1, 3]);
		expect(result.data.image_url).toBe('/uploads/a.png');
	});

	test('coerces a blank image url to null', async () => {
		const fetchRef = vi.fn(async () =>
			jsonResponse({ data: { id: 1, categories: [], image_url: '   ' } }),
		);

		const result = await loadEditablePost(fetchRef, 1);
		expect(result.data.image_url).toBeNull();
	});
});

describe('createPostComment', () => {
	test('sends a JSON comment body when no image is attached', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: { id: 11 } }, { status: 201 }));

		const result = await createPostComment(fetchRef, 7, { body: 'nice' });

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ id: 11 });
		const [url, options] = fetchRef.mock.calls[0];
		expect(url).toBe('/api/v1/posts/7/comments');
		expect(JSON.parse(options.body)).toEqual({ body: 'nice' });
	});

	test('sends a multipart comment carrying body and image when an image is attached', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: { id: 12 } }, { status: 201 }));
		const image = makeImage();

		await createPostComment(fetchRef, 7, { body: 'see this', imageFile: image });

		const [, options] = fetchRef.mock.calls[0];
		expect(options.body).toBeInstanceOf(FormData);
		expect(options.body.get('body')).toBe('see this');
		expect(options.body.get('image')).toBe(image);
	});

	test('returns a non-ok result when the comment request rejects', async () => {
		const fetchRef = vi.fn(async () => {
			throw new Error('boom');
		});

		const result = await createPostComment(fetchRef, 7, { body: 'x' });
		expect(result).toEqual({ ok: false, status: 0, data: null });
	});
});

describe('getPostComments', () => {
	test('returns the normalized comment payload', async () => {
		const fetchRef = vi.fn(async () => jsonResponse({ data: [{ id: 1 }, { id: 2 }] }));

		const comments = await getPostComments(fetchRef, 3);
		expect(comments).toEqual([{ id: 1 }, { id: 2 }]);
	});

	test('returns null when the comments request fails', async () => {
		const fetchRef = vi.fn(async () => jsonResponse(null, { ok: false, status: 500 }));
		const comments = await getPostComments(fetchRef, 3);
		expect(comments).toBeNull();
	});
});
