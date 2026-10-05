// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { FixtureBackend, makeUser } from '../../../../fixtures/phase2/fixture-backend.js';
import { cleanupMounted, deferred, mountSocialApp, settle } from '../social/harness.js';

function backendWithRequests() {
	const backend = new FixtureBackend();
	backend.users.get(7).visibility = 'private';
	backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	backend.request(99, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	return backend;
}
afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});
async function open(wrapper) {
	await wrapper.get('.notification-trigger').trigger('click');
	await settle();
}
const row = (wrapper, id) => wrapper.get(`[data-notice-id="${id}"]`);

describe('global notification panel', () => {
	test('shows unread totals and name-only private requesters without protected avatar fields', async () => {
		const { wrapper } = await mountSocialApp('/', { backend: backendWithRequests(), viewerId: 42 });
		expect(wrapper.get('.notification-badge').text()).toBe('2');
		await open(wrapper);
		expect(wrapper.findAll('.notice')).toHaveLength(2);
		expect(wrapper.find('.notice img').exists()).toBe(false);
		expect(wrapper.get('#notification-heading').element).toBe(document.activeElement);
		expect(wrapper.get('#notification-panel').text()).not.toContain('person99@example.com');
	});

	test('accepts and declines through notices and preserves resolved read history', async () => {
		const backend = backendWithRequests();
		const { wrapper } = await mountSocialApp('/', { backend, viewerId: 42 });
		await open(wrapper);
		await row(wrapper, 501)
			.get('button[aria-label="Accept follow request from Ada Lovelace"]')
			.trigger('click');
		await settle();
		expect(row(wrapper, 501).text()).toContain('Request accepted');
		expect(row(wrapper, 501).find('.notice__actions').exists()).toBe(false);
		await row(wrapper, 502)
			.get('button[aria-label="Decline follow request from Robin"]')
			.trigger('click');
		await settle();
		expect(row(wrapper, 502).text()).toContain('Request declined');
		expect(wrapper.get('.notification-badge').text()).toBe('0');
		expect(backend.follows).toHaveLength(1);
		expect(backend.follows[0].state).toBe('accepted');
	});

	test('request inbox uses incoming IDs without confusing the actor’s outgoing relationship', async () => {
		const { wrapper, backend } = await mountSocialApp('/', {
			backend: backendWithRequests(),
			viewerId: 42,
		});
		await open(wrapper);
		await wrapper.get('.notification-tabs button:nth-child(2)').trigger('click');
		expect(wrapper.findAll('[data-request-id]')).toHaveLength(2);
		await wrapper.get('[data-request-id="201"] button').trigger('click');
		await settle();
		expect(wrapper.findAll('[data-request-id]')).toHaveLength(1);
		expect(backend.relation(42, 7).state).toBe('none');
		expect(backend.relation(7, 42).state).toBe('accepted');
	});

	test('an old-ID decision refetches a retry and shows stale-action feedback', async () => {
		const { wrapper, backend } = await mountSocialApp('/', {
			backend: backendWithRequests(),
			viewerId: 42,
		});
		await open(wrapper);
		backend.request(7, 'DELETE', '/api/v1/follows/201');
		backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
		await row(wrapper, 501)
			.get('button[aria-label="Accept follow request from Ada Lovelace"]')
			.trigger('click');
		await settle();
		expect(wrapper.get('#notification-panel').text()).toContain('relationship changed');
		expect(row(wrapper, 501).text()).toContain('Request cancelled');
		expect(row(wrapper, 503).findAll('.notice__actions button')).toHaveLength(2);
		expect(backend.follows.find((f) => f.id === 203).state).toBe('pending');
	});

	test('disables duplicate decisions until the write and reconciliation finish', async () => {
		const held = deferred();
		const { wrapper, fetchRef } = await mountSocialApp('/', {
			backend: backendWithRequests(),
			viewerId: 42,
			before: (call) => (call.url.includes('/follow-requests/201') ? held.promise : undefined),
		});
		await open(wrapper);
		const button = row(wrapper, 501).get(
			'button[aria-label="Accept follow request from Ada Lovelace"]',
		);
		await button.trigger('click');
		expect(button.element.disabled).toBe(true);
		await button.trigger('click');
		expect(fetchRef.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
		held.release();
		await settle();
		expect(row(wrapper, 501).text()).toContain('Request accepted');
	});

	test('individual/all read update unread totals but preserve actionable requests', async () => {
		const { wrapper } = await mountSocialApp('/', { backend: backendWithRequests(), viewerId: 42 });
		await open(wrapper);
		await row(wrapper, 501).get('.notice-read').trigger('click');
		await settle();
		expect(wrapper.get('.notification-badge').text()).toBe('1');
		expect(row(wrapper, 501).findAll('.notice__actions button')).toHaveLength(2);
		await wrapper.get('.notification-toolbar button').trigger('click');
		await settle();
		expect(wrapper.get('.notification-badge').text()).toBe('0');
		expect(wrapper.findAll('.notice-read')).toHaveLength(0);
	});

	test('is available on all authenticated routes and Escape returns focus to its trigger', async () => {
		const { wrapper, router } = await mountSocialApp('/', {
			backend: backendWithRequests(),
			viewerId: 42,
		});
		for (const path of [
			'/',
			'/people',
			'/users/42',
			'/users/42/followers',
			'/users/42/following',
		]) {
			await router.push(path);
			await settle();
			await open(wrapper);
			expect(wrapper.findAll('.notice')).toHaveLength(2);
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
			await settle();
			expect(wrapper.find('#notification-panel').exists()).toBe(false);
			expect(wrapper.get('.notification-trigger').element).toBe(document.activeElement);
		}
	});

	test('inaccessible content has no excerpt, unread badge or actionable content route', async () => {
		const backend = backendWithRequests();
		backend.posts.set(81, { id: 81, author_id: 99, status: 'published', title: 'Secret' });
		backend.notifications.push({
			id: 600,
			recipient_id: 42,
			actor: backend.entry(42, backend.user(7)),
			type: 'comment_like',
			created_at: '2026-10-02T12:00:00Z',
			is_read: false,
			target: {
				kind: 'comment',
				post_id: 81,
				comment_id: 55,
				title: 'Secret',
				excerpt: 'private excerpt',
			},
			actions: [],
		});
		const { wrapper, social } = await mountSocialApp('/', { backend, viewerId: 42 });
		await open(wrapper);
		expect(wrapper.get('#notification-panel').text()).not.toContain('private excerpt');
		expect(wrapper.get('.notification-badge').text()).toBe('2');
		backend.users.get(99).visibility = 'public';
		await social.invalidate();
		await settle();
		expect(row(wrapper, 600).text()).toContain('private excerpt');
		expect(row(wrapper, 600).find('a[href*="posts"]').exists()).toBe(false);
		backend.users.get(99).visibility = 'private';
		await social.invalidate();
		await settle();
		expect(wrapper.get('#notification-panel').text()).not.toContain('private excerpt');
	});

	test('pages notices and requests independently, then resets to page one after a decision', async () => {
		const backend = backendWithRequests();
		for (let id = 100; id < 125; id += 1) {
			backend.users.set(id, makeUser(id));
			backend.request(id, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
		}
		const { wrapper } = await mountSocialApp('/', { backend, viewerId: 42 });
		await open(wrapper);
		expect(wrapper.findAll('.notice')).toHaveLength(20);
		await wrapper.get('.pager button:last-child').trigger('click');
		await settle();
		expect(wrapper.findAll('.notice')).toHaveLength(7);
		await wrapper.get('.notification-tabs button:nth-child(2)').trigger('click');
		expect(wrapper.findAll('[data-request-id]')).toHaveLength(20);
		await wrapper.get('.pager button:last-child').trigger('click');
		await settle();
		expect(wrapper.findAll('[data-request-id]')).toHaveLength(7);
		await wrapper.get('[data-request-id] button').trigger('click');
		await settle();
		expect(wrapper.get('.pager').text()).toContain('Page 1 of 2');
	});

	test('logout removes the open panel and notices immediately', async () => {
		const { wrapper, session } = await mountSocialApp('/', {
			backend: backendWithRequests(),
			viewerId: 42,
		});
		await open(wrapper);
		session.clearAuthenticatedState();
		await settle();
		expect(wrapper.find('#notification-panel').exists()).toBe(false);
		expect(wrapper.find('.notification-trigger').exists()).toBe(false);
	});
});
