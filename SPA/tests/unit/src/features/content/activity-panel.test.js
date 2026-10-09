// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DiscussionBackend } from '../../../../fixtures/phase3/discussion-backend.js';
import { cleanupMounted, mountContentApp, settle, signal } from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});
const button = (wrapper, label) => wrapper.findAll('button').find((b) => b.text() === label);
const activity = (wrapper) => wrapper.get('[data-screen="activity-panel"]');
const visiblePosts = (wrapper) =>
	wrapper.findAll('[data-post-id]').map((p) => Number(p.attributes('data-post-id')));
function model() {
	const backend = new DiscussionBackend();
	backend.addPost({
		id: 102,
		body: 'Private selected text',
		audience: 'selected',
		selected_follow_ids: [71],
	});
	backend.addPost({ id: 103, body: 'Private draft text', status: 'draft' });
	backend.reactions.set('7:posts:101', 1);
	backend.reactions.set('7:posts:102', -1);
	return backend;
}
describe('SN-A13 profiles and private activity', () => {
	test.each(
		['public', 'private'].flatMap((visibility) =>
			['public', 'followers', 'selected'].flatMap((audience) =>
				[42, 7, 8, 9, 99].map((viewerId) => ({ visibility, audience, viewerId })),
			),
		),
	)('profile $visibility / $audience / $viewerId filters activity before totals', async ({
		visibility,
		audience,
		viewerId,
	}) => {
		const backend = new DiscussionBackend();
		backend.users.get(42).visibility = visibility;
		backend.posts.get(101).audience = audience;
		backend.posts.get(101).selected_follow_ids = [71];
		const { wrapper } = await mountContentApp('/users/42', { backend, viewerId });
		const full = visibility === 'public' || [42, 7, 8].includes(viewerId);
		const allowed =
			viewerId === 42 ||
			(full &&
				(audience === 'public' ||
					(audience === 'followers' && [7, 8].includes(viewerId)) ||
					(audience === 'selected' && viewerId === 7)));
		expect(wrapper.find('[data-screen="activity-panel"]').exists()).toBe(full);
		expect(visiblePosts(wrapper)).toEqual(allowed ? [101] : []);
		if (full) expect(activity(wrapper).text()).toContain(allowed ? '1 post' : '0 posts');
		expect(wrapper.text().includes('Your private activity')).toBe(viewerId === 42);
	});
	test('profile comments require profile and published parent access, with no private history tabs', async () => {
		const backend = model();
		const { wrapper, router } = await mountContentApp('/users/7', { backend, viewerId: 8 });
		await button(activity(wrapper), 'Comments').trigger('click');
		await settle();
		expect(activity(wrapper).text()).toContain('Reply');
		expect(activity(wrapper).text()).not.toContain('Liked');
		expect(activity(wrapper).text()).not.toContain('Drafts');
		backend.posts.get(101).audience = 'selected';
		backend.posts.get(101).selected_follow_ids = [71];
		await router.push('/users/42');
		await settle();
		await router.push('/users/7');
		await settle();
		await button(activity(wrapper), 'Comments').trigger('click');
		await settle();
		expect(activity(wrapper).text()).not.toContain('Reply');
	});
	test('owner history shows created/liked/disliked/comments and reuses draft editors', async () => {
		const backend = model();
		const { wrapper } = await mountContentApp('/activity', { backend, viewerId: 7 });
		expect(activity(wrapper).text()).toContain('0 posts');
		await button(activity(wrapper), 'Liked').trigger('click');
		await settle();
		expect(visiblePosts(wrapper)).toEqual([101]);
		await button(activity(wrapper), 'Disliked').trigger('click');
		await settle();
		expect(visiblePosts(wrapper)).toEqual([102]);
		await button(activity(wrapper), 'Comments').trigger('click');
		await settle();
		expect(activity(wrapper).text()).toContain('Reply');
		expect(activity(wrapper).get('[data-comment-id] a.text-link').attributes('href')).toBe(
			'/comments/201',
		);
	});
	test('created history filters drafts and offers owner editor links, other profiles never include drafts', async () => {
		const backend = model();
		const { wrapper, router } = await mountContentApp('/activity', { backend });
		expect(visiblePosts(wrapper)).toEqual([103, 102, 101]);
		await wrapper.get('select').setValue('draft');
		await settle();
		expect(visiblePosts(wrapper)).toEqual([103]);
		expect(wrapper.get('.post-card__edit').attributes('href')).toBe('/posts/103/edit');
		await router.push('/users/42');
		await settle();
		expect(visiblePosts(wrapper)).toEqual([102, 101]);
	});
	test('invalidation hides private history parent titles, counts and links after unfollow, refollow restores no selected grant', async () => {
		const backend = model();
		const { wrapper, sockets } = await mountContentApp('/activity', { backend, viewerId: 7 });
		await button(activity(wrapper), 'Disliked').trigger('click');
		await settle();
		expect(activity(wrapper).text()).toContain('Private selected text');
		backend.removeFollow(backend.users.get(7), '71');
		await signal(sockets);
		expect(activity(wrapper).text()).toContain('0 posts');
		expect(activity(wrapper).text()).not.toContain('Private selected text');
		expect(visiblePosts(wrapper)).toEqual([]);
		backend.follows.push({ id: 74, follower_id: 7, followed_id: 42, state: 'accepted' });
		await signal(sockets);
		expect(visiblePosts(wrapper)).toEqual([]);
	});
	test('profile changes to teaser discard mounted activity and totals', async () => {
		const backend = model();
		const { wrapper, sockets } = await mountContentApp('/users/42', { backend, viewerId: 99 });
		expect(visiblePosts(wrapper)).toEqual([101]);
		backend.users.get(42).visibility = 'private';
		await signal(sockets);
		expect(wrapper.find('[data-screen="activity-panel"]').exists()).toBe(false);
		expect(visiblePosts(wrapper)).toEqual([]);
	});
	test('pagination remains usable when totals shrink and errors have retry and empty states', async () => {
		const backend = model();
		for (let id = 104; id <= 130; id++) backend.addPost({ id });
		const { wrapper, sockets } = await mountContentApp('/activity', { backend });
		await button(activity(wrapper), 'Next').trigger('click');
		await settle();
		expect(activity(wrapper).text()).toContain('Page 2 of 2');
		for (let id = 104; id <= 130; id++) backend.posts.delete(id);
		await signal(sockets);
		expect(activity(wrapper).text()).toContain('This page is empty');
		await button(activity(wrapper), 'Previous').trigger('click');
		await settle();
		expect(visiblePosts(wrapper)).toHaveLength(3);
		backend.faults.push({ method: 'GET', path: /\/users\/activity$/u });
		await signal(sockets);
		expect(visiblePosts(wrapper)).toEqual([]);
		expect(activity(wrapper).text()).toContain('Activity could not be loaded');
		await button(activity(wrapper), 'Try again').trigger('click');
		await settle();
		expect(visiblePosts(wrapper)).toHaveLength(3);
	});
	test('logout/back and account switching never show previous discussion or private history', async () => {
		const backend = model();
		const { wrapper, router, current, session } = await mountContentApp('/activity', { backend });
		current.viewerId = 7;
		await session.restore({ force: true });
		await settle();
		expect(visiblePosts(wrapper)).toEqual([]);
		await router.push('/posts/101');
		await settle();
		current.viewerId = null;
		await session.restore({ force: true });
		await settle();
		expect(wrapper.find('[data-post-id]').exists()).toBe(false);
		await router.push('/activity');
		await settle();
		expect(router.currentRoute.value.name).toBe('login');
		expect(wrapper.find('[data-screen="activity-panel"]').exists()).toBe(false);
	});
	test('content notifications link to post or exact comment and revoked links recover without excerpts', async () => {
		const backend = model();
		backend.notifications.push({
			id: 501,
			type: 'comment_like',
			recipient_id: 7,
			actor: { id: 42 },
			target: { kind: 'comment', post_id: 101, comment_id: 201, title: null, excerpt: 'Reply' },
			created_at: backend.clock,
			is_read: false,
			actions: [],
		});
		const { wrapper, router, sockets } = await mountContentApp('/feed', { backend, viewerId: 7 });
		await wrapper.get('.notification-trigger').trigger('click');
		await settle();
		const link = wrapper.get('[data-notice-id="501"] .notice__context');
		expect(link.attributes('href')).toBe('/comments/201');
		await link.trigger('click');
		await settle();
		expect(router.currentRoute.value.name).toBe('comment');
		expect(wrapper.find('[data-comment-id="201"]').exists()).toBe(true);
		backend.posts.get(101).audience = 'selected';
		backend.posts.get(101).selected_follow_ids = [];
		await signal(sockets);
		expect(wrapper.text()).not.toContain('Reply');
		await wrapper.get('.notification-trigger').trigger('click');
		await settle();
		expect(wrapper.find('[data-notice-id="501"]').exists()).toBe(false);
		await router.push('/posts/101');
		await settle();
		expect(wrapper.text()).toContain('This discussion isn’t available');
	});
});
