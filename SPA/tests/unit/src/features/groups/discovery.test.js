// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GroupBackend } from '../../../../fixtures/phase4/group-backend.js';
import { cleanupMounted, deferred, groupCalls, mountGroupApp, settle, textOf } from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const card = (wrapper, id) => wrapper.find(`[data-group-id="${id}"]`);

function manyGroups(count) {
	const backend = new GroupBackend();
	for (let index = 0; index < count; index += 1) {
		const id = 400 + index;
		backend.groups.set(id, {
			id,
			creator_id: 99,
			title: `Circle ${index}`,
			description: 'Extra',
			created_at: `2026-10-07T${String(10 + (index % 10)).padStart(2, '0')}:00:00Z`,
		});
		backend.memberships.set(900 + index, {
			id: 900 + index,
			group_id: id,
			user_id: 99,
			role: 'creator',
			joined_at: '2026-10-07T10:00:00Z',
		});
	}
	return backend;
}

describe('SN-A15 group discovery', () => {
	test('lists every group newest first with role-appropriate metadata and controls', async () => {
		const { wrapper } = await mountGroupApp('/groups', { viewerId: 99 });
		const cards = wrapper.findAll('[data-group-id]');
		expect(cards.map((item) => item.attributes('data-group-id'))).toEqual(['302', '301']);
		expect(textOf(wrapper)).toContain('2 groups');
		// The outsider sees public metadata only: no member count for Chess Club.
		expect(textOf(card(wrapper, 301))).toContain('Created by Alex Example');
		expect(textOf(card(wrapper, 301))).not.toContain('member');
		expect(card(wrapper, 301).text()).toContain('Request to join');
		// Robin created Book Club, so sees its count and no join control.
		expect(textOf(card(wrapper, 302))).toContain('1 member');
		expect(card(wrapper, 302).text()).toContain('You created this group');
		expect(card(wrapper, 302).find('button').exists()).toBe(false);
	});

	test('shows invitee and requester states without members-only details', async () => {
		const invitee = await mountGroupApp('/groups', { viewerId: 8 });
		const chess = card(invitee.wrapper, 301);
		expect(chess.text()).toContain('Invited');
		expect(chess.text()).toContain('Ada Lovelace invited you');
		expect(
			chess.find('[aria-label="Accept invitation to Chess Club from Ada Lovelace"]').exists(),
		).toBe(true);
		expect(textOf(chess)).not.toMatch(/\d+ members?/u);
		// The invitation also appears in the personal invitation list.
		expect(invitee.wrapper.find('[aria-label="Pending group invitations"]').exists()).toBe(true);
		cleanupMounted();
		const requester = await mountGroupApp('/groups', { viewerId: 9 });
		expect(card(requester.wrapper, 301).text()).toContain('Join request pending');
		expect(card(requester.wrapper, 301).text()).not.toContain('Request to join');
	});

	test('searches literally, filters to your groups and keeps both in the URL', async () => {
		const { wrapper, router, fetchRef } = await mountGroupApp('/groups', { viewerId: 7 });
		await wrapper.get('#group-search-input').setValue('  chess ');
		await wrapper.get('form[role="search"]').trigger('submit');
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/groups?q=chess');
		expect(wrapper.findAll('[data-group-id]')).toHaveLength(1);
		expect(textOf(wrapper)).toContain('1 group matching “chess”');
		await wrapper.get('a[href="/groups?q=chess&membership=member"]').trigger('click');
		await settle();
		expect(router.currentRoute.value.query).toEqual({ q: 'chess', membership: 'member' });
		expect(groupCalls(fetchRef).map((call) => call.url)).toContain(
			'/api/v1/groups?q=chess&membership=member',
		);
		await wrapper.get('#group-search-input').setValue('%');
		await wrapper.get('form[role="search"]').trigger('submit');
		await settle();
		expect(textOf(wrapper)).toContain('No group matches “%”');
	});

	test('recovers malformed filters, paginates and handles a list that shrank', async () => {
		const backend = manyGroups(25);
		const { wrapper, router } = await mountGroupApp('/groups?membership=owner&page=abc', {
			backend,
			viewerId: 8,
		});
		expect(router.currentRoute.value.fullPath).toBe('/groups');
		expect(textOf(wrapper)).toContain('27 groups');
		expect(textOf(wrapper)).toContain('Page 1 of 2');
		await wrapper.get('a[rel="next"]').trigger('click');
		await settle();
		expect(router.currentRoute.value.query.page).toBe('2');
		expect(wrapper.findAll('[data-group-id]')).toHaveLength(7);
		await router.push('/groups?page=9');
		await settle();
		expect(textOf(wrapper)).toContain('That page doesn’t exist.');
	});

	test('validates searches locally, maps server field errors and retries outages', async () => {
		const backend = new GroupBackend();
		const { wrapper, router } = await mountGroupApp('/groups', { backend, viewerId: 99 });
		await wrapper.get('#group-search-input').setValue('x'.repeat(101));
		await wrapper.get('form[role="search"]').trigger('submit');
		await settle();
		expect(wrapper.get('#group-search-error').text()).toContain('100 characters or fewer');
		expect(router.currentRoute.value.query.q).toBeUndefined();
		await router.push(`/groups?q=${'y'.repeat(101)}`);
		await settle();
		expect(textOf(wrapper)).toContain('Search is too long.');
		backend.faults.push({ method: 'GET', path: /\/groups$/u, repeat: true });
		await router.push('/groups');
		await settle();
		expect(textOf(wrapper)).toContain('We can’t load groups right now.');
		expect(wrapper.find('[data-group-id]').exists()).toBe(false);
		backend.faults.length = 0;
		const retry = wrapper.findAll('button').find((item) => item.text() === 'Try again');
		await retry.trigger('click');
		await settle();
		expect(wrapper.findAll('[data-group-id]')).toHaveLength(2);
	});

	test('a slow earlier search can never repaint over a newer one', async () => {
		const hold = deferred();
		let first = true;
		const { wrapper, router } = await mountGroupApp('/groups', {
			viewerId: 99,
			before: async (call) => {
				if (call.url.includes('q=book') && first) {
					first = false;
					await hold.promise;
				}
			},
		});
		await router.push('/groups?q=book');
		await settle();
		await router.push('/groups?q=chess');
		await settle();
		hold.release();
		await settle();
		expect(wrapper.findAll('[data-group-id]').map((item) => item.text())).toHaveLength(1);
		expect(textOf(wrapper)).toContain('Chess Club');
		expect(textOf(wrapper)).not.toContain('Book Club');
	});

	test('the Groups link is in the authenticated shell', async () => {
		const { wrapper } = await mountGroupApp('/groups', { viewerId: 7 });
		expect(wrapper.get('.site-nav a.router-link-active').text()).toBe('Groups');
	});
});

describe('SN-A15 group creation', () => {
	async function openForm(options) {
		const app = await mountGroupApp('/groups/new', options);
		return app;
	}

	test('mirrors title and description rules before sending anything', async () => {
		const { wrapper, fetchRef } = await openForm({ viewerId: 8 });
		await wrapper.get('form.group-form').trigger('submit');
		await settle();
		expect(wrapper.get('#group-title-error').text()).toBe('Give the group a name.');
		expect(wrapper.get('#group-description-error').text()).toBe('Describe what the group is for.');
		expect(document.activeElement?.id).toBe('group-title');
		await wrapper.get('#group-title').setValue('bell\u0007');
		await wrapper.get('#group-description').setValue('d'.repeat(1001));
		await wrapper.get('form.group-form').trigger('submit');
		await settle();
		expect(wrapper.get('#group-title-error').text()).toContain('control characters');
		expect(wrapper.get('#group-description-error').text()).toContain('1,000 characters');
		await wrapper.get('#group-title').setValue('x'.repeat(101));
		await wrapper.get('form.group-form').trigger('submit');
		await settle();
		expect(wrapper.get('#group-title-error').text()).toContain('100 characters');
		expect(groupCalls(fetchRef, { method: 'POST' })).toHaveLength(0);
	});

	test('creates once, normalizes text and opens the new group as its creator', async () => {
		const hold = deferred();
		const { wrapper, router, fetchRef, backend } = await openForm({
			viewerId: 8,
			before: async (call) => {
				if (call.method === 'POST') await hold.promise;
			},
		});
		await wrapper.get('#group-title').setValue('  Go Club ');
		await wrapper.get('#group-description').setValue('line one\r\nline two\tend');
		await wrapper.get('form.group-form').trigger('submit');
		await wrapper.get('form.group-form').trigger('submit');
		await settle();
		expect(wrapper.get('button[type="submit"]').text()).toBe('Creating…');
		hold.release();
		await settle();
		expect(groupCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(groupCalls(fetchRef, { method: 'POST' })[0].json).toEqual({
			title: 'Go Club',
			description: 'line one\nline two\tend',
		});
		expect(router.currentRoute.value.fullPath).toBe('/groups/303');
		expect(textOf(wrapper)).toContain('Go Club is ready.');
		expect(textOf(wrapper)).toContain('1 member');
		expect(textOf(wrapper)).toContain('As the creator you stay a member');
		expect(wrapper.find('a[href="/groups/303/requests"]').exists()).toBe(true);
		expect(backend.groups.get(303).creator_id).toBe(8);
	});

	test('a lost creation response is never replayed and points to Your groups', async () => {
		const backend = new GroupBackend();
		backend.faults.push({ method: 'POST', path: /\/groups$/u, commit: true });
		const { wrapper, router, fetchRef } = await openForm({ backend, viewerId: 8 });
		await wrapper.get('#group-title').setValue('Go Club');
		await wrapper.get('#group-description').setValue('Gophers');
		await wrapper.get('form.group-form').trigger('submit');
		await settle();
		expect(groupCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(textOf(wrapper)).toContain('couldn’t confirm whether the group was created');
		expect(router.currentRoute.value.name).toBe('group-new');
		// The draft stays so nothing typed is lost, and the committed group is
		// found where the message points.
		expect(wrapper.get('#group-title').element.value).toBe('Go Club');
		await wrapper.get('a[href="/groups?membership=member"]').trigger('click');
		await settle();
		expect(wrapper.find('[data-group-id="303"]').exists()).toBe(true);
	});

	test('maps server field errors and keeps the form recoverable', async () => {
		const backend = new GroupBackend();
		const original = backend.request.bind(backend);
		backend.request = (viewer, method, url, payload) =>
			method === 'POST' && url.endsWith('/groups')
				? {
						status: 400,
						headers: {},
						body: {
							error: {
								code: 'VALIDATION_ERROR',
								message: 'x',
								fields: { description: 'INVALID_TEXT' },
							},
						},
					}
				: original(viewer, method, url, payload);
		const { wrapper } = await openForm({ backend, viewerId: 8 });
		await wrapper.get('#group-title').setValue('Go Club');
		await wrapper.get('#group-description').setValue('Gophers');
		await wrapper.get('form.group-form').trigger('submit');
		await settle();
		expect(wrapper.get('#group-description-error').text()).toContain('control characters');
		expect(document.activeElement?.id).toBe('group-description');
		expect(wrapper.get('button[type="submit"]').text()).toBe('Create group');
	});

	test('another account never inherits an unsent draft', async () => {
		const { wrapper, session, current } = await openForm({ viewerId: 8 });
		await wrapper.get('#group-title').setValue('Secret plans');
		current.viewerId = 99;
		await session.restore({ force: true });
		await settle();
		expect(wrapper.get('#group-title').element.value).toBe('');
	});
});
