// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ContentBackend } from '../../../../fixtures/phase3/content-backend.js';
import {
	cleanupMounted,
	contentCalls,
	deferred,
	mountContentApp,
	settle,
	signal,
	textOf,
} from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const at = (minute) => `2026-10-06T12:${String(minute).padStart(2, '0')}:00Z`;
const ids = (wrapper) =>
	wrapper.findAll('[data-post-id]').map((card) => Number(card.attributes('data-post-id')));

// Alex (42) is followed by Ada (7, follow 71) and Sam (8, follow 72); Pat (9)
// is pending; Robin (99) is an outsider. Post 101 is Alex's public post.
function audienceModel() {
	const backend = new ContentBackend();
	backend.addPost({ id: 102, title: 'Followers only', audience: 'followers', created_at: at(2) });
	backend.addPost({
		id: 103,
		title: 'Just for Ada',
		audience: 'selected',
		selected_follow_ids: [71],
		created_at: at(3),
	});
	backend.addPost({ id: 104, author_id: 99, body: 'Robin public', created_at: at(4) });
	backend.addPost({ id: 105, title: 'Unfinished', status: 'draft', created_at: at(5) });
	return backend;
}

describe('SN-A12 feed', () => {
	test('each viewer sees only the posts the audience matrix permits, newest first', async () => {
		const backend = audienceModel();
		const expected = { 99: [104, 101], 8: [104, 102, 101], 7: [104, 103, 102, 101], 9: [104, 101] };
		for (const [viewer, visible] of Object.entries(expected)) {
			const { wrapper } = await mountContentApp('/feed', { backend, viewerId: Number(viewer) });
			expect(ids(wrapper)).toEqual(visible);
			// Recipients are never disclosed to non-authors, including Ada.
			expect(textOf(wrapper)).not.toMatch(/Shared with|selected follower/u);
			const editable = wrapper.findAll('.post-card__edit').map((link) => link.attributes('href'));
			expect(editable).toEqual(viewer === '99' ? ['/posts/104/edit'] : []);
			cleanupMounted();
		}
	});

	test('a private author’s posts stay hidden from outsiders even when marked Public', async () => {
		const backend = audienceModel();
		backend.users.get(42).visibility = 'private';
		const outsider = await mountContentApp('/feed', { backend, viewerId: 99 });
		expect(ids(outsider.wrapper)).toEqual([104]);
		cleanupMounted();
		const follower = await mountContentApp('/feed', { backend, viewerId: 8 });
		expect(ids(follower.wrapper)).toEqual([104, 102, 101]);
		expect(follower.wrapper.get('[data-post-id="101"] [data-audience]').text()).toBe('Public');
	});

	test('the author sees their own posts with owner controls and recipient counts', async () => {
		const { wrapper } = await mountContentApp('/feed', { backend: audienceModel() });
		expect(ids(wrapper)).toEqual([104, 103, 102, 101]);
		const selected = wrapper.get('[data-post-id="103"]');
		expect(selected.text()).toContain('Shared with 1 selected follower.');
		expect(selected.get('.post-card__edit').attributes('aria-label')).toBe('Edit “Just for Ada”');
		expect(wrapper.find('[data-post-id="104"] .post-card__edit').exists()).toBe(false);
		// Untitled posts still have an accessible heading.
		expect(wrapper.get('[data-post-id="101"] h2').text()).toBe('Post by Alex Example');
	});

	test('Following excludes own posts and combines with categories using AND', async () => {
		const backend = audienceModel();
		backend.addPost({
			id: 106,
			author_id: 99,
			body: 'Robin general',
			categories: [{ id: 1, name: 'General' }],
			created_at: at(6),
		});
		backend.addPost({
			id: 107,
			author_id: 42,
			title: 'Alex general',
			categories: [{ id: 1, name: 'General' }],
			created_at: at(7),
		});
		const app = await mountContentApp('/feed', { backend, viewerId: 7 });
		await app.wrapper.get('.segmented a[href="/feed?feed=following"]').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/feed?feed=following');
		expect(ids(app.wrapper)).toEqual([107, 103, 102, 101]);
		expect(app.wrapper.get('.segmented [aria-current="page"]').text()).toBe('Following');

		await app.wrapper
			.get('.category-filter a[href="/feed?feed=following&category=1"]')
			.trigger('click');
		await settle();
		expect(ids(app.wrapper)).toEqual([107]);
		expect(textOf(app.wrapper)).toContain('1 post from people you follow in General');
		expect(contentCalls(app.fetchRef).at(-1).url).toBe(
			'/api/v1/posts?feed=following&category_id=1',
		);

		app.current.viewerId = 99;
		await app.router.push('/feed?feed=following');
		await settle();
		expect(textOf(app.wrapper)).toContain('Nothing from people you follow yet.');
	});

	test('category chips on a card open that category, and the filter survives reloads', async () => {
		const backend = audienceModel();
		backend.addPost({
			id: 106,
			author_id: 99,
			body: 'Robin general',
			categories: [{ id: 1, name: 'General' }],
			created_at: at(6),
		});
		const app = await mountContentApp('/feed', { backend, viewerId: 99 });
		await app.wrapper.get('[data-post-id="106"] .post-card__categories a').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/feed?category=1');
		expect(ids(app.wrapper)).toEqual([106]);
		cleanupMounted();
		const reloaded = await mountContentApp('/feed?category=1', { backend, viewerId: 99 });
		expect(ids(reloaded.wrapper)).toEqual([106]);
		expect(reloaded.wrapper.get('.category-filter [aria-current="page"]').text()).toBe('General');
	});

	test('malformed filters recover to canonical route state; unknown categories explain themselves', async () => {
		const app = await mountContentApp('/feed?feed=private&category=007&page=0&extra=1', {
			backend: audienceModel(),
			viewerId: 99,
		});
		expect(app.router.currentRoute.value.fullPath).toBe('/feed');
		expect(
			contentCalls(app.fetchRef, { path: /\/posts/u }).every(
				(call) => call.url === '/api/v1/posts',
			),
		).toBe(true);
		await app.router.push('/feed?category=999');
		await settle();
		expect(app.wrapper.find('[data-state="unknown-category"]').exists()).toBe(true);
		await app.wrapper.get('[data-state="unknown-category"] a').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/feed');
	});

	test('pages through permitted posts and recovers from a page beyond the end', async () => {
		const backend = new ContentBackend();
		for (let index = 0; index < 24; index += 1) {
			backend.addPost({ id: 200 + index, body: `Item ${index}`, created_at: at(10 + index) });
		}
		const app = await mountContentApp('/feed', { backend, viewerId: 99 });
		expect(ids(app.wrapper)).toHaveLength(20);
		expect(textOf(app.wrapper)).toContain('25 posts');
		await app.wrapper.get('.pager a[rel="next"]').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/feed?page=2');
		expect(ids(app.wrapper)).toEqual([203, 202, 201, 200, 101]);
		await app.router.push('/feed?page=9');
		await settle();
		expect(textOf(app.wrapper)).toContain('That page doesn’t exist.');
	});

	test('a slow response for superseded filters never paints over the current view', async () => {
		const backend = audienceModel();
		const gate = deferred();
		let held = false;
		const app = await mountContentApp('/feed', {
			backend,
			viewerId: 7,
			before: async (entry) => {
				if (!held && entry.url === '/api/v1/posts?feed=following') {
					held = true;
					await gate.promise;
				}
			},
		});
		await app.router.push('/feed?feed=following');
		await settle();
		expect(app.wrapper.text()).toContain('Loading posts…');
		await app.router.push('/feed?category=1');
		await settle();
		expect(ids(app.wrapper)).toEqual([]);
		gate.release();
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/feed?category=1');
		expect(ids(app.wrapper)).toEqual([]);
		expect(textOf(app.wrapper)).toContain('No posts in this category yet.');
	});

	test('a permission signal discards protected posts before refetching', async () => {
		const backend = audienceModel();
		const app = await mountContentApp('/feed', { backend, viewerId: 7 });
		expect(ids(app.wrapper)).toContain(103);
		const gate = deferred();
		let hold = true;
		app.fetchRef.calls.length = 0;
		backend.request(7, 'DELETE', '/api/v1/follows/71');
		const original = globalThis.fetch;
		vi.stubGlobal('fetch', async (url, init) => {
			if (hold && url.startsWith('/api/v1/posts')) {
				hold = false;
				await gate.promise;
			}
			return original(url, init);
		});
		app.sockets.at(-1).onmessage({ data: '{"type":"social.invalidate"}' });
		await settle();
		// The old cards are gone while the refetch is still outstanding.
		expect(ids(app.wrapper)).toEqual([]);
		expect(app.wrapper.text()).toContain('Loading posts…');
		gate.release();
		await settle();
		expect(ids(app.wrapper)).toEqual([104, 101]);
	});

	test('an outage shows an unavailable state without stale cards, then recovers', async () => {
		const backend = audienceModel();
		let down = false;
		const app = await mountContentApp('/feed', {
			backend,
			viewerId: 7,
			before: async (entry) => {
				if (down && entry.url.startsWith('/api/v1/posts')) throw new TypeError('offline');
			},
		});
		down = true;
		await signal(app.sockets);
		expect(ids(app.wrapper)).toEqual([]);
		expect(textOf(app.wrapper)).toContain('We can’t load posts right now.');
		down = false;
		await app.wrapper.get('.social-state--error button').trigger('click');
		await settle();
		expect(ids(app.wrapper)).toHaveLength(4);
	});

	test('a revoked session clears the feed and returns to sign in', async () => {
		const app = await mountContentApp('/feed', { backend: audienceModel(), viewerId: 7 });
		app.current.viewerId = null;
		await signal(app.sockets);
		expect(app.router.currentRoute.value.name).toBe('login');
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
	});
});
