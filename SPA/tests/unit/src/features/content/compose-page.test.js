// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ContentBackend } from '../../../../fixtures/phase3/content-backend.js';
import {
	chooseFile,
	cleanupMounted,
	contentCalls,
	deferred,
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
const audience = (wrapper, value) => wrapper.get(`[data-audience="${value}"] input`);

async function compose(options = {}) {
	const backend = options.backend ?? new ContentBackend();
	const app = await mountContentApp('/posts/new', { backend, ...options });
	return { ...app, form: app.wrapper.get('form.post-form') };
}

describe('SN-A12 composer', () => {
	test('Public is the visible default and a text-only post publishes with omitted optionals', async () => {
		const app = await compose();
		expect(audience(app.wrapper, 'public').element.checked).toBe(true);
		expect(textOf(app.wrapper)).toContain('Default.');
		await app.wrapper.get('#compose-body').setValue('  Hello circle\r\n');
		await app.form.trigger('submit');
		await settle();
		const [call] = writes(app.fetchRef);
		expect(call.url).toBe('/api/v1/posts');
		expect(call.json).toEqual({ body: 'Hello circle' });
		expect(app.backend.posts.get(102)).toMatchObject({
			body: 'Hello circle',
			audience: 'public',
			title: null,
		});
		expect(app.router.currentRoute.value.name).toBe('feed');
		expect(textOf(app.wrapper)).toContain('Your post is published.');
		expect(app.wrapper.find('[data-post-id="102"]').exists()).toBe(true);
	});

	test('an image-only post with a title and category uploads as multipart', async () => {
		const app = await compose();
		await app.wrapper.get('#compose-title').setValue('Sunset');
		await app.wrapper.get('input[name="category_ids"]').setValue(true);
		await chooseFile(app.wrapper.get('#compose-image'), pngFile());
		expect(app.wrapper.get('.composer__preview img').attributes('src')).toMatch(/^blob:preview/u);
		await app.form.trigger('submit');
		await settle();
		const [call] = writes(app.fetchRef);
		expect(call.json).toBeUndefined();
		expect(call.form.fields).toEqual({ body: [''], title: ['Sunset'], category_ids: ['1'] });
		expect(call.form.image.type).toBe('image/png');
		expect(app.backend.posts.get(102)).toMatchObject({
			title: 'Sunset',
			body: '',
			image_url: '/api/v1/media/403',
			categories: [{ id: 1, name: 'General' }],
		});
	});

	test('Followers and Selected followers publish with the chosen current followers only', async () => {
		const followers = await compose();
		await audience(followers.wrapper, 'followers').setValue(true);
		await followers.wrapper.get('#compose-body').setValue('For followers');
		await followers.form.trigger('submit');
		await settle();
		expect(writes(followers.fetchRef)[0].json).toEqual({
			body: 'For followers',
			audience: 'followers',
		});
		cleanupMounted();

		const selected = await compose();
		await audience(selected.wrapper, 'selected').setValue(true);
		await settle();
		const names = selected.wrapper.findAll('.recipient__name').map((node) => node.text());
		// Pat's request is still pending and Robin doesn't follow: not offered.
		expect(names).toEqual(['Ada Lovelace', 'Sam Example']);
		await selected.wrapper.get('#compose-body').setValue('Just Sam');
		await selected.wrapper.get('input[name="selected_follower_ids"][value="8"]').setValue(true);
		expect(textOf(selected.wrapper)).toContain('1 follower selected');
		await selected.form.trigger('submit');
		await settle();
		expect(writes(selected.fetchRef)[0].json).toEqual({
			body: 'Just Sam',
			audience: 'selected',
			selected_follower_ids: [8],
		});
		expect(selected.backend.posts.get(102).selected_follow_ids).toEqual([72]);
	});

	test('client checks block empty posts, empty selections and over-long text without a request', async () => {
		const app = await compose();
		await app.form.trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).toContain('Write something or add an image before publishing.');
		expect(document.activeElement).toBe(app.wrapper.get('.form-alert').element);
		await app.wrapper.get('#compose-body').setValue('Hi');
		await audience(app.wrapper, 'selected').setValue(true);
		await app.form.trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).toContain('Choose at least one follower');
		await audience(app.wrapper, 'public').setValue(true);
		await app.wrapper.get('#compose-title').setValue('x'.repeat(201));
		await app.form.trigger('submit');
		await settle();
		expect(app.wrapper.get('#compose-title').attributes('aria-invalid')).toBe('true');
		expect(writes(app.fetchRef)).toHaveLength(0);
	});

	test('a follower lost while composing is flagged and must be removed before saving', async () => {
		const app = await compose();
		await audience(app.wrapper, 'selected').setValue(true);
		await app.wrapper.get('#compose-body').setValue('Hi Ada');
		await app.wrapper.get('input[name="selected_follower_ids"][value="7"]').setValue(true);
		// Ada unfollows; the server rejects the stale selection.
		app.backend.request(7, 'DELETE', '/api/v1/follows/71');
		await app.form.trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[0].json.selected_follower_ids).toEqual([7]);
		expect(textOf(app.wrapper)).toContain('Some selected people can’t receive this post.');
		// The refreshed follower list marks Ada as lost instead of dropping her.
		expect(app.wrapper.find('[data-lost-recipients]').text()).toContain('#7');
		await app.form.trigger('submit');
		await settle();
		expect(writes(app.fetchRef)).toHaveLength(1);
		expect(textOf(app.wrapper)).toContain('Remove the people who no longer follow you');
		await app.wrapper.get('[data-lost-recipients] button').trigger('click');
		await app.wrapper.get('input[name="selected_follower_ids"][value="8"]').setValue(true);
		await app.form.trigger('submit');
		await settle();
		expect(writes(app.fetchRef)[1].json.selected_follower_ids).toEqual([8]);
		expect(app.router.currentRoute.value.name).toBe('feed');
	});

	test('an invalid upload keeps the text and choices, drops only the image', async () => {
		const app = await compose();
		await app.wrapper.get('#compose-body').setValue('Keep this text');
		await audience(app.wrapper, 'followers').setValue(true);
		await chooseFile(
			app.wrapper.get('#compose-image'),
			new File(['not an image'], 'bad.png', { type: 'image/png' }),
		);
		await app.form.trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).toContain('That image couldn’t be used.');
		expect(app.wrapper.get('#compose-body').element.value).toBe('Keep this text');
		expect(audience(app.wrapper, 'followers').element.checked).toBe(true);
		expect(app.wrapper.find('.composer__preview').exists()).toBe(false);
		expect(app.backend.posts.size).toBe(1);
		await app.form.trigger('submit');
		await settle();
		expect(writes(app.fetchRef).at(-1).json).toEqual({
			body: 'Keep this text',
			audience: 'followers',
		});
	});

	test('an oversize choice is refused before upload; an oversize upload reply is explained', async () => {
		const app = await compose();
		const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
		await chooseFile(app.wrapper.get('#compose-image'), big);
		expect(textOf(app.wrapper)).toContain('Images can be up to 5 MiB.');
		expect(app.wrapper.find('.composer__preview').exists()).toBe(false);
		cleanupMounted();

		const backend = new ContentBackend();
		backend.faults.push({ method: 'POST', path: /^\/api\/v1\/posts$/u, commit: false });
		const outage = await compose({ backend });
		await outage.wrapper.get('#compose-body').setValue('Hello');
		await outage.form.trigger('submit');
		await settle();
		expect(outage.wrapper.get('[data-recovery-state="unknown"]').text()).toContain(
			'nothing was retried',
		);
		expect(outage.wrapper.get('#compose-body').element.value).toBe('Hello');
		expect(outage.router.currentRoute.value.name).toBe('compose');
	});

	test('a lost create response is not replayed and does not claim success', async () => {
		const backend = new ContentBackend();
		const app = await compose({
			backend,
			after: async (entry) => {
				if (entry.method === 'POST' && entry.url === '/api/v1/posts') throw new TypeError('lost');
			},
		});
		await app.wrapper.get('#compose-body').setValue('Maybe saved');
		await app.form.trigger('submit');
		await settle();
		expect(backend.posts.get(102).body).toBe('Maybe saved');
		expect(writes(app.fetchRef)).toHaveLength(1);
		expect(textOf(app.wrapper)).not.toContain('published');
		expect(app.wrapper.get('[data-recovery-state="unknown"] a').attributes('href')).toBe(
			'/posts/mine',
		);
	});

	test('double activation sends exactly one create', async () => {
		const gate = deferred();
		const app = await compose({
			before: async (entry) => {
				if (entry.method === 'POST') await gate.promise;
			},
		});
		await app.wrapper.get('#compose-body').setValue('Once');
		await app.form.trigger('submit');
		await app.form.trigger('submit');
		await app.wrapper.findAll('.post-form__actions button')[1].trigger('click');
		expect(app.wrapper.get('button[type="submit"]').attributes('aria-disabled')).toBe('true');
		gate.release();
		await settle();
		expect(writes(app.fetchRef)).toHaveLength(1);
		expect(app.backend.posts.size).toBe(2);
	});

	test('a private profile explains that Public still means followers only', async () => {
		const backend = new ContentBackend();
		backend.users.get(42).visibility = 'private';
		const app = await compose({ backend });
		expect(app.wrapper.get('[data-privacy-note]').text()).toContain(
			'visible only to your accepted followers',
		);
		await audience(app.wrapper, 'followers').setValue(true);
		expect(app.wrapper.find('[data-privacy-note]').exists()).toBe(false);
	});

	test('saving a draft always creates a new one and opens it in the editor', async () => {
		const backend = new ContentBackend();
		backend.addPost({
			id: 150,
			status: 'draft',
			title: 'Older draft',
			updated_at: '2026-10-06T11:00:00Z',
		});
		const app = await compose({ backend });
		expect(app.wrapper.get('[data-latest-draft]').text()).toContain('“Older draft”');
		await audience(app.wrapper, 'selected').setValue(true);
		await app.wrapper.findAll('.post-form__actions button')[1].trigger('click');
		await settle();
		const [call] = writes(app.fetchRef);
		expect(call.url).toBe('/api/v1/posts/draft');
		expect(call.json).toEqual({ body: '', audience: 'selected', selected_follower_ids: [] });
		expect(backend.posts.get(150).title).toBe('Older draft');
		expect(app.router.currentRoute.value.fullPath).toBe('/posts/151/edit');
		expect(textOf(app.wrapper)).toContain('Draft saved.');
		expect(textOf(app.wrapper)).toContain('Edit draft');
	});

	test('an account change discards unsent text', async () => {
		const app = await compose();
		await app.wrapper.get('#compose-body').setValue('Private thought');
		app.session.acceptAccount({ id: 7, display_name: 'Ada Lovelace' });
		await settle();
		expect(
			app.wrapper.find('#compose-body').exists()
				? app.wrapper.get('#compose-body').element.value
				: '',
		).toBe('');
	});
});
