// @vitest-environment jsdom
// SN-A16: publishing, drafts, editing and attachments for group content,
// reusing the Phase 3 composer and editor. Membership replaces the personal
// audience, and every author mutation also needs current membership.
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

const button = (wrapper, label) =>
	wrapper.findAll('button').find((node) => node.text().trim() === label);
const postIds = (wrapper) =>
	wrapper
		.findAll('.post-list [data-post-id]')
		.map((card) => Number(card.attributes('data-post-id')));
const feedAs = (backend, viewerId, path = '/api/v1/posts?group_id=301') =>
	backend.request(viewerId, 'GET', path, {}).body.data.map((post) => post.id);

describe('SN-A16 group composer', () => {
	test('shows membership instead of an audience picker and reads no followers or profile', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		const form = app.wrapper.get('form.post-form');
		expect(app.wrapper.get('[data-screen="compose"]').attributes('data-scope')).toBe('group');
		expect(textOf(app.wrapper)).toContain('Share with Chess Club.');
		expect(app.wrapper.find('.audience-options').exists()).toBe(false);
		expect(app.wrapper.find('input[type="radio"]').exists()).toBe(false);
		expect(textOf(form)).toContain('Members of Chess Club');
		expect(textOf(form)).toContain('however your profile is set');
		expect(
			app.fetchRef.calls.filter((call) => /\/(followers|profile)/u.test(call.url)),
		).toHaveLength(0);
	});

	test('publishes with group_id and no audience, then lands on the group’s posts', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('#compose-body').setValue('  Hi everyone\r\n');
		await app.wrapper.get('#compose-title').setValue('Tournament');
		await app.wrapper.get('input[name="category_ids"]').setValue(true);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const [write] = contentWrites(app.fetchRef);
		expect(write.url).toBe('/api/v1/posts');
		expect(write.json).toEqual({
			body: 'Hi everyone',
			title: 'Tournament',
			category_ids: [1],
			group_id: 301,
		});
		expect(app.backend.posts.get(122)).toMatchObject({
			author_id: 7,
			group_id: 301,
			audience: 'group',
			status: 'published',
		});
		expect(app.router.currentRoute.value.name).toBe('group-posts');
		expect(textOf(app.wrapper)).toContain('Your post is published to Chess Club.');
		expect(app.wrapper.find('[data-post-id="122"] .badge--group').exists()).toBe(true);
		expect(feedAs(app.backend, 42)).toContain(122);
		// No audience-based access came with it: a follower who isn't a member sees nothing.
		expect(feedAs(app.backend, 10, '/api/v1/posts')).not.toContain(122);
	});

	test('the creator posts the same way, and an image-only post uploads as multipart', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 42 });
		await chooseFile(app.wrapper.get('#compose-image'), pngFile());
		expect(app.wrapper.get('.composer__preview img').attributes('src')).toMatch(/^blob:preview/u);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const [write] = contentWrites(app.fetchRef);
		expect(write.json).toBeUndefined();
		expect(write.form.fields).toEqual({ body: [''], group_id: ['301'] });
		expect(write.form.image.type).toBe('image/png');
		expect(app.backend.posts.get(122)).toMatchObject({
			author_id: 42,
			group_id: 301,
			image_url: '/api/v1/media/416',
		});
		expect(app.backend.request(7, 'GET', '/api/v1/media/416').status).toBe(200);
		expect(app.backend.request(99, 'GET', '/api/v1/media/416').status).toBe(404);
	});

	test.each([
		['photo.jpg', 'image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
		['photo.gif', 'image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
	])('a %s attachment is accepted for a group post and stays members-only', async (name, type, bytes) => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		const file = new File([new Uint8Array([...bytes, 0, 0, 0, 0])], name, { type });
		await chooseFile(app.wrapper.get('#compose-image'), file);
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const [write] = contentWrites(app.fetchRef);
		expect(write.form.image.type).toBe(type);
		expect(write.form.fields.group_id).toEqual(['301']);
		const created = app.backend.posts.get(122);
		expect(created.group_id).toBe(301);
		expect(app.backend.request(42, 'GET', created.image_url).status).toBe(200);
		expect(app.backend.request(10, 'GET', created.image_url).status).toBe(404);
	});

	test('an unsupported or oversized image is refused before upload, with the text kept', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('#compose-body').setValue('Keep me');
		await chooseFile(
			app.wrapper.get('#compose-image'),
			new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
		);
		expect(textOf(app.wrapper)).toContain('Choose a JPEG, PNG or GIF image.');
		await chooseFile(
			app.wrapper.get('#compose-image'),
			new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
		);
		expect(textOf(app.wrapper)).toContain('Images can be up to 10 MiB.');
		expect(app.wrapper.get('#compose-body').element.value).toBe('Keep me');
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
	});

	test('publishing nothing is refused locally before any request', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).toContain('Write something or add an image before publishing.');
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
	});

	test('a non-member, an invitee and a departed member get no composer and send nothing', async () => {
		for (const viewerId of [99, 8, 9, 12, 10]) {
			const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId });
			expect(textOf(app.wrapper), `viewer ${viewerId}`).toContain('Only members can post here.');
			expect(app.wrapper.find('form.post-form').exists()).toBe(false);
			expect(contentCalls(app.fetchRef)).toHaveLength(0);
			cleanupMounted();
		}
		const missing = await mountGroupContentApp('/groups/999/posts/new', { viewerId: 7 });
		expect(textOf(missing.wrapper)).toContain('This group isn’t available.');
	});

	test('losing membership while writing closes the composer by signal and posts nothing', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('#compose-body').setValue('Almost done');
		await removeMember(app);
		expect(app.wrapper.find('form.post-form').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can post here.');
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
		expect(app.backend.posts.has(122)).toBe(false);
	});

	test('signals, focus and reconnects never wipe what a member is writing', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('#compose-title').setValue('Draft title');
		await app.wrapper.get('#compose-body').setValue('Unsent words');
		// Someone else publishes elsewhere; every authenticated socket is told.
		await actAs(app, 42, 'POST', '/posts', { body: 'Elsewhere', group_id: 301 });
		window.dispatchEvent(new Event('focus'));
		app.sockets.at(-1).onopen?.();
		await settle();
		expect(app.wrapper.get('#compose-title').element.value).toBe('Draft title');
		expect(app.wrapper.get('#compose-body').element.value).toBe('Unsent words');
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
	});

	test('a brief outage keeps the composer with a notice; the group still decides the write', async () => {
		const backend = new GroupContentBackend();
		let down = false;
		const app = await mountGroupContentApp('/groups/301/posts/new', {
			backend,
			viewerId: 7,
			before: async (entry) => {
				if (down && entry.method === 'GET' && entry.url === '/api/v1/groups/301')
					throw new TypeError('offline');
			},
		});
		await app.wrapper.get('#compose-body').setValue('Unsent words');
		down = true;
		await signal(app.sockets);
		expect(app.wrapper.get('[data-state="offline"]').text()).toContain('can’t re-check');
		expect(app.wrapper.get('#compose-body').element.value).toBe('Unsent words');
		down = false;
		await signal(app.sockets);
		expect(app.wrapper.find('[data-state="offline"]').exists()).toBe(false);
		expect(app.wrapper.get('#compose-body').element.value).toBe('Unsent words');
	});

	test('a composer opened without ever confirming membership stays closed during an outage', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', {
			viewerId: 7,
			before: async (entry) => {
				if (entry.url === '/api/v1/groups/301') throw new TypeError('offline');
			},
		});
		expect(textOf(app.wrapper)).toContain('We can’t confirm your membership right now.');
		expect(app.wrapper.find('form.post-form').exists()).toBe(false);
	});

	test('switching accounts starts the composer over and keeps the previous author’s text out', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('#compose-body').setValue('Ada’s private words');
		await switchAccount(app, 99);
		expect(textOf(app.wrapper)).toContain('Only members can post here.');
		await switchAccount(app, 42);
		expect(app.wrapper.get('#compose-body').element.value).toBe('');
	});

	test('removal that the page has not heard about yet: the write is refused, explained and keeps the text', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/groups/301/posts/new', { backend, viewerId: 7 });
		await app.wrapper.get('#compose-body').setValue('Almost done');
		// Removed without a signal reaching this page.
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(contentWrites(app.fetchRef)).toHaveLength(1);
		expect(backend.posts.has(122)).toBe(false);
		// The follow-up membership read closes the composer: nothing was posted.
		expect(textOf(app.wrapper)).toContain('Only members can post here.');
		expect(textOf(app.wrapper)).toContain('nothing was posted if you were removed');
		expect(textOf(app.wrapper)).not.toContain('Your post is published');
	});

	test('a lost response is never replayed: the author is told it may have been saved', async () => {
		let drop = true;
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/groups/301/posts/new', {
			backend,
			viewerId: 7,
			after: async (entry) => {
				if (drop && entry.method === 'POST' && entry.url === '/api/v1/posts')
					throw new TypeError('connection lost');
			},
		});
		await app.wrapper.get('#compose-body').setValue('Maybe saved');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		drop = false;
		expect(app.wrapper.get('[data-recovery-state="unknown"]').text()).toContain(
			'couldn’t confirm whether this was saved',
		);
		expect(contentWrites(app.fetchRef)).toHaveLength(1);
		expect(app.wrapper.get('#compose-body').element.value).toBe('Maybe saved');
		expect(backend.posts.has(122)).toBe(true);
	});

	test('a group draft is found only in its group, and a personal draft never leaks into it', async () => {
		const group = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		expect(group.wrapper.get('[data-latest-draft]').text()).toContain('saved draft in Chess Club');
		expect(contentCalls(group.fetchRef, { path: /posts\/draft\?group_id=301/u })).toHaveLength(1);
		expect(group.wrapper.get('[data-latest-draft] a').attributes('href')).toBe('/posts/113/edit');
		cleanupMounted();
		const personal = await mountGroupContentApp('/posts/new', { viewerId: 7 });
		expect(personal.wrapper.find('[data-latest-draft]').exists()).toBe(false);
		expect(personal.wrapper.get('[data-screen="compose"]').attributes('data-scope')).toBe(
			'personal',
		);
		expect(personal.wrapper.find('.audience-options').exists()).toBe(true);
		expect(
			contentCalls(personal.fetchRef, { path: /posts\/draft/u }).map((call) => call.url),
		).toEqual(['/api/v1/posts/draft']);
	});

	test('personal composing is unchanged beside it: audience picker, audience in the request, no group', async () => {
		const app = await mountGroupContentApp('/posts/new', { viewerId: 7 });
		await app.wrapper.get('[data-audience="followers"] input').setValue(true);
		await app.wrapper.get('#compose-body').setValue('For followers');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(contentWrites(app.fetchRef)[0].json).toEqual({
			body: 'For followers',
			audience: 'followers',
		});
		expect(app.backend.posts.get(122)).toMatchObject({ group_id: null, audience: 'followers' });
	});
});

describe('SN-A16 group drafts', () => {
	test('saving a draft sends the group, hides it from others, and publishing makes it visible to members', async () => {
		const app = await mountGroupContentApp('/groups/301/posts/new', { viewerId: 7 });
		await app.wrapper.get('#compose-body').setValue('Work in progress');
		await button(app.wrapper, 'Save as draft').trigger('click');
		await settle();
		const [write] = contentWrites(app.fetchRef);
		expect(write.url).toBe('/api/v1/posts/draft');
		expect(write.json).toEqual({ body: 'Work in progress', group_id: 301 });
		expect(app.router.currentRoute.value.fullPath).toBe('/posts/122/edit');
		expect(textOf(app.wrapper)).toContain(
			'Only you can see it until you publish it to Chess Club.',
		);
		expect(app.wrapper.get('.edit-view__meta .badge--group').text()).toBe('Group · Chess Club');
		expect(app.wrapper.find('.audience-options').exists()).toBe(false);
		// Another member, the creator and a follower all get nothing for the draft.
		expect(feedAs(app.backend, 42)).not.toContain(122);
		expect(app.backend.request(42, 'GET', '/api/v1/posts/122').status).toBe(404);
		expect(app.backend.request(10, 'GET', '/api/v1/posts/122').status).toBe(404);
		await button(app.wrapper, 'Publish').trigger('click');
		await settle();
		const publish = contentWrites(app.fetchRef).at(-1);
		expect(publish.json).toEqual({ expected_version: 1, status: 'published' });
		expect(app.backend.posts.get(122).status).toBe('published');
		expect(feedAs(app.backend, 42)).toContain(122);
	});

	test('a saved draft keeps editing in place without group or audience fields', async () => {
		const app = await mountGroupContentApp('/posts/113/edit', { viewerId: 7 });
		expect(app.wrapper.get('#edit-body').element.value).toBe('Draft idea');
		expect(textOf(app.wrapper)).toContain(
			'Only you can see this draft until you publish it to Chess Club.',
		);
		await app.wrapper.get('#edit-body').setValue('Draft idea, refined');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const save = contentWrites(app.fetchRef)[0];
		expect(save.method).toBe('PUT');
		expect(save.url).toBe('/api/v1/posts/draft/113');
		expect(save.json).toEqual({ expected_version: 1, body: 'Draft idea, refined' });
		expect(app.backend.posts.get(113)).toMatchObject({ body: 'Draft idea, refined', version: 2 });
		expect(textOf(app.wrapper)).toContain('Draft saved.');
	});

	test('a draft is deleted through the draft route; other members never see or reach it', async () => {
		const app = await mountGroupContentApp('/posts/113/edit', { viewerId: 7 });
		expect(app.backend.request(42, 'GET', '/api/v1/posts/113').status).toBe(404);
		await button(app.wrapper, 'Delete draft').trigger('click');
		await button(app.wrapper, 'Delete permanently').trigger('click');
		await settle();
		const [write] = contentWrites(app.fetchRef);
		expect(write.method).toBe('DELETE');
		expect(write.url).toBe('/api/v1/posts/draft/113?expected_version=1');
		expect(app.backend.posts.has(113)).toBe(false);
		expect(app.router.currentRoute.value.name).toBe('my-posts');
	});

	test('another member’s draft is not editable even by the group’s creator', async () => {
		const app = await mountGroupContentApp('/posts/113/edit', { viewerId: 42 });
		expect(app.wrapper.find('form.post-form').exists()).toBe(false);
		expect(app.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(textOf(app.wrapper)).not.toContain('Draft idea');
	});
});

describe('SN-A16 editing group posts', () => {
	test('the author edits text, categories and the attachment; only changed fields are sent', async () => {
		const app = await mountGroupContentApp('/posts/111/edit', { viewerId: 7 });
		expect(app.wrapper.get('.edit-view__meta .badge--group').text()).toBe('Group · Chess Club');
		expect(textOf(app.wrapper)).toContain('Changes appear to the members of Chess Club');
		expect(app.wrapper.find('.audience-options').exists()).toBe(false);
		await app.wrapper.get('#edit-body').setValue('Edited hello');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const [save] = contentWrites(app.fetchRef);
		expect(save.method).toBe('PATCH');
		expect(save.json).toEqual({ expected_version: 1, body: 'Edited hello' });
		expect(app.backend.posts.get(111)).toMatchObject({
			body: 'Edited hello',
			version: 2,
			group_id: 301,
		});
		expect(textOf(app.wrapper)).toContain('Changes saved.');

		await chooseFile(app.wrapper.get('#edit-image'), pngFile('new.png'));
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const replace = contentWrites(app.fetchRef).at(-1);
		expect(replace.form.fields).toEqual({ expected_version: ['2'] });
		expect(replace.form.image.type).toBe('image/png');
		const replaced = app.backend.posts.get(111).image_url;
		expect(replaced).not.toBe('/api/v1/media/411');
		// The old attachment is gone for members and nonmembers alike.
		expect(app.backend.request(42, 'GET', '/api/v1/media/411').status).toBe(404);
		expect(app.backend.request(42, 'GET', replaced).status).toBe(200);
		expect(app.backend.request(99, 'GET', replaced).status).toBe(404);

		await button(app.wrapper, 'Remove image').trigger('click');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const removal = contentWrites(app.fetchRef).at(-1);
		expect(removal.json).toEqual({ expected_version: 3, remove_image: true });
		expect(app.backend.posts.get(111).image_url).toBeNull();
		expect(app.backend.posts.get(111).body).toBe('Edited hello');
	});

	test('move to drafts hides the post from members and the discussion; publishing again restores it', async () => {
		const app = await mountGroupContentApp('/posts/111/edit', { viewerId: 7 });
		await button(app.wrapper, 'Move to drafts').trigger('click');
		await settle();
		expect(contentWrites(app.fetchRef)[0].json).toEqual({ expected_version: 1, status: 'draft' });
		expect(feedAs(app.backend, 42)).toEqual([112]);
		expect(app.backend.request(42, 'GET', '/api/v1/posts/111').status).toBe(404);
		// Comments and reactions are retained for the republished post.
		expect(app.backend.comments.has(211)).toBe(true);
		await button(app.wrapper, 'Publish').trigger('click');
		await settle();
		expect(feedAs(app.backend, 42)).toEqual([111, 112]);
		expect(app.backend.comments.has(211)).toBe(true);
	});

	test('deleting a published group post asks first, removes it for the group and returns to your posts', async () => {
		const app = await mountGroupContentApp('/posts/111/edit', { viewerId: 7 });
		await button(app.wrapper, 'Delete post').trigger('click');
		expect(textOf(app.wrapper)).toContain('Delete this post?');
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
		await button(app.wrapper, 'Delete permanently').trigger('click');
		await settle();
		expect(contentWrites(app.fetchRef)[0].url).toBe('/api/v1/posts/111?expected_version=1');
		expect(app.backend.posts.has(111)).toBe(false);
		expect(feedAs(app.backend, 42)).toEqual([112]);
		expect(app.router.currentRoute.value.name).toBe('my-posts');
	});

	test('the group creator gets no edit controls over a member’s post, and the editor refuses it', async () => {
		const feed = await mountGroupContentApp('/groups/301/posts', { viewerId: 42 });
		expect(feed.wrapper.find('[data-post-id="111"] .post-card__edit').exists()).toBe(false);
		expect(feed.wrapper.find('[data-post-id="112"] .post-card__edit').exists()).toBe(false);
		cleanupMounted();
		const direct = await mountGroupContentApp('/posts/111/edit', { viewerId: 42 });
		expect(direct.wrapper.find('[data-state="foreign"]').exists()).toBe(true);
		expect(textOf(direct.wrapper)).toContain('even for the group’s creator');
		expect(direct.wrapper.find('form.post-form').exists()).toBe(false);
		expect(contentWrites(direct.fetchRef)).toHaveLength(0);
		// And the server agrees if the page is bypassed.
		expect(
			direct.backend.request(42, 'PATCH', '/api/v1/posts/111', {
				json: { expected_version: 1, body: 'x' },
				headers: { 'X-Requested-With': 'XMLHttpRequest' },
			}).status,
		).toBe(404);
	});

	test('a departed author has no way back into their own post, draft or editor', async () => {
		const app = await mountGroupContentApp('/posts/112/edit', { viewerId: 11 });
		expect(app.wrapper.find('form.post-form').exists()).toBe(false);
		expect(app.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(textOf(app.wrapper)).not.toContain('retained post');
		cleanupMounted();
		const draft = await mountGroupContentApp('/posts/114/edit', { viewerId: 11 });
		expect(draft.wrapper.find('form.post-form').exists()).toBe(false);
		expect(textOf(draft.wrapper)).not.toContain('Kim draft');
	});

	test('removal while editing closes saving, keeps the unsaved text readable and sends nothing', async () => {
		const app = await mountGroupContentApp('/posts/111/edit', { viewerId: 7 });
		await app.wrapper.get('#edit-body').setValue('Unsaved thoughts');
		await removeMember(app);
		expect(app.wrapper.find('[data-state="gone"]').exists()).toBe(true);
		expect(textOf(app.wrapper)).toContain('You can no longer open this group post.');
		expect(textOf(app.wrapper)).toContain('removed from Chess Club');
		expect(app.wrapper.get('#edit-body').element.value).toBe('Unsaved thoughts');
		expect(app.wrapper.find('.post-form__actions').exists()).toBe(false);
		expect(app.wrapper.get('fieldset.post-form__fields').attributes('disabled')).toBeDefined();
		expect(contentWrites(app.fetchRef)).toHaveLength(0);
		expect(app.backend.posts.get(111).body).toBe('Group hello');
	});

	test('a save refused after a silent removal never claims success', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/posts/111/edit', { backend, viewerId: 7 });
		await app.wrapper.get('#edit-body').setValue('Unsaved thoughts');
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(textOf(app.wrapper)).not.toContain('Changes saved.');
		expect(app.wrapper.find('[data-state="gone"]').exists()).toBe(true);
		expect(backend.posts.get(111).body).toBe('Group hello');
		expect(backend.posts.get(111).version).toBe(1);
	});

	test('a change elsewhere is reconciled without group recipients and keeps unsaved edits', async () => {
		const backend = new GroupContentBackend();
		const app = await mountGroupContentApp('/posts/111/edit', { backend, viewerId: 7 });
		await app.wrapper.get('#edit-body').setValue('My edit');
		backend.request(7, 'PATCH', '/api/v1/posts/111', {
			json: { expected_version: 1, title: 'Renamed elsewhere' },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		const alert = app.wrapper.get('[data-recovery-state="stale"]');
		expect(alert.text()).toContain('changed somewhere else');
		expect(alert.text()).not.toContain('recipients');
		expect(app.wrapper.get('#edit-body').element.value).toBe('My edit');
		expect(app.wrapper.get('#edit-title').element.value).toBe('Renamed elsewhere');
		await app.wrapper.get('form.post-form').trigger('submit');
		await settle();
		expect(app.backend.posts.get(111)).toMatchObject({
			body: 'My edit',
			title: 'Renamed elsewhere',
		});
	});

	test('rejoining after removal restores authoring without reviving anything obsolete', async () => {
		const app = await mountGroupContentApp('/posts/111/edit', { viewerId: 7 });
		await removeMember(app);
		expect(app.wrapper.find('[data-state="gone"]').exists()).toBe(true);
		app.backend.request(7, 'POST', '/api/v1/groups/301/join-requests', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		app.backend.request(42, 'PATCH', '/api/v1/group-join-requests/702', {
			json: { decision: 'accept' },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await app.router.push('/groups/301');
		await settle();
		expect(textOf(app.wrapper)).toContain('Leave group');
		// Ada's earlier invitation to Sam was cancelled by her departure and stays gone.
		expect(app.backend.invitations.has(601)).toBe(false);
		await app.router.push('/posts/111/edit');
		await settle();
		expect(app.wrapper.find('form.post-form').exists()).toBe(true);
		expect(postIds(app.wrapper)).toEqual([]);
	});
});
