// @vitest-environment jsdom

import { beforeAll, describe, expect, test, vi } from 'vitest';

import {
	feedQuery,
	normalizeTitle,
	readFeedQuery,
	textProblem,
} from '../../../../../src/features/content/content-utils.js';
import {
	applyFailure,
	changeFields,
	chooseImage,
	createFields,
	createPostForm,
	lostRecipients,
	rebaseForm,
	seedForm,
	validateForm,
} from '../../../../../src/features/content/post-form.js';
import { pngBytes } from '../../../../fixtures/phase3/content-backend.js';

beforeAll(() => {
	URL.createObjectURL = vi.fn(() => 'blob:preview');
	URL.revokeObjectURL = vi.fn();
});

function post(overrides = {}) {
	return {
		id: 101,
		author_id: 42,
		author: 'Alex Example',
		title: null,
		body: 'Hello',
		image_url: '/api/v1/media/401',
		status: 'published',
		audience: 'public',
		version: 1,
		categories: [],
		created_at: '2026-10-06T12:00:00Z',
		updated_at: '2026-10-06T12:00:00Z',
		likes: 0,
		dislikes: 0,
		my_reaction: 0,
		selected_follower_ids: [],
		...overrides,
	};
}

const png = () => new File([pngBytes()], 'a.png', { type: 'image/png' });

describe('text rules mirror the contract', () => {
	test('normalizes CRLF and surrounding whitespace before counting code points', () => {
		expect(textProblem('body', `  ${'😀'.repeat(10000)}\r\n `)).toBeNull();
		expect(textProblem('body', '😀'.repeat(10001))).toBe('TOO_LONG');
		expect(textProblem('title', 'x'.repeat(200))).toBeNull();
		expect(textProblem('title', 'x'.repeat(201))).toBe('TOO_LONG');
		expect(textProblem('body', 'line\none\tTab\r\n')).toBeNull();
		expect(textProblem('body', 'lone\rreturn')).toBe('INVALID_TEXT');
		expect(textProblem('body', 'bell\u0007')).toBe('INVALID_TEXT');
		expect(textProblem('title', 'two\nlines')).toBe('INVALID_TEXT');
		expect(normalizeTitle('   ')).toBeNull();
		expect(normalizeTitle(' Title ')).toBe('Title');
	});

	test('feed route state recovers malformed values to the canonical query', () => {
		expect(readFeedQuery({ feed: 'private', category: '007', page: '0' })).toEqual({
			feed: 'all',
			categoryId: null,
			page: 1,
		});
		expect(readFeedQuery({ feed: ['following', 'all'], category: '3', page: '2' })).toEqual({
			feed: 'following',
			categoryId: 3,
			page: 2,
		});
		expect(feedQuery({ feed: 'all', categoryId: null, page: 1 })).toEqual({});
		expect(feedQuery({ feed: 'following', categoryId: 3, page: 2 })).toEqual({
			feed: 'following',
			category: '3',
			page: '2',
		});
	});
});

describe('creating posts', () => {
	test('sends only supplied values and lets the server apply defaults', () => {
		const form = createPostForm();
		form.body = '  Hello\r\nthere  ';
		expect(createFields(form)).toEqual({ body: 'Hello\nthere' });
		form.title = ' Title ';
		form.categoryIds = [3, 1];
		form.audience = 'selected';
		form.selectedIds = [8, 7];
		const image = png();
		chooseImage(form, image);
		expect(createFields(form)).toEqual({
			body: 'Hello\nthere',
			title: 'Title',
			categoryIds: [1, 3],
			audience: 'selected',
			selectedFollowerIds: [7, 8],
			image,
		});
		form.audience = 'followers';
		expect(createFields(form)).not.toHaveProperty('selectedFollowerIds');
	});

	test('publishing needs text or an image; drafts may be empty', () => {
		const form = createPostForm();
		form.body = '   ';
		expect(validateForm(form, { publishing: false, eligibleIds: [] })).toBe(true);
		expect(validateForm(form, { publishing: true, eligibleIds: [] })).toBe(false);
		expect(form.errors.body).toMatch(/Write something or add an image/u);
		chooseImage(form, png());
		expect(validateForm(form, { publishing: true, eligibleIds: [] })).toBe(true);
	});

	test('rejects unsupported image choices without blocking the rest of the post', () => {
		const form = createPostForm();
		form.body = 'Text';
		expect(chooseImage(form, new File(['x'], 'a.webp', { type: 'image/webp' }))).toBe(false);
		expect(form.errors.image).toMatch(/JPEG, PNG or GIF/u);
		const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
		expect(chooseImage(form, big)).toBe(false);
		expect(form.errors.image).toMatch(/5 MiB/u);
		expect(form.image).toBeNull();
		expect(validateForm(form, { publishing: true, eligibleIds: [] })).toBe(true);
		expect(form.errors.image).toMatch(/5 MiB/u);
	});

	test('selected audiences need current followers and at least one recipient to publish', () => {
		const form = createPostForm();
		form.body = 'Hi';
		form.audience = 'selected';
		expect(validateForm(form, { publishing: false, eligibleIds: [7, 8] })).toBe(true);
		expect(validateForm(form, { publishing: true, eligibleIds: [7, 8] })).toBe(false);
		expect(form.errors.selected_follower_ids).toMatch(/at least one follower/u);
		form.selectedIds = [7, 99];
		expect(lostRecipients(form, [7, 8])).toEqual([99]);
		expect(validateForm(form, { publishing: false, eligibleIds: [7, 8] })).toBe(false);
		expect(form.errors.selected_follower_ids).toMatch(/no longer follow you/u);
		form.audience = 'public';
		expect(lostRecipients(form, [7, 8])).toEqual([]);
	});

	test('maps server field errors and discards only a rejected fresh image', () => {
		const form = createPostForm();
		form.body = 'Keep me';
		chooseImage(form, png());
		applyFailure(form, { status: 'invalid-image', fields: { image: 'INVALID_IMAGE' } });
		expect(form.image).toBeNull();
		expect(form.body).toBe('Keep me');
		expect(form.errors.image).toMatch(/couldn’t be used/u);
		applyFailure(form, {
			status: 'rejected',
			code: 'VALIDATION_ERROR',
			fields: { selected_follower_ids: 'INVALID_SELECTION', category_ids: 'INVALID_CATEGORY' },
		});
		expect(form.errors.selected_follower_ids).toMatch(/no longer follow you/u);
		expect(form.errors.category_ids).toMatch(/no longer available/u);
		expect(form.body).toBe('Keep me');
	});
});

describe('editing posts', () => {
	test('a partial edit sends only fields that differ from the snapshot', () => {
		const base = post({ title: 'Old', categories: [{ id: 1, name: 'General' }] });
		const form = createPostForm();
		seedForm(form, base);
		expect(changeFields(form, base)).toEqual({});
		form.body = ' Hello ';
		expect(changeFields(form, base)).toEqual({});
		form.title = '';
		form.categoryIds = [];
		expect(changeFields(form, base)).toEqual({ title: null, categoryIds: [] });
	});

	test('audience edits in both directions carry or clear recipients', () => {
		const base = post();
		const form = createPostForm();
		seedForm(form, base);
		form.audience = 'selected';
		form.selectedIds = [7];
		expect(changeFields(form, base)).toEqual({ audience: 'selected', selectedFollowerIds: [7] });

		const selected = post({ audience: 'selected', selected_follower_ids: [7] });
		seedForm(form, selected);
		expect(changeFields(form, selected)).toEqual({});
		form.selectedIds = [7, 8];
		expect(changeFields(form, selected)).toEqual({ selectedFollowerIds: [7, 8] });
		form.audience = 'followers';
		expect(changeFields(form, selected)).toEqual({ audience: 'followers' });
	});

	test('image removal and replacement are explicit', () => {
		const base = post();
		const form = createPostForm();
		seedForm(form, base);
		form.removeImage = true;
		expect(changeFields(form, base)).toEqual({ removeImage: true });
		const image = png();
		chooseImage(form, image);
		expect(form.removeImage).toBe(false);
		expect(changeFields(form, base)).toEqual({ image });
		const bare = post({ image_url: null });
		seedForm(form, bare);
		form.removeImage = true;
		expect(changeFields(form, bare)).toEqual({});
	});

	test('a conflict rebase keeps edits but never restores a revoked recipient', () => {
		// Opened while 7 was selected; 7 unfollowed (grant pruned, version 2)
		// and refollowed. The stale form must not silently re-add 7.
		const base = post({ audience: 'selected', selected_follower_ids: [7], version: 1 });
		const latest = post({ audience: 'selected', selected_follower_ids: [], version: 2 });
		const untouched = createPostForm();
		seedForm(untouched, base);
		rebaseForm(untouched, base, latest);
		expect(untouched.selectedIds).toEqual([]);

		const edited = createPostForm();
		seedForm(edited, base);
		edited.body = 'Edited';
		edited.selectedIds = [7, 8];
		rebaseForm(edited, base, latest);
		expect(edited.body).toBe('Edited');
		expect(edited.selectedIds).toEqual([8]);
		expect(changeFields(edited, latest)).toEqual({ body: 'Edited', selectedFollowerIds: [8] });
	});

	test('untouched fields follow the newer server copy after a conflict', () => {
		const base = post({ title: 'One' });
		const latest = post({ title: 'Two', body: 'Server', image_url: null, version: 2 });
		const form = createPostForm();
		seedForm(form, base);
		form.title = 'Mine';
		form.removeImage = true;
		rebaseForm(form, base, latest);
		expect(form.title).toBe('Mine');
		expect(form.body).toBe('Server');
		expect(form.existingImageUrl).toBeNull();
		expect(form.removeImage).toBe(false);
		expect(changeFields(form, latest)).toEqual({ title: 'Mine' });
	});
});
