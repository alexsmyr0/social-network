import { describe, expect, test } from 'vitest';
import {
	buildImageRequestOptions,
	buildPostMultipartFormData,
	IMAGE_ACCEPT_ATTR,
	IMAGE_ACCEPT_MIME_TYPES,
	MAX_IMAGE_BYTES,
} from '../../../../core/shared/utils.js';

function makeFile(name = 'pic.png', type = 'image/png') {
	return new File(['binary'], name, { type });
}

describe('image upload constants', () => {
	test('caps uploads at 20MB and accepts the supported image MIME types', () => {
		expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
		expect(IMAGE_ACCEPT_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif']);
		expect(IMAGE_ACCEPT_ATTR).toBe('image/jpeg,image/png,image/gif');
	});
});

describe('buildImageRequestOptions', () => {
	test('serializes a JSON request when no image is attached', () => {
		const options = buildImageRequestOptions({
			method: 'POST',
			jsonBody: { title: 'hi' },
			jsonHeaders: { Accept: 'application/json' },
		});

		expect(options.method).toBe('POST');
		expect(options.credentials).toBe('include');
		expect(options.headers['Content-Type']).toBe('application/json');
		expect(options.headers.Accept).toBe('application/json');
		expect(JSON.parse(options.body)).toEqual({ title: 'hi' });
	});

	test('switches to a multipart body and drops the JSON content-type when an image is attached', () => {
		const file = makeFile();
		const builder = (passedFile) => {
			const fd = new FormData();
			fd.append('image', passedFile);
			return fd;
		};

		const options = buildImageRequestOptions({
			method: 'POST',
			imageFile: file,
			buildMultipartBody: builder,
			multipartHeaders: { Accept: 'application/json' },
			jsonBody: { title: 'ignored' },
		});

		expect(options.body).toBeInstanceOf(FormData);
		// The browser must set the multipart boundary itself — never a manual content-type.
		expect(options.headers?.['Content-Type']).toBeUndefined();
		expect(options.headers.Accept).toBe('application/json');
		expect(options.body.get('image')).toBe(file);
	});
});

describe('buildPostMultipartFormData', () => {
	test('appends title, body, repeated category ids, and the image file', () => {
		const file = makeFile();
		const fd = buildPostMultipartFormData({
			title: 'Title',
			body: 'Body',
			categoryIds: [3, 1],
			imageFile: file,
		});

		expect(fd.get('title')).toBe('Title');
		expect(fd.get('body')).toBe('Body');
		expect(fd.getAll('category_ids')).toEqual(['3', '1']);
		expect(fd.get('image')).toBe(file);
	});

	test('appends a draft status only when a non-empty status is provided', () => {
		const draft = buildPostMultipartFormData({ title: 't', body: 'b', status: 'draft' });
		expect(draft.get('status')).toBe('draft');

		const published = buildPostMultipartFormData({ title: 't', body: 'b', status: null });
		expect(published.has('status')).toBe(false);
	});

	test('appends a trimmed image_url and the remove_image flag when requested', () => {
		const withUrl = buildPostMultipartFormData({ imageURL: '  https://x/y.png  ' });
		expect(withUrl.get('image_url')).toBe('https://x/y.png');

		const removing = buildPostMultipartFormData({ removeImage: true });
		expect(removing.get('remove_image')).toBe('true');

		const keeping = buildPostMultipartFormData({ removeImage: false });
		expect(keeping.has('remove_image')).toBe(false);
	});
});
