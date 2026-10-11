// @vitest-environment jsdom
// SN-A16: comments, replies, reactions, attachments, navigation, activity and
// notices on group content. Membership is the only gate, it is rechecked on
// every read and write, and a removed member's open views close.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GroupContentBackend } from '../../../../fixtures/phase4/group-content-backend.js';
import {
	actAs,
	chooseFile,
	cleanupMounted,
	contentCalls,
	contentWrites,
	mountGroupContentApp,
	pngFile,
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

const button = (wrapper, label) => wrapper.findAll('button').find((item) => item.text() === label);
const card = (wrapper, id) => wrapper.get(`[data-comment-id="${id}"]`);
const commentIds = (wrapper) =>
	wrapper
		.findAll('.comment-list [data-comment-id]')
		.map((item) => Number(item.attributes('data-comment-id')));
const navCalls = (fetchRef) => contentCalls(fetchRef, { method: 'GET', path: /\/nav/u });

async function send(wrapper, text) {
	await wrapper.get('#comment-body-new').setValue(text);
	await wrapper.get('.comment-form').trigger('submit');
	await settle();
}

describe('SN-A16 group discussions', () => {
	test('a member reads a private author’s post, a departed author’s comment and the attachments', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 42 });
		const post = app.wrapper.get('[data-post-id="111"]');
		expect(post.text()).toContain('Ada Lovelace');
		expect(post.get('.badge--group').text()).toBe('Group · Chess Club');
		expect(post.get('.post-card__media img').attributes('src')).toBe('/api/v1/media/411');
		expect(commentIds(app.wrapper)).toEqual([211, 212]);
		// Kim left the group; her stored comment stays for the remaining members.
		expect(textOf(card(app.wrapper, 212))).toContain('Kim Example');
		expect(textOf(card(app.wrapper, 212))).toContain('Kim comment');
		expect(card(app.wrapper, 211).get('img').attributes('src')).toBe('/api/v1/media/413');
		expect(textOf(app.wrapper)).toContain('Comments · 2');
		expect(textOf(app.wrapper)).not.toContain('person7@example.com');
	});

	test('a group card opens its discussion scoped to the group, with Back to the group', async () => {
		const app = await mountGroupContentApp('/groups/301/posts', { viewerId: 42 });
		await app.wrapper.get('[data-post-id="111"] .post-card__discussion').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/posts/111?group=301');
		expect(navCalls(app.fetchRef).at(-1).url).toBe('/api/v1/posts/111/nav?group_id=301');
		const back = app.wrapper.get('.discussion-view .text-link');
		expect(back.text()).toBe('Back to Chess Club');
		expect(back.attributes('href')).toBe('/groups/301/posts');
		// 111 is the group's newest post, so Next is absent and Previous is Kim's.
		const nearby = app.wrapper.get('nav[aria-label="Nearby posts"]');
		expect(nearby.text()).toContain('Previous post');
		expect(nearby.text()).not.toContain('Next post');
		expect(nearby.get('a').attributes('href')).toBe('/posts/112?group=301');
	});

	test('from the home feed the discussion keeps the home scope for Previous and Next', async () => {
		const app = await mountGroupContentApp('/feed', { viewerId: 7 });
		await app.wrapper.get('[data-post-id="112"] .post-card__discussion').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/posts/112');
		expect(navCalls(app.fetchRef).at(-1).url).toBe('/api/v1/posts/112/nav');
		expect(textOf(app.wrapper.get('nav[aria-label="Nearby posts"]'))).toContain('Previous post');
		expect(app.wrapper.get('.discussion-view .text-link').text()).toBe('Back to Chess Club');
	});

	test('a group hint that does not match the post is ignored, never trusted', async () => {
		const app = await mountGroupContentApp('/posts/111?group=302', { viewerId: 42 });
		expect(navCalls(app.fetchRef).at(-1).url).toBe('/api/v1/posts/111/nav');
		const personal = await mountGroupContentApp('/posts/121?group=301', { viewerId: 7 });
		expect(navCalls(personal.fetchRef).at(-1).url).toBe('/api/v1/posts/121/nav');
		expect(personal.wrapper.get('.discussion-view .text-link').text()).toBe('Back to feed');
	});

	test('members comment, reply, edit and delete, with an attachment replaced then removed', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 42 });
		await send(app.wrapper, 'Nice');
		expect(app.backend.comments.get(214)).toMatchObject({
			post_id: 111,
			user_id: 42,
			body: 'Nice',
		});
		expect(commentIds(app.wrapper)).toContain(214);
		// The post's author is notified because they are a current member.
		expect(app.backend.visibleNotices(app.backend.user(7)).map((notice) => notice.type)).toContain(
			'comment',
		);
		await button(card(app.wrapper, 211), 'Reply').trigger('click');
		await settle();
		await send(app.wrapper, 'Replying');
		expect(app.backend.comments.get(215)).toMatchObject({ parent_comment_id: 211, user_id: 42 });
		await button(card(app.wrapper, 214), 'Edit comment').trigger('click');
		await card(app.wrapper, 214).get('textarea').setValue('Nice, really');
		await chooseFile(card(app.wrapper, 214).get('input[type=file]'), pngFile());
		await card(app.wrapper, 214).get('form').trigger('submit');
		await settle();
		expect(app.backend.comments.get(214)).toMatchObject({ body: 'Nice, really', version: 2 });
		const attached = app.backend.comments.get(214).image_url;
		expect(attached).toMatch(/^\/api\/v1\/media\//u);
		expect(app.backend.request(7, 'GET', attached).status).toBe(200);
		expect(app.backend.request(99, 'GET', attached).status).toBe(404);
		await button(card(app.wrapper, 214), 'Edit comment').trigger('click');
		await button(card(app.wrapper, 214), 'Remove image').trigger('click');
		await card(app.wrapper, 214).get('form').trigger('submit');
		await settle();
		expect(app.backend.comments.get(214).image_url).toBeNull();
		await button(card(app.wrapper, 214), 'Delete comment').trigger('click');
		await button(card(app.wrapper, 214), 'Confirm deletion').trigger('click');
		await settle();
		expect(app.backend.comments.has(214)).toBe(false);
	});

	test('mutation controls follow authorship alone: not the group creator, not membership', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 42 });
		expect(button(card(app.wrapper, 211), 'Edit comment')).toBeUndefined();
		expect(button(card(app.wrapper, 212), 'Delete comment')).toBeUndefined();
		expect(app.wrapper.find('[data-post-id="111"] .post-card__edit').exists()).toBe(false);
		cleanupMounted();
		const author = await mountGroupContentApp('/posts/111', { viewerId: 7 });
		expect(button(card(author.wrapper, 211), 'Edit comment')).toBeDefined();
		expect(button(card(author.wrapper, 212), 'Edit comment')).toBeUndefined();
		expect(author.wrapper.find('[data-post-id="111"] .post-card__edit').exists()).toBe(true);
	});

	test('reactions toggle on posts and comments; counts come from the server and a notice goes to a member', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 42 });
		const like = app.wrapper.findAll('.discussion-reactions button')[0];
		expect(like.text()).toBe('Like · 0');
		await like.trigger('click');
		await settle();
		expect(app.wrapper.findAll('.discussion-reactions button')[0].text()).toBe('Like · 1');
		expect(contentWrites(app.fetchRef)[0].url).toBe('/api/v1/posts/111/like');
		expect(
			[...app.backend.contentNotices.values()].some(
				(notice) => notice.recipient_id === 7 && notice.type === 'post_like',
			),
		).toBe(true);
		await card(app.wrapper, 212).findAll('.discussion-reactions button')[0].trigger('click');
		await settle();
		expect(card(app.wrapper, 212).findAll('.discussion-reactions button')[0].text()).toBe(
			'Like · 1',
		);
		// Kim is no longer a member, so her comment's like produces no notice for her.
		expect(
			[...app.backend.contentNotices.values()].some((notice) => notice.recipient_id === 11),
		).toBe(false);
	});

	test('nonmembers cannot open, see or react to a group discussion by direct link', async () => {
		for (const viewerId of [99, 8, 9, 10, 12, 11]) {
			const app = await mountGroupContentApp('/posts/111', { viewerId });
			const text = textOf(app.wrapper);
			expect(text, `viewer ${viewerId}`).toContain('This discussion isn’t available.');
			expect(text).not.toContain('Group hello');
			expect(text).not.toContain('Author reply');
			expect(app.wrapper.find('.discussion-reactions').exists()).toBe(false);
			expect(app.wrapper.find('.comment-form').exists()).toBe(false);
			expect(contentWrites(app.fetchRef)).toHaveLength(0);
			cleanupMounted();
		}
		const comment = await mountGroupContentApp('/comments/211', { viewerId: 99 });
		expect(textOf(comment.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(comment.wrapper)).not.toContain('Author reply');
	});

	test('the departed author cannot reach their own retained post or comment, but members still can', async () => {
		const departed = await mountGroupContentApp('/posts/112', { viewerId: 11 });
		expect(textOf(departed.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(departed.wrapper)).not.toContain('retained post');
		cleanupMounted();
		const member = await mountGroupContentApp('/posts/112', { viewerId: 7 });
		expect(textOf(member.wrapper)).toContain('Kim Example');
		expect(textOf(member.wrapper)).toContain("Kim's retained post");
		expect(commentIds(member.wrapper)).toEqual([213]);
	});

	test('a deep link to a comment resolves through the post and shows its context', async () => {
		const app = await mountGroupContentApp('/comments/212', { viewerId: 42 });
		expect(app.wrapper.find('[data-post-id="111"]').exists()).toBe(true);
		expect(document.activeElement.id).toBe('comment-212');
	});

	test('removal closes an open discussion by signal; the stale form cannot post, react or reveal anything', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 7 });
		await app.wrapper.get('#comment-body-new').setValue('Half written');
		await removeMember(app);
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		expect(app.wrapper.find('.comment-form').exists()).toBe(false);
		expect(textOf(app.wrapper)).not.toContain('Group hello');
		expect(textOf(app.wrapper)).not.toContain('Author reply');
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
	});

	test('a write refused after a silent removal says so and commits nothing', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/posts/111', { backend, viewerId: 7 });
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.wrapper.get('.discussion-reactions button').trigger('click');
		await settle();
		// The refused write is followed by a refetch that closes the discussion;
		// no reaction was recorded and no success was shown.
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(app.wrapper)).not.toContain('Like · 1');
		expect(backend.reactions.size).toBe(0);
		expect(app.wrapper.find('.comment-form').exists()).toBe(false);
		expect(backend.comments.has(214)).toBe(false);
	});

	test('a comment response lost after commit is reported as unconfirmed and never resent', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/posts/111', {
			backend,
			viewerId: 7,
			after: async (entry) => {
				if (entry.method === 'POST' && /comments$/u.test(entry.url)) throw new TypeError('lost');
			},
		});
		await send(app.wrapper, 'Maybe saved');
		expect(contentWrites(app.fetchRef)).toHaveLength(1);
		expect(backend.comments.has(214)).toBe(true);
		expect(app.wrapper.find('.comment-form .field-error').exists()).toBe(true);
	});

	test('an author unpublishing closes the discussion for every other member, and republishing reopens it', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 42 });
		expect(textOf(app.wrapper)).toContain('Author reply');
		await actAs(app, 7, 'PATCH', '/posts/111', { expected_version: 1, status: 'draft' });
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(app.wrapper)).not.toContain('Author reply');
		await actAs(app, 7, 'PATCH', '/posts/111', { expected_version: 2, status: 'published' });
		expect(textOf(app.wrapper)).toContain('Author reply');
		expect(commentIds(app.wrapper)).toEqual([211, 212]);
	});

	test('no earlier response is reused: leaving a page and returning re-asks the group', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/posts/111', { backend, viewerId: 7 });
		expect(textOf(app.wrapper)).toContain('Group hello');
		await app.router.push('/people');
		await settle();
		// Removed while away, with no signal delivered to this page.
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		const before = contentCalls(app.fetchRef, { method: 'GET', path: /\/posts\/111$/u }).length;
		await app.router.back();
		await settle();
		expect(contentCalls(app.fetchRef, { method: 'GET', path: /\/posts\/111$/u }).length).toBe(
			before + 1,
		);
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(app.wrapper)).not.toContain('Group hello');
		for (const call of app.fetchRef.calls) expect(call.headers.Accept).toBe('application/json');
	});

	test('switching accounts clears the previous member’s discussion', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 7 });
		expect(textOf(app.wrapper)).toContain('Author reply');
		await switchAccount(app, 99);
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(app.wrapper)).not.toContain('Author reply');
		await switchAccount(app, 42);
		expect(textOf(app.wrapper)).toContain('Author reply');
	});

	test('fresh admission brings the discussion back; a cancelled invitation does not revive', async () => {
		const app = await mountGroupContentApp('/posts/111', { viewerId: 7 });
		await removeMember(app);
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		await actAs(app, 7, 'POST', '/groups/301/join-requests');
		await actAs(app, 42, 'PATCH', '/group-join-requests/702', { decision: 'accept' });
		expect(textOf(app.wrapper)).toContain('Author reply');
		expect(app.backend.invitations.has(601)).toBe(false);
		expect(app.backend.membershipOf(301, 7).id).not.toBe(502);
	});
});

describe('SN-A16 activity, profiles and your posts', () => {
	test('your posts lists group posts and your group drafts with their group, to you only', async () => {
		const app = await mountGroupContentApp('/posts/mine', { viewerId: 7 });
		const cards = app.wrapper.findAll('.post-list [data-post-id]');
		expect(cards.map((item) => item.attributes('data-post-id'))).toEqual(['111', '113', '121']);
		expect(app.wrapper.get('[data-post-id="113"] .badge--status').text()).toBe('Draft');
		expect(app.wrapper.get('[data-post-id="113"] .badge--group').text()).toBe('Group · Chess Club');
		expect(app.wrapper.get('[data-post-id="113"] .post-card__edit').text()).toBe('Continue draft');
		expect(app.wrapper.get('[data-post-id="121"] .badge--audience').text()).toBe('Followers');
		cleanupMounted();
		const creator = await mountGroupContentApp('/posts/mine', { viewerId: 42 });
		expect(textOf(creator.wrapper)).not.toContain('Draft idea');
	});

	test('after removal your own group contributions disappear from your posts and activity', async () => {
		const app = await mountGroupContentApp('/posts/mine', { viewerId: 7 });
		await removeMember(app);
		expect(
			app.wrapper
				.findAll('.post-list [data-post-id]')
				.map((item) => item.attributes('data-post-id')),
		).toEqual(['121']);
		await app.router.push('/activity');
		await settle();
		expect(textOf(app.wrapper)).not.toContain('Group hello');
		expect(textOf(app.wrapper)).not.toContain('Author reply');
	});

	test('private activity shows group posts and comments only for a current member', async () => {
		const app = await mountGroupContentApp('/activity', { viewerId: 7 });
		expect(app.wrapper.find('[data-post-id="111"] .badge--group').exists()).toBe(true);
		await button(app.wrapper, 'Comments').trigger('click');
		await settle();
		expect(app.wrapper.get('[data-comment-id="211"] .badge--group').text()).toBe(
			'Group · Chess Club',
		);
		await button(app.wrapper, 'Liked').trigger('click');
		await settle();
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
	});

	test('profile activity for a full-access viewer lists only the group posts they belong to', async () => {
		const member = await mountGroupContentApp('/users/11', { viewerId: 42 });
		expect(member.wrapper.find('[data-post-id="112"] .badge--group').exists()).toBe(true);
		await button(member.wrapper, 'Comments').trigger('click');
		await settle();
		expect(member.wrapper.get('[data-comment-id="212"] .badge--group').text()).toBe(
			'Group · Chess Club',
		);
		cleanupMounted();
		const outsider = await mountGroupContentApp('/users/11', { viewerId: 99 });
		expect(outsider.wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(textOf(outsider.wrapper)).not.toContain('retained post');
		await button(outsider.wrapper, 'Comments').trigger('click');
		await settle();
		expect(textOf(outsider.wrapper)).not.toContain('Kim comment');
	});

	test('a private author’s profile stays a teaser for a member; no profile field arrives with a post', async () => {
		const app = await mountGroupContentApp('/users/7', { viewerId: 42 });
		expect(app.wrapper.find('[data-state="teaser"]').exists()).toBe(true);
		expect(app.wrapper.find('[data-post-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).not.toContain('person7@example.com');
		expect(contentCalls(app.fetchRef, { path: /users\/7\/(posts|comments)/u })).toHaveLength(0);
	});
});

describe('SN-A16 content notices', () => {
	async function openNotices(wrapper) {
		await wrapper.get('.notification-trigger').trigger('click');
		await settle();
	}
	const withLike = () =>
		new GroupContentBackend({
			given: {
				notifications: {
					803: {
						id: 803,
						recipient_id: 7,
						actor_id: 42,
						type: 'post_like',
						post_id: 111,
						comment_id: null,
						group_id: null,
						entry_id: null,
						state: null,
						is_read: false,
						created_at: '2026-10-09T12:00:00Z',
					},
				},
				next_ids: { notifications: 804 },
			},
		});

	test('a group-content notice opens its discussion through the global panel', async () => {
		const app = await mountGroupContentApp('/feed', { backend: withLike(), viewerId: 7 });
		expect(app.wrapper.get('.notification-badge').text()).toBe('1');
		await openNotices(app.wrapper);
		const notice = app.wrapper.get('[data-notice-id="803"]');
		expect(notice.get('a.notice__context').attributes('href')).toBe('/posts/111');
		await notice.get('a.notice__context').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/posts/111');
		expect(textOf(app.wrapper)).toContain('Group hello');
	});

	test('after removal the notice, its count and its excerpt vanish and read-all skips it; admission restores them', async () => {
		const app = await mountGroupContentApp('/feed', { backend: withLike(), viewerId: 7 });
		await openNotices(app.wrapper);
		expect(app.wrapper.find('[data-notice-id="803"]').exists()).toBe(true);
		await removeMember(app);
		expect(app.wrapper.find('[data-notice-id="803"]').exists()).toBe(false);
		expect(app.wrapper.get('.notification-badge').text()).toBe('0');
		expect(
			app.backend.request(7, 'PATCH', '/api/v1/notifications/803/read', {
				headers: { 'X-Requested-With': 'XMLHttpRequest' },
			}).status,
		).toBe(404);
		expect(app.backend.contentNotices.get(803).is_read).toBe(false);
		await actAs(app, 7, 'POST', '/groups/301/join-requests');
		await actAs(app, 42, 'PATCH', '/group-join-requests/702', { decision: 'accept' });
		expect(app.wrapper.get('.notification-badge').text()).toBe('1');
		expect(app.wrapper.find('[data-notice-id="803"]').exists()).toBe(true);
	});

	test('a notice link followed after removal reaches an unavailable discussion, not content', async () => {
		const backend = withLike();
		const app = await mountGroupContentApp('/feed', { backend, viewerId: 7 });
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.router.push('/posts/111');
		await settle();
		expect(textOf(app.wrapper)).toContain('This discussion isn’t available.');
		expect(textOf(app.wrapper)).not.toContain('Group hello');
	});

	test('no one is notified about content they could not read', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/posts/111', { backend, viewerId: 42 });
		await send(app.wrapper, 'Hello');
		expect(app.backend.contentNotices.size).toBe(1);
		await removeMember(app).catch(() => {});
		// Ada leaves; the next comment on her post produces no notice for her.
		await signal(app.sockets);
		const before = app.backend.contentNotices.size;
		app.backend.request(42, 'POST', '/api/v1/posts/111/comments', {
			json: { body: 'Again' },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		expect(app.backend.contentNotices.size).toBe(before);
	});
});
