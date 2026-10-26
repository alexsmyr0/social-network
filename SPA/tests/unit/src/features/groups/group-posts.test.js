// @vitest-environment jsdom
// SN-A16: group posts view and member home-feed integration against the
// stateful Phase 4 content model (itself proved against the approved pack).
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GroupContentBackend } from '../../../../fixtures/phase4/group-content-backend.js';
import {
	cleanupMounted,
	contentCalls,
	mountGroupContentApp,
	removeMember,
	settle,
	signal,
	switchAccount,
	textOf,
} from './content-harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const navLinks = (wrapper) =>
	wrapper.findAll('.group-nav a').map((link) => [link.text(), link.attributes('href')]);
const postIds = (wrapper) =>
	wrapper
		.findAll('.post-list [data-post-id]')
		.map((card) => Number(card.attributes('data-post-id')));
const groupFeedCalls = (fetchRef) =>
	contentCalls(fetchRef, { method: 'GET', path: /\/posts\?.*group_id=/u });

describe('SN-A16 role-appropriate group posts', () => {
	test('a member reads the group feed with group context, including a private author and a departed author', async () => {
		const app = await mountGroupContentApp('/groups/301/posts', { viewerId: 42 });
		expect(navLinks(app.wrapper)).toEqual([
			['About', '/groups/301'],
			['Posts', '/groups/301/posts'],
			['Events', '/groups/301/events'],
			['Chat', '/groups/301/chat'],
			['Members', '/groups/301/members'],
			['Join requests', '/groups/301/requests'],
		]);
		expect(app.wrapper.get('.group-nav [aria-current="page"]').text()).toBe('Posts');
		// Newest first: Ada (private profile) then Kim (no longer a member).
		expect(postIds(app.wrapper)).toEqual([111, 112]);
		const ada = app.wrapper.get('[data-post-id="111"]');
		expect(ada.text()).toContain('Ada Lovelace');
		expect(ada.get('.badge--group').text()).toBe('Group · Chess Club');
		expect(ada.find('.badge--audience').exists()).toBe(false);
		expect(ada.get('.badge--group').attributes('href')).toBe('/groups/301/posts');
		expect(textOf(app.wrapper.get('[data-post-id="112"]'))).toContain('Kim Example');
		expect(textOf(app.wrapper)).toContain('2 posts');
		expect(groupFeedCalls(app.fetchRef).map((call) => call.url)).toEqual([
			'/api/v1/posts?group_id=301',
		]);
		// A member sees no personal-profile fields through group authorship.
		expect(textOf(app.wrapper)).not.toContain('person7@example.com');
	});

	test('no one without membership requests or sees group posts', async () => {
		for (const viewerId of [99, 10, 8, 9, 11, 12]) {
			const app = await mountGroupContentApp('/groups/301/posts', { viewerId });
			const text = textOf(app.wrapper);
			expect(text, `viewer ${viewerId}`).toContain('Only members can read group posts.');
			expect(text).not.toContain('Group hello');
			expect(text).not.toContain("Kim's retained post");
			expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
			expect(groupFeedCalls(app.fetchRef)).toHaveLength(0);
			expect(contentCalls(app.fetchRef, { path: /\/media\// })).toHaveLength(0);
			expect(app.wrapper.find('.group-nav a[href$="/posts"]').exists()).toBe(false);
			cleanupMounted();
		}
	});

	test('direct links and malformed groups never reveal posts', async () => {
		const missing = await mountGroupContentApp('/groups/999/posts', { viewerId: 42 });
		expect(textOf(missing.wrapper)).toContain('This group isn’t available.');
		expect(groupFeedCalls(missing.fetchRef)).toHaveLength(0);
		cleanupMounted();
		const bad = await mountGroupContentApp('/groups/abc/posts', { viewerId: 42 });
		expect(textOf(bad.wrapper)).toContain('No route here');
		expect(contentCalls(bad.fetchRef)).toHaveLength(0);
	});

	test('Following and category filters stay inside the group and combine', async () => {
		const backend = new GroupContentBackend({
			given: { follows: { 73: { id: 73, follower_id: 42, followed_id: 11, state: 'accepted' } } },
		});
		const app = await mountGroupContentApp('/groups/301/posts', { backend, viewerId: 42 });
		await app.wrapper.get('.segmented a[href*="feed=following"]').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/groups/301/posts?feed=following');
		expect(postIds(app.wrapper)).toEqual([112]);
		expect(groupFeedCalls(app.fetchRef).at(-1).url).toBe(
			'/api/v1/posts?feed=following&group_id=301',
		);
		await app.wrapper.get('.category-filter a[href*="category=1"]').trigger('click');
		await settle();
		expect(groupFeedCalls(app.fetchRef).at(-1).url).toBe(
			'/api/v1/posts?feed=following&category_id=1&group_id=301',
		);
		expect(postIds(app.wrapper)).toEqual([]);
		expect(textOf(app.wrapper)).toContain('Nothing here from people you follow.');
		await app.wrapper.get('.segmented a[href="/groups/301/posts?category=1"]').trigger('click');
		await settle();
		expect(postIds(app.wrapper)).toEqual([111]);
		expect(textOf(app.wrapper)).toContain('1 post in General');
	});

	test('hand-edited filters recover and a category chip on a group card stays in the group', async () => {
		const app = await mountGroupContentApp('/groups/301/posts?feed=all&category=abc&page=0&x=1', {
			viewerId: 42,
		});
		expect(app.router.currentRoute.value.fullPath).toBe('/groups/301/posts');
		await app.wrapper.get('[data-post-id="111"] .post-card__categories a').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/groups/301/posts?category=1');
		expect(postIds(app.wrapper)).toEqual([111]);
		const unknown = await mountGroupContentApp('/groups/301/posts?category=77', { viewerId: 42 });
		expect(textOf(unknown.wrapper)).toContain('That category isn’t available.');
	});

	test('an empty group, a page past the end and pagination are explained', async () => {
		const empty = new GroupContentBackend({
			given: { posts: { 111: null, 112: null, 113: null, 114: null, 121: null } },
		});
		const first = await mountGroupContentApp('/groups/301/posts', { backend: empty, viewerId: 7 });
		expect(textOf(first.wrapper)).toContain('No one has posted here yet.');
		cleanupMounted();
		const app = await mountGroupContentApp('/groups/301/posts?page=4', { viewerId: 42 });
		expect(textOf(app.wrapper)).toContain('That page doesn’t exist.');
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
	});

	test('a feed outage is unavailable with a retry, never an empty or stale group', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/groups/301/posts', { backend, viewerId: 7 });
		backend.faults.push({ method: 'GET', path: /\/posts$/u, commit: false });
		await signal(app.sockets);
		expect(app.wrapper.find('[role="alert"] h3').text()).toBe(
			'We can’t load this group’s posts right now.',
		);
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
		await app.wrapper.get('[role="alert"] button').trigger('click');
		await settle();
		expect(postIds(app.wrapper)).toEqual([111, 112]);
	});
});

describe('SN-A16 membership changes and open group views', () => {
	test('a removal signal closes the open posts view; fresh admission restores it', async () => {
		const app = await mountGroupContentApp('/groups/301/posts', { viewerId: 7 });
		expect(postIds(app.wrapper)).toEqual([111, 112]);
		await removeMember(app);
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can read group posts.');
		expect(textOf(app.wrapper)).not.toContain('Group hello');
		const requests = groupFeedCalls(app.fetchRef).length;
		// Fresh admission: a new request that the creator accepts, not the old ID.
		app.backend.request(7, 'POST', '/api/v1/groups/301/join-requests', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		app.backend.request(42, 'PATCH', '/api/v1/group-join-requests/702', {
			json: { decision: 'accept' },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await signal(app.sockets);
		expect(postIds(app.wrapper)).toEqual([111, 112]);
		expect(groupFeedCalls(app.fetchRef).length).toBeGreaterThan(requests);
		expect(app.backend.membershipOf(301, 7).id).toBeGreaterThan(504 - 1);
	});

	test('a missed removal is recovered by a reconnect refetch', async () => {
		const app = await mountGroupContentApp('/groups/301/posts', { viewerId: 7 });
		app.backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		app.sockets.at(-1).onopen?.();
		await settle();
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can read group posts.');
	});

	test('a feed response that was in flight before removal never repaints', async () => {
		let hold = null;
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/groups/301/posts', {
			backend,
			viewerId: 7,
			before: async (entry) => {
				if (hold && /\/posts\?group_id=301/u.test(entry.url)) await hold;
			},
		});
		let release;
		hold = new Promise((resolve) => {
			release = resolve;
		});
		const staleRead = app.wrapper.vm.$router.push('/groups/301/posts?feed=following');
		await settle();
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		hold = null;
		await signal(app.sockets);
		release();
		await staleRead;
		await settle();
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can read group posts.');
	});

	test('switching accounts never shows the previous member’s group posts', async () => {
		const app = await mountGroupContentApp('/groups/301/posts', { viewerId: 7 });
		expect(postIds(app.wrapper)).toEqual([111, 112]);
		await switchAccount(app, 99);
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can read group posts.');
		expect(textOf(app.wrapper)).not.toContain('Group hello');
		await switchAccount(app, 42);
		expect(postIds(app.wrapper)).toEqual([111, 112]);
	});
});

describe('SN-A16 member home feed', () => {
	test('a member’s feed mixes personal and group posts, with group context and no widened access', async () => {
		const app = await mountGroupContentApp('/feed', { viewerId: 7 });
		expect(postIds(app.wrapper)).toEqual([111, 112, 121]);
		expect(app.wrapper.get('[data-post-id="111"] .badge--group').text()).toBe('Group · Chess Club');
		expect(app.wrapper.get('[data-post-id="121"] .badge--audience').text()).toBe('Followers');
		expect(app.wrapper.find('[data-post-id="121"] .badge--group').exists()).toBe(false);
		expect(contentCalls(app.fetchRef, { method: 'GET', path: /group_id/u })).toHaveLength(0);
		// The group card's category chip leaves the home feed for the group's own.
		expect(
			app.wrapper.get('[data-post-id="111"] .post-card__categories a').attributes('href'),
		).toBe('/groups/301/posts?category=1');
	});

	test.each([
		[99, 'an outsider'],
		[8, 'a pending invitee'],
		[9, 'a pending requester'],
		[12, 'a departed member'],
	])('%i (%s) gets no group posts in the home feed', async (viewerId) => {
		const app = await mountGroupContentApp('/feed', { viewerId });
		// Only Ada's followers-only note exists as a personal post, and none of
		// these viewers follows her.
		expect(postIds(app.wrapper)).toEqual([]);
		expect(textOf(app.wrapper)).not.toContain('Group hello');
		expect(textOf(app.wrapper)).not.toContain('Chess Club');
	});

	test('a nonmember follower of a private author sees the personal post but never the group post', async () => {
		const app = await mountGroupContentApp('/feed', { viewerId: 10 });
		expect(postIds(app.wrapper)).toEqual([121]);
		expect(textOf(app.wrapper)).not.toContain('Chess Club');
	});

	test('the home feed Following and category filters combine without broadening group access', async () => {
		const backend = new GroupContentBackend({
			given: { follows: { 73: { id: 73, follower_id: 42, followed_id: 11, state: 'accepted' } } },
		});
		const app = await mountGroupContentApp('/feed?feed=following', { backend, viewerId: 42 });
		expect(postIds(app.wrapper)).toEqual([112]);
		expect(app.wrapper.get('[data-post-id="112"] .badge--group').text()).toBe('Group · Chess Club');
		await app.router.push('/feed?category=1');
		await settle();
		expect(postIds(app.wrapper)).toEqual([111]);
	});

	test('removal drops the group posts from an open home feed', async () => {
		const app = await mountGroupContentApp('/feed', { viewerId: 7 });
		expect(postIds(app.wrapper)).toEqual([111, 112, 121]);
		await removeMember(app);
		expect(postIds(app.wrapper)).toEqual([121]);
		expect(textOf(app.wrapper)).not.toContain('Group hello');
	});
});
