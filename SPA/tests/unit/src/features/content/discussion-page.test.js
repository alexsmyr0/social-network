// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DiscussionBackend } from '../../../../fixtures/phase3/discussion-backend.js';
import {
	chooseFile,
	cleanupMounted,
	deferred,
	mountContentApp,
	pngFile,
	settle,
	signal,
} from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});
const button = (wrapper, label) => wrapper.findAll('button').find((item) => item.text() === label);
const card = (wrapper, id) => wrapper.get(`[data-comment-id="${id}"]`);
async function send(wrapper, text) {
	await wrapper.get('#comment-body-new').setValue(text);
	await wrapper.get('.comment-form').trigger('submit');
	await settle();
}
describe('SN-A13 discussions', () => {
	test('renders names, existing parent IDs and only the comment author gets mutations', async () => {
		const backend = new DiscussionBackend();
		backend.comments.set(202, {
			...backend.comments.get(201),
			id: 202,
			parent_comment_id: 201,
			user_id: 42,
			username: 'Alex Example',
			body: 'Child reply',
		});
		const { wrapper } = await mountContentApp('/posts/101', { backend });
		expect(card(wrapper, 201).text()).toContain('Ada Lovelace');
		expect(card(wrapper, 201).text()).not.toContain('Edit comment');
		expect(card(wrapper, 202).text()).toContain('Reply to comment #201');
		expect(card(wrapper, 202).text()).toContain('Edit comment');
		expect(wrapper.text()).not.toContain('ada@example');
	});
	test('creates and edits own comment, preserving then replacing and removing attachments', async () => {
		const backend = new DiscussionBackend();
		const { wrapper } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		await chooseFile(wrapper.get('.comment-form input[type=file]'), pngFile());
		await wrapper.get('.comment-form').trigger('submit');
		await settle();
		expect(backend.comments.get(202).body).toBe('');
		expect(backend.comments.get(202).image_url).toMatch(/media/u);
		await button(card(wrapper, 202), 'Edit comment').trigger('click');
		await card(wrapper, 202).get('textarea').setValue('Text added');
		await card(wrapper, 202).get('form').trigger('submit');
		await settle();
		const retained = backend.comments.get(202).image_url;
		await card(wrapper, 202).get('img').trigger('error');
		expect(card(wrapper, 202).text()).toContain('This image isn’t available');
		expect(backend.comments.get(202).body).toBe('Text added');
		await button(card(wrapper, 202), 'Edit comment').trigger('click');
		await chooseFile(card(wrapper, 202).get('input[type=file]'), pngFile('new.png'));
		await card(wrapper, 202).get('form').trigger('submit');
		await settle();
		expect(backend.comments.get(202).image_url).not.toBe(retained);
		expect(card(wrapper, 202).find('img').exists()).toBe(true);
		await button(card(wrapper, 202), 'Edit comment').trigger('click');
		await button(card(wrapper, 202), 'Remove image').trigger('click');
		await card(wrapper, 202).get('form').trigger('submit');
		await settle();
		expect(backend.comments.get(202).image_url).toBeNull();
	});
	test('reply create preserves the parent and deleting own parent cascades foreign descendants', async () => {
		const backend = new DiscussionBackend();
		const { wrapper } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		await button(card(wrapper, 201), 'Reply').trigger('click');
		await send(wrapper, 'Nested reply');
		expect(backend.comments.get(202).parent_comment_id).toBe(201);
		backend.comments.get(202).user_id = 42;
		await button(card(wrapper, 201), 'Delete comment').trigger('click');
		expect(backend.comments.has(201)).toBe(true);
		await button(card(wrapper, 201), 'Confirm deletion').trigger('click');
		await settle();
		expect(backend.comments.size).toBe(0);
	});
	test('post and comment reactions toggle, remove and switch from refreshed server counts', async () => {
		const backend = new DiscussionBackend();
		const { wrapper } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		for (const kind of ['posts', 'comments']) {
			const scope = () =>
				kind === 'posts'
					? wrapper.get('.discussion-view > .discussion-reactions')
					: card(wrapper, 201).get('.discussion-reactions');
			await button(scope(), 'Like · 0').trigger('click');
			await settle();
			expect(button(scope(), 'Like · 1').attributes('aria-pressed')).toBe('true');
			await button(scope(), 'Like · 1').trigger('click');
			await settle();
			expect(button(scope(), 'Like · 0').attributes('aria-pressed')).toBe('false');
			await button(scope(), 'Like · 0').trigger('click');
			await settle();
			await button(scope(), 'Dislike · 0').trigger('click');
			await settle();
			expect(button(scope(), 'Like · 0').attributes('aria-pressed')).toBe('false');
			expect(button(scope(), 'Dislike · 1').attributes('aria-pressed')).toBe('true');
		}
	});
	test('stale edit keeps unsent text and requires explicitly loading the current version', async () => {
		const backend = new DiscussionBackend();
		const { wrapper } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		await button(card(wrapper, 201), 'Edit comment').trigger('click');
		await card(wrapper, 201).get('textarea').setValue('Unsent');
		backend.comments.get(201).version = 2;
		backend.comments.get(201).body = 'From another tab';
		await card(wrapper, 201).get('form').trigger('submit');
		await settle();
		expect(card(wrapper, 201).get('textarea').element.value).toBe('Unsent');
		expect(button(card(wrapper, 201), 'Save comment').attributes('disabled')).toBeDefined();
		await button(card(wrapper, 201), 'Load latest comment').trigger('click');
		await settle();
		expect(card(wrapper, 201).get('textarea').element.value).toBe('From another tab');
		await card(wrapper, 201).get('textarea').setValue('Reviewed');
		await card(wrapper, 201).get('form').trigger('submit');
		await settle();
		expect(backend.comments.get(201).body).toBe('Reviewed');
	});
	test('unknown create/reaction outcomes are not replayed and display the committed state', async () => {
		const backend = new DiscussionBackend();
		const { wrapper, fetchRef } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		backend.faults.push({ method: 'POST', path: /\/comments$/u, commit: true });
		await send(wrapper, 'Committed once');
		expect(wrapper.text()).toContain('could not be confirmed');
		expect([...backend.comments.values()].filter((c) => c.body === 'Committed once')).toHaveLength(
			1,
		);
		expect(
			fetchRef.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments')),
		).toHaveLength(1);
		backend.faults.push({ method: 'POST', path: /\/like$/u, commit: true });
		await button(wrapper.get('.discussion-view > .discussion-reactions'), 'Like · 0').trigger(
			'click',
		);
		await settle();
		expect(wrapper.get('.discussion-view > .discussion-reactions').text()).toContain('Like · 1');
		expect(wrapper.get('.discussion-view > .discussion-reactions').text()).toContain(
			'could not be confirmed',
		);
	});
	test('blocks duplicate submissions and validation errors preserve text', async () => {
		const backend = new DiscussionBackend();
		const hold = deferred();
		const { wrapper, fetchRef } = await mountContentApp('/posts/101', {
			backend,
			before: (call) => (call.method === 'POST' ? hold.promise : undefined),
		});
		await wrapper.get('.comment-form').trigger('submit');
		expect(wrapper.text()).toContain('Write a comment or add an image');
		await wrapper.get('#comment-body-new').setValue('Once');
		const form = wrapper.get('.comment-form');
		await form.trigger('submit');
		await form.trigger('submit');
		expect(fetchRef.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
		hold.release();
		await settle();
	});
	test.each([
		'image/png',
		'image/jpeg',
		'image/gif',
	])('attachment controls accept %s and removing a fresh preview sends a valid text-only creation', async (type) => {
		const backend = new DiscussionBackend();
		const { wrapper, fetchRef } = await mountContentApp('/posts/101', { backend });
		await chooseFile(wrapper.get('.comment-form input'), new File(['image'], 'file', { type }));
		expect(wrapper.find('.comment-form img').exists()).toBe(true);
		await button(wrapper, 'Remove image').trigger('click');
		await send(wrapper, 'Text after removal');
		const sent = fetchRef.calls.find((call) => call.method === 'POST');
		expect(sent.json).toEqual({ body: 'Text after removal', parent_comment_id: null });
	});
	test('feed cards carry category and Following into discussion navigation', async () => {
		const backend = new DiscussionBackend();
		backend.posts.get(101).categories = [{ id: 1, name: 'Art' }];
		const { wrapper } = await mountContentApp('/feed?feed=following&category=1', {
			backend,
			viewerId: 7,
		});
		expect(wrapper.get('.post-card__discussion').attributes('href')).toBe(
			'/posts/101?feed=following&category=1',
		);
	});
	test('invalid image selection preserves text, image-only removal is rejected locally', async () => {
		const backend = new DiscussionBackend();
		const { wrapper } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		await wrapper.get('#comment-body-new').setValue('Still here');
		await chooseFile(
			wrapper.get('.comment-form input'),
			new File(['bad'], 'bad.svg', { type: 'image/svg+xml' }),
		);
		expect(wrapper.get('#comment-body-new').element.value).toBe('Still here');
		expect(wrapper.text()).toContain('Choose a JPEG, PNG or GIF');
		await button(card(wrapper, 201), 'Edit comment').trigger('click');
		await card(wrapper, 201).get('textarea').setValue('');
		await button(card(wrapper, 201), 'Remove image').trigger('click');
		await card(wrapper, 201).get('form').trigger('submit');
		expect(card(wrapper, 201).text()).toContain('Write a comment or add an image');
	});
	test.each([
		['deleted', () => null],
		['audience', (post) => ({ ...post, audience: 'selected', selected_follow_ids: [] })],
		['draft', (post) => ({ ...post, status: 'draft' })],
	])('invalidation discards the discussion after %s, including forms, images and counts', async (_name, change) => {
		const backend = new DiscussionBackend();
		const { wrapper, sockets } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		const next = change(backend.posts.get(101));
		if (next) backend.posts.set(101, next);
		else backend.posts.delete(101);
		await signal(sockets);
		expect(wrapper.text()).toContain('This discussion isn’t available');
		expect(wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(wrapper.find('[data-comment-id]').exists()).toBe(false);
		expect(wrapper.find('textarea').exists()).toBe(false);
	});
	test('permission-lost write never leaves success visible', async () => {
		const backend = new DiscussionBackend();
		const { wrapper } = await mountContentApp('/posts/101', { backend, viewerId: 7 });
		backend.posts.get(101).audience = 'selected';
		backend.posts.get(101).selected_follow_ids = [];
		await send(wrapper, 'Not authorized');
		expect(wrapper.text()).toContain('This discussion isn’t available');
		expect(backend.comments.size).toBe(1);
	});
	test('slow reads cannot repaint another route', async () => {
		const backend = new DiscussionBackend();
		const hold = deferred();
		const { wrapper, router, social } = await mountContentApp('/posts/101', { backend });
		const original = globalThis.fetch;
		vi.stubGlobal('fetch', async (url, init) => {
			if (url.endsWith('/posts/101')) await hold.promise;
			return original(url, init);
		});
		void social.refresh('hard');
		await settle();
		await router.push('/posts/999');
		await settle();
		hold.release();
		await settle();
		expect(wrapper.text()).toContain('This discussion isn’t available');
		expect(wrapper.find('[data-post-id]').exists()).toBe(false);
	});
	test('deep-linked comments remain reachable beyond the first thread page', async () => {
		const backend = new DiscussionBackend();
		for (let id = 202; id <= 225; id++)
			backend.comments.set(id, { ...backend.comments.get(201), id, body: `Comment ${id}` });
		const { wrapper } = await mountContentApp('/comments/225', { backend });
		expect(wrapper.get('.focused-comment').text()).toContain('Comment 225');
	});
	test('navigation excludes denied neighbours and retains category/Following filters', async () => {
		const backend = new DiscussionBackend();
		backend.addPost({
			id: 102,
			audience: 'selected',
			selected_follow_ids: [],
			created_at: '2026-10-06T12:01:00Z',
		});
		backend.addPost({ id: 103, created_at: '2026-10-06T12:02:00Z' });
		const { wrapper, router } = await mountContentApp('/posts/101?feed=following', {
			backend,
			viewerId: 7,
		});
		expect(
			wrapper
				.get('nav[aria-label="Nearby posts"]')
				.findAll('a')
				.map((a) => a.attributes('href')),
		).toEqual(['/posts/103?feed=following']);
		await router.push('/posts/101?category=999');
		await settle();
		expect(wrapper.find('nav[aria-label="Nearby posts"]').exists()).toBe(false);
	});
	test('outage drops cached text, missing targets recover, and account changes clear unsent inputs', async () => {
		const backend = new DiscussionBackend();
		const { wrapper, sockets, current, session } = await mountContentApp('/posts/101', {
			backend,
			viewerId: 7,
		});
		await wrapper.get('#comment-body-new').setValue('Private unsent');
		current.viewerId = 99;
		await session.restore({ force: true });
		await settle();
		expect(wrapper.get('#comment-body-new').element.value).toBe('');
		backend.faults.push({ method: 'GET', path: /\/comments$/u });
		await signal(sockets);
		expect(wrapper.text()).toContain('We can’t load this discussion');
		expect(wrapper.find('[data-post-id]').exists()).toBe(false);
		await button(wrapper, 'Try again').trigger('click');
		await settle();
		expect(wrapper.find('[data-post-id]').exists()).toBe(true);
	});
});
