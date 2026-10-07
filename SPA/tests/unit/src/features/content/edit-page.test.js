// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ContentBackend } from '../../../../fixtures/phase3/content-backend.js';
import {
	chooseFile,
	cleanupMounted,
	contentCalls,
	mountContentApp,
	pngFile,
	settle,
	textOf,
} from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const writes = (fetchRef) => contentCalls(fetchRef).filter((call) => call.method !== 'GET');
const button = (wrapper, label) =>
	wrapper.findAll('button').find((node) => node.text().trim() === label);
const audience = (wrapper, value) => wrapper.get(`[data-audience="${value}"] input`);
const recipient = (wrapper, id) =>
	wrapper.get(`input[name="selected_follower_ids"][value="${id}"]`);

async function edit(id, options = {}) {
	const backend = options.backend ?? new ContentBackend();
	const app = await mountContentApp(`/posts/${id}/edit`, { backend, ...options });
	return app;
}

describe('SN-A12 owner editor — direct entry', () => {
	test('missing, foreign and malformed links never show an editor', async () => {
		const missing = await edit(999);
		expect(missing.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(missing.wrapper.find('form.post-form').exists()).toBe(false);
		cleanupMounted();

		const backend = new ContentBackend();
		const foreign = await edit(101, { backend, viewerId: 7 });
		expect(foreign.wrapper.find('[data-state="foreign"]').exists()).toBe(true);
		expect(foreign.wrapper.find('form.post-form').exists()).toBe(false);
		cleanupMounted();

		// Another author's draft is indistinguishable from a missing post.
		backend.addPost({ id: 120, author_id: 7, status: 'draft' });
		const hidden = await edit(120, { backend });
		expect(hidden.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		cleanupMounted();

		const malformed = await mountContentApp('/posts/007/edit', { backend });
		expect(malformed.router.currentRoute.value.name).toBe('not-found');
	});

	test('an outage is unavailable, not missing, and recovers on retry', async () => {
		let down = true;
		const app = await edit(101, {
			before: async (entry) => {
				if (down && entry.url === '/api/v1/posts/101') throw new TypeError('offline');
			},
		});
		expect(textOf(app.wrapper)).toContain('We can’t load this post right now.');
		down = false;
		await app.wrapper.get('.social-state--error button').trigger('click');
		await settle();
		expect(app.wrapper.get('#edit-body').element.value).toBe('Hello');
	});
});

describe('SN-A12 owner editor — editing', () => {
	test('saves only changed fields with the expected version, then reports no-op saves', async () => {
		const backend = new ContentBackend();
		backend.posts.get(101).title = 'Old';
		const app = await edit(101, { backend });
		expect(app.wrapper.get('#edit-title').element.value).toBe('Old');
		await app.wrapper.get('#edit-title').setValue('');
		await app.wrapper.get('#edit-body').setValue('Updated');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0]).toMatchObject({
			method: 'PATCH',
			url: '/api/v1/posts/101',
			json: { expected_version: 1, title: null, body: 'Updated' },
		});
		expect(textOf(app.wrapper)).toContain('Changes saved.');
		expect(backend.posts.get(101)).toMatchObject({ title: null, body: 'Updated', version: 2 });
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)).toHaveLength(1);
		expect(textOf(app.wrapper)).toContain('There are no changes to save.');
	});

	test('audiences change in both directions and recipients are cleared when leaving Selected', async () => {
		const backend = new ContentBackend();
		const app = await edit(101, { backend });
		await audience(app.wrapper, 'selected').setValue(true);
		await settle();
		await recipient(app.wrapper, 7).setValue(true);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0].json).toEqual({
			expected_version: 1,
			audience: 'selected',
			selected_follower_ids: [7],
		});
		expect(backend.posts.get(101).selected_follow_ids).toEqual([71]);

		await audience(app.wrapper, 'followers').setValue(true);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[1].json).toEqual({ expected_version: 2, audience: 'followers' });
		expect(backend.posts.get(101)).toMatchObject({
			audience: 'followers',
			selected_follow_ids: [],
		});

		await audience(app.wrapper, 'public').setValue(true);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(backend.posts.get(101)).toMatchObject({ audience: 'public', version: 4 });
	});

	test('image replacement and removal keep the post’s text', async () => {
		const backend = new ContentBackend();
		const app = await edit(101, { backend });
		expect(app.wrapper.get('.composer__preview img').attributes('src')).toBe('/api/v1/media/401');
		await chooseFile(app.wrapper.get('#edit-image'), pngFile());
		expect(textOf(app.wrapper)).toContain('Replaces the current image when you save');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0].form.fields).toEqual({ expected_version: ['1'] });
		expect(backend.posts.get(101).image_url).toBe('/api/v1/media/403');
		expect(backend.media.has(401)).toBe(false);
		expect(app.wrapper.get('.composer__preview img').attributes('src')).toBe('/api/v1/media/403');

		await button(app.wrapper, 'Remove image').trigger('click');
		expect(textOf(app.wrapper)).toContain('The current image will be removed when you save.');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[1].json).toEqual({ expected_version: 2, remove_image: true });
		expect(backend.posts.get(101)).toMatchObject({ image_url: null, body: 'Hello' });
	});

	test('a failed image replacement keeps the stored image and the author’s edits', async () => {
		const backend = new ContentBackend();
		backend.faults.push({ method: 'PATCH', path: /^\/api\/v1\/posts\/101$/u, commit: false });
		const app = await edit(101, { backend });
		await app.wrapper.get('#edit-body').setValue('Edited text');
		await chooseFile(app.wrapper.get('#edit-image'), pngFile());
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(app.wrapper.get('[data-recovery-state="unknown"]').text()).toContain(
			'nothing was retried',
		);
		expect(app.wrapper.get('#edit-body').element.value).toBe('Edited text');
		expect(backend.posts.get(101)).toMatchObject({ image_url: '/api/v1/media/401', version: 1 });
		expect(writes(app.fetchRef)).toHaveLength(1);
	});
});

describe('SN-A12 owner editor — lifecycle', () => {
	test('a draft saves in place, reloads with its new version and then publishes', async () => {
		const backend = new ContentBackend();
		backend.posts.get(101).status = 'draft';
		const app = await edit(101, { backend });
		expect(textOf(app.wrapper)).toContain('Edit draft');
		await app.wrapper.get('#edit-title').setValue('Draft title');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0]).toMatchObject({
			method: 'PUT',
			url: '/api/v1/posts/draft/101',
			json: { expected_version: 1, title: 'Draft title' },
		});
		expect(textOf(app.wrapper)).toContain('Draft saved.');
		cleanupMounted();

		// A fresh visit (reload) shows what was stored and uses version 2.
		const reopened = await edit(101, { backend });
		expect(reopened.wrapper.get('#edit-title').element.value).toBe('Draft title');
		await reopened.wrapper.get('#edit-body').setValue('Ready now');
		await button(reopened.wrapper, 'Publish').trigger('click');
		await settle();
		expect(writes(reopened.fetchRef)[0]).toMatchObject({
			method: 'PATCH',
			json: { expected_version: 2, body: 'Ready now', status: 'published' },
		});
		expect(backend.posts.get(101).status).toBe('published');
		expect(textOf(reopened.wrapper)).toContain('Published.');
		expect(textOf(reopened.wrapper)).toContain('Edit post');
	});

	test('unpublish and republish keep the attachment, audience and recipients', async () => {
		const backend = new ContentBackend();
		Object.assign(backend.posts.get(101), { audience: 'selected', selected_follow_ids: [71] });
		const app = await edit(101, { backend });
		expect(recipient(app.wrapper, 7).element.checked).toBe(true);
		await button(app.wrapper, 'Move to drafts').trigger('click');
		await settle();
		expect(writes(app.fetchRef)[0].json).toEqual({ expected_version: 1, status: 'draft' });
		expect(backend.posts.get(101)).toMatchObject({
			status: 'draft',
			image_url: '/api/v1/media/401',
			audience: 'selected',
			selected_follow_ids: [71],
		});
		expect(textOf(app.wrapper)).toContain('Moved to drafts.');
		// Hidden from the recipient while unpublished.
		expect(backend.request(7, 'GET', '/api/v1/posts/101').status).toBe(404);

		await button(app.wrapper, 'Publish').trigger('click');
		await settle();
		expect(writes(app.fetchRef)[1].json).toEqual({ expected_version: 2, status: 'published' });
		expect(backend.posts.get(101)).toMatchObject({
			status: 'published',
			image_url: '/api/v1/media/401',
			selected_follow_ids: [71],
			created_at: '2026-10-06T12:00:00Z',
		});
		expect(backend.request(7, 'GET', '/api/v1/posts/101').status).toBe(200);
	});

	test('publishing an empty draft or a recipient-less Selected draft is refused locally', async () => {
		const backend = new ContentBackend();
		Object.assign(backend.posts.get(101), { status: 'draft', body: '', image_url: null });
		const app = await edit(101, { backend });
		await button(app.wrapper, 'Publish').trigger('click');
		await settle();
		expect(textOf(app.wrapper)).toContain('Write something or add an image before publishing.');
		await app.wrapper.get('#edit-body').setValue('Words');
		await audience(app.wrapper, 'selected').setValue(true);
		await button(app.wrapper, 'Publish').trigger('click');
		await settle();
		expect(textOf(app.wrapper)).toContain('Choose at least one follower');
		expect(writes(app.fetchRef)).toHaveLength(0);
		// Saving the unfinished draft is still allowed.
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0].json).toEqual({
			expected_version: 1,
			body: 'Words',
			audience: 'selected',
			selected_follower_ids: [],
		});
	});

	test('archived posts can be edited, published again or moved to drafts', async () => {
		const backend = new ContentBackend();
		backend.posts.get(101).status = 'archived';
		const app = await edit(101, { backend });
		expect(textOf(app.wrapper)).toContain('This post is archived.');
		await button(app.wrapper, 'Publish again').trigger('click');
		await settle();
		expect(writes(app.fetchRef)[0].json).toEqual({ expected_version: 1, status: 'published' });
		expect(backend.posts.get(101).status).toBe('published');
	});

	test('deletion needs confirmation, sends the version and leaves for your posts', async () => {
		const backend = new ContentBackend();
		const app = await edit(101, { backend });
		await button(app.wrapper, 'Delete post').trigger('click');
		expect(textOf(app.wrapper)).toContain('Delete this post?');
		await button(app.wrapper, 'Keep it').trigger('click');
		expect(textOf(app.wrapper)).not.toContain('Delete this post?');
		expect(writes(app.fetchRef)).toHaveLength(0);
		await button(app.wrapper, 'Delete post').trigger('click');
		await button(app.wrapper, 'Delete permanently').trigger('click');
		await settle();
		expect(writes(app.fetchRef)[0]).toMatchObject({
			method: 'DELETE',
			url: '/api/v1/posts/101?expected_version=1',
		});
		expect(backend.posts.has(101)).toBe(false);
		expect(backend.comments.has(201)).toBe(false);
		expect(app.router.currentRoute.value.name).toBe('my-posts');
		expect(textOf(app.wrapper)).toContain('Post deleted.');
	});

	test('drafts are deleted through the draft route', async () => {
		const backend = new ContentBackend();
		backend.posts.get(101).status = 'draft';
		const app = await edit(101, { backend });
		await button(app.wrapper, 'Delete draft').trigger('click');
		await button(app.wrapper, 'Delete permanently').trigger('click');
		await settle();
		expect(writes(app.fetchRef)[0].url).toBe('/api/v1/posts/draft/101?expected_version=1');
		expect(textOf(app.wrapper)).toContain('Draft deleted.');
	});
});

describe('SN-A12 owner editor — conflicts', () => {
	test('a refollowed recipient does not silently reappear after a stale save', async () => {
		const backend = new ContentBackend();
		Object.assign(backend.posts.get(101), { audience: 'selected', selected_follow_ids: [71, 72] });
		const app = await edit(101, { backend });
		expect(recipient(app.wrapper, 7).element.checked).toBe(true);
		// Ada unfollows (grant pruned, version 2) and follows again (new follow).
		backend.request(7, 'DELETE', '/api/v1/follows/71');
		backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
		await app.wrapper.get('#edit-body').setValue('Edited while away');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0].json).toEqual({
			expected_version: 1,
			body: 'Edited while away',
		});
		const alert = app.wrapper.get('[data-recovery-state="stale"]');
		expect(alert.text()).toContain('people removed from its recipients meanwhile stay removed');
		expect(app.wrapper.get('#edit-body').element.value).toBe('Edited while away');
		// Ada is a follower again, offered in the picker, but not re-selected.
		expect(recipient(app.wrapper, 7).element.checked).toBe(false);
		expect(recipient(app.wrapper, 8).element.checked).toBe(true);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[1].json).toEqual({
			expected_version: 2,
			body: 'Edited while away',
		});
		expect(backend.posts.get(101)).toMatchObject({ version: 3, selected_follow_ids: [72] });
		expect(backend.request(7, 'GET', '/api/v1/posts/101').status).toBe(404);
	});

	test('a change elsewhere is pointed out and the latest version can be loaded explicitly', async () => {
		const backend = new ContentBackend();
		const app = await edit(101, { backend });
		backend.request(42, 'PATCH', '/api/v1/posts/101', {
			json: { expected_version: 1, body: 'From another tab' },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.social.refresh();
		await settle();
		expect(app.wrapper.find('[data-changed-elsewhere]').exists()).toBe(true);
		await app.wrapper.get('[data-changed-elsewhere] button').trigger('click');
		await settle();
		expect(app.wrapper.get('#edit-body').element.value).toBe('From another tab');
		expect(app.wrapper.find('[data-changed-elsewhere]').exists()).toBe(false);
	});

	test('a lost edit response is not replayed; a retry after commit becomes a reviewed conflict', async () => {
		const backend = new ContentBackend();
		let lose = true;
		const app = await edit(101, {
			backend,
			after: async (entry) => {
				if (lose && entry.method === 'PATCH') {
					lose = false;
					throw new TypeError('lost');
				}
			},
		});
		await app.wrapper.get('#edit-body').setValue('Committed?');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(backend.posts.get(101).version).toBe(2);
		expect(writes(app.fetchRef)).toHaveLength(1);
		expect(app.wrapper.get('[data-recovery-state="unknown"]').text()).toContain('couldn’t confirm');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(app.wrapper.find('[data-recovery-state="stale"]').exists()).toBe(true);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).toContain('There are no changes to save.');
		expect(backend.posts.get(101).version).toBe(2);
	});

	test('deletion elsewhere disables saving but keeps the unsaved text visible', async () => {
		const backend = new ContentBackend();
		const app = await edit(101, { backend });
		await app.wrapper.get('#edit-body').setValue('Unsaved words');
		backend.posts.delete(101);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(app.wrapper.find('[data-state="gone"]').exists()).toBe(true);
		expect(app.wrapper.get('#edit-body').element.value).toBe('Unsaved words');
		expect(app.wrapper.find('.post-form__actions').exists()).toBe(false);
	});

	test('a validation error from the server keeps every input', async () => {
		const backend = new ContentBackend();
		backend.categories.set(2, { id: 2, name: 'Retired', created_at: '2026-10-06T12:00:00Z' });
		const app = await edit(101, { backend });
		await app.wrapper.get('#edit-body').setValue('Text stays');
		await app.wrapper.get('input[name="category_ids"][value="2"]').setValue(true);
		backend.categories.delete(2);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).toContain('One of those categories is no longer available.');
		expect(app.wrapper.get('#edit-body').element.value).toBe('Text stays');
		expect(backend.posts.get(101).version).toBe(1);
	});
});
