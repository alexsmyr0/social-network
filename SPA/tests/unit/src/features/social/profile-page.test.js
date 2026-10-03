// @vitest-environment jsdom

import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
	contractUsers,
	FixtureBackend,
	makeUser,
} from '../../../../fixtures/phase2/fixture-backend.js';
import {
	cleanupMounted,
	deferred,
	mountSocialApp,
	settle,
	socialCalls,
	textOf,
} from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const accepted = (id, follower, followed) => ({
	id,
	follower_id: follower,
	followed_id: followed,
	state: 'accepted',
	created_at: '2026-10-02T12:00:00Z',
	accepted_at: '2026-10-02T12:00:00Z',
});
const pending = (id, follower, followed) => ({
	...accepted(id, follower, followed),
	state: 'pending',
	accepted_at: null,
});
const profileCalls = (fetchRef) =>
	socialCalls(fetchRef).filter((call) => call.url.includes('/profile'));

describe('full profiles', () => {
	test('the owner of a private profile sees everything, controls and counts', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const { wrapper } = await mountSocialApp('/users/42', { backend, viewerId: 42 });

		expect(wrapper.get('h1').text()).toBe('Alex Example');
		expect(textOf(wrapper)).toContain('Your profile');
		expect(wrapper.get('[data-visibility] .badge').text()).toBe('Private profile');
		const details = textOf(wrapper.get('.profile-details'));
		expect(details).toContain('alex@example.com');
		expect(details).toContain('14 March 1998');
		expect(details).toContain('Alex Example');
		expect(wrapper.get('.avatar img').attributes('src')).toBe('/api/v1/users/42/avatar');
		expect(wrapper.get('.profile-counts').text()).toContain('1 follower');
		expect(wrapper.get('.profile-counts').text()).toContain('0 following');
		expect(wrapper.find('.privacy-control').exists()).toBe(true);
		expect(wrapper.find('.follow-control').exists()).toBe(false);
		expect(document.title).toBe('Profile · Commonplace');
	});

	test('anyone signed in sees a public profile with a follow control and no owner tools', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/users/7', { backend, viewerId: 99 });
		expect(wrapper.get('h1').text()).toBe('Ada Lovelace');
		expect(wrapper.get('[data-visibility] .badge').text()).toBe('Public profile');
		expect(textOf(wrapper.get('.profile-details'))).toContain('ada@example.com');
		expect(wrapper.find('.privacy-control').exists()).toBe(false);
		expect(wrapper.get('.follow-control button').text()).toBe('Follow');
		expect(wrapper.get('.avatar').text()).toBe('AL');
		expect(wrapper.find('.avatar img').exists()).toBe(false);
	});

	test('shows nickname, plain-text about-me with its line breaks, and skips absent fields', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/users/99', { backend, viewerId: 99 });
		const rows = wrapper.findAll('.profile-details dt').map((dt) => dt.text());
		expect(rows).toEqual(['Name', 'Nickname', 'Email', 'Date of birth', 'About']);
		expect(wrapper.get('h1').text()).toBe('Robin');
		expect(wrapper.get('.profile-details__text').element.textContent).toBe(
			'Plain text\nSecond line',
		);

		const bare = await mountSocialApp('/users/7', { backend, viewerId: 7 });
		expect(bare.wrapper.findAll('.profile-details dt').map((dt) => dt.text())).toEqual([
			'Name',
			'Email',
			'Date of birth',
		]);
	});

	test('about-me is rendered as text, never as markup', async () => {
		const backend = new FixtureBackend({
			users: [
				...contractUsers(),
				makeUser(8, { about_me: '<img src=x onerror=alert(1)><b>hi</b>' }),
			],
		});
		const { wrapper } = await mountSocialApp('/users/8', { backend, viewerId: 7 });
		expect(wrapper.find('.profile-details img').exists()).toBe(false);
		expect(wrapper.find('.profile-details b').exists()).toBe(false);
		expect(wrapper.get('.profile-details__text').element.textContent).toContain('<b>hi</b>');
	});

	test('an accepted follower of a private profile sees full details and can unfollow', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const { wrapper } = await mountSocialApp('/users/42', { backend });
		expect(textOf(wrapper)).toContain('alex@example.com');
		expect(textOf(wrapper)).toContain('Following');
		expect(wrapper.find('.privacy-control').exists()).toBe(false);

		await wrapper.get('.follow-control button').trigger('click');
		await settle();
		// Access is gone with the relationship, and no detail lingers.
		expect(backend.follows).toEqual([]);
		expect(wrapper.find('[data-state="teaser"]').exists()).toBe(true);
		expect(textOf(wrapper)).not.toContain('alex@example.com');
		expect(textOf(wrapper)).not.toContain('1998');
		expect(wrapper.find('.avatar img').exists()).toBe(false);
		expect(wrapper.find('.profile-counts').exists()).toBe(false);
	});

	test.each([
		'ok',
		'lost-response',
	])('unfollow %s clears private data before a delayed refetch', async (outcome) => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const gate = deferred();
		let hold = false;
		const { wrapper } = await mountSocialApp('/users/42', {
			backend,
			before: (request) => {
				if (hold && request.url.endsWith('/profile')) return gate.promise;
				if (outcome === 'lost-response' && request.method === 'DELETE') {
					backend.request(7, 'DELETE', request.url);
					throw new TypeError('response lost after commit');
				}
			},
		});
		expect(wrapper.find('.profile-details').exists()).toBe(true);
		hold = true;
		await wrapper.get('.follow-control button').trigger('click');
		await settle();
		try {
			expect(backend.follows).toEqual([]);
			expect(textOf(wrapper)).not.toContain('alex@example.com');
			expect(wrapper.find('.avatar img').exists()).toBe(false);
			expect(wrapper.find('.profile-counts').exists()).toBe(false);
		} finally {
			gate.release();
			await settle();
		}
		expect(wrapper.find('[data-state="teaser"]').exists()).toBe(true);
	});

	test('falls back to initials when an avatar can no longer be loaded', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const { wrapper } = await mountSocialApp('/users/42', { backend });
		await wrapper.get('.avatar img').trigger('error');
		expect(wrapper.find('.avatar img').exists()).toBe(false);
		expect(wrapper.get('.avatar').text()).toBe('AE');
	});
});

describe('name-only teasers', () => {
	test('a private profile reveals only the name and the follow control', async () => {
		const backend = new FixtureBackend();
		const { wrapper, fetchRef } = await mountSocialApp('/users/42', { backend });

		expect(wrapper.get('h1').text()).toBe('Alex Example');
		expect(wrapper.get('[data-state="teaser"]').text()).toContain('Only their name is public.');
		const text = textOf(wrapper);
		for (const hidden of [
			'alex@example.com',
			'1998',
			'follower',
			'following',
			'About',
			'Date of birth',
		]) {
			expect(text).not.toContain(hidden);
		}
		expect(wrapper.find('img').exists()).toBe(false);
		expect(wrapper.html()).not.toContain('/avatar');
		expect(wrapper.find('.profile-counts').exists()).toBe(false);
		expect(wrapper.find('.profile-details').exists()).toBe(false);
		expect(wrapper.find('a[href$="/followers"]').exists()).toBe(false);
		expect(wrapper.get('.follow-control button').text()).toBe('Follow');
		expect(profileCalls(fetchRef)).toHaveLength(1);
	});

	test('does not render protected fields even if a response leaks them', async () => {
		const backend = new FixtureBackend();
		const original = backend.profile.bind(backend);
		backend.profile = (viewerId, subject) => ({
			...original(viewerId, subject),
			avatar_url: '/api/v1/users/42/avatar',
			followers_count: 99,
			profile: { email: 'alex@example.com', visibility: 'private', followers_count: 99 },
		});
		const { wrapper } = await mountSocialApp('/users/42', { backend });
		expect(textOf(wrapper)).not.toContain('alex@example.com');
		expect(textOf(wrapper)).not.toContain('99');
		expect(wrapper.find('img').exists()).toBe(false);
	});

	test('a pending requester sees their request is waiting and can cancel it', async () => {
		const backend = new FixtureBackend({ follows: [pending(201, 7, 42)] });
		const { wrapper } = await mountSocialApp('/users/42', { backend });
		expect(textOf(wrapper.get('[data-state="teaser"]'))).toContain('waiting for their answer');
		expect(textOf(wrapper.get('.follow-control'))).toContain('Request pending');
		expect(wrapper.find('.avatar img').exists()).toBe(false);

		await wrapper.get('.follow-control button').trigger('click');
		await settle();
		expect(backend.follows).toEqual([]);
		expect(textOf(wrapper.get('[data-state="teaser"]'))).toContain('Follow to ask for access');
	});

	test('requesting access shows pending, then full details once the owner accepts', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/users/42', { backend });
		await wrapper.get('.follow-control button').trigger('click');
		await settle();
		expect(textOf(wrapper)).toContain('Request pending');
		expect(textOf(wrapper)).not.toContain('alex@example.com');

		backend.request(42, 'PATCH', '/api/v1/follow-requests/201', { json: { decision: 'accept' } });
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(textOf(wrapper)).toContain('alex@example.com');
		expect(wrapper.find('[data-state="teaser"]').exists()).toBe(false);
	});

	test('revocation elsewhere removes protected details without waiting for a reload', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const gate = deferred();
		let hold = false;
		const { wrapper } = await mountSocialApp('/users/42', {
			backend,
			before: () => (hold ? gate.promise : undefined),
		});
		expect(textOf(wrapper)).toContain('alex@example.com');

		backend.follows.length = 0;
		hold = true;
		window.dispatchEvent(new Event('focus'));
		await flushPromises();
		expect(textOf(wrapper)).not.toContain('alex@example.com');
		expect(wrapper.get('.social-status').text()).toBe('Loading profile…');
		gate.release();
		await settle();
		expect(wrapper.find('[data-state="teaser"]').exists()).toBe(true);
		expect(textOf(wrapper)).not.toContain('alex@example.com');
	});
});

describe('routes and failures', () => {
	test('a missing or inactive profile is reported without details', async () => {
		const backend = new FixtureBackend();
		backend.users.get(42).active = false;
		const { wrapper } = await mountSocialApp('/users/42', { backend });
		expect(wrapper.get('[data-state="missing"] h1').text()).toBe('This profile isn’t available.');
		expect(textOf(wrapper)).not.toContain('Alex');

		const unknown = await mountSocialApp('/users/12345', { backend });
		expect(unknown.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		await unknown.wrapper.get('[data-state="missing"] a').trigger('click');
		await settle();
		expect(unknown.router.currentRoute.value.name).toBe('people');
	});

	test('non-canonical or oversized IDs never reach the API', async () => {
		const backend = new FixtureBackend();
		for (const path of ['/users/007', '/users/abc', '/users/-1', '/users/1.5']) {
			const { router, wrapper } = await mountSocialApp(path, { backend });
			expect(router.currentRoute.value.name).toBe('not-found');
			expect(wrapper.find('[data-screen="profile"]').exists()).toBe(false);
		}
		const huge = await mountSocialApp('/users/9007199254740993', { backend });
		expect(huge.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(profileCalls(huge.fetchRef)).toHaveLength(0);
	});

	test('an unavailable service shows an error and no details; retry recovers', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		let down = true;
		const { wrapper } = await mountSocialApp('/users/42', {
			backend,
			before: (request) => {
				if (down && request.url.endsWith('/profile')) throw new TypeError('offline');
			},
		});
		expect(wrapper.get('[role="alert"]').text()).toContain('We can’t load this profile right now.');
		expect(textOf(wrapper)).not.toContain('alex@example.com');

		down = false;
		await wrapper.get('[role="alert"] button').trigger('click');
		await settle();
		expect(textOf(wrapper)).toContain('alex@example.com');
	});

	test('navigating between profiles never shows the previous person', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const gate = deferred();
		let hold = false;
		const { wrapper, router } = await mountSocialApp('/users/42', {
			backend,
			before: (request) =>
				hold && request.url.endsWith('/users/99/profile') ? gate.promise : undefined,
		});
		expect(textOf(wrapper)).toContain('alex@example.com');
		hold = true;
		await router.push('/users/99');
		await flushPromises();
		expect(textOf(wrapper)).not.toContain('Alex');
		expect(wrapper.get('.social-status').text()).toBe('Loading profile…');
		gate.release();
		await settle();
		expect(wrapper.get('h1').text()).toBe('Robin');
	});

	test('a response for a profile the user already left is discarded', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const slow = deferred();
		let hold = false;
		const { wrapper, router } = await mountSocialApp('/users/7', {
			backend,
			before: (request) =>
				hold && request.url.endsWith('/users/42/profile') ? slow.promise : undefined,
		});
		hold = true;
		await router.push('/users/42');
		await flushPromises();
		await router.push('/users/99');
		await settle();
		expect(wrapper.get('h1').text()).toBe('Robin');
		slow.release();
		await settle();
		expect(wrapper.get('h1').text()).toBe('Robin');
		expect(textOf(wrapper)).not.toContain('alex@example.com');
	});
});

describe('privacy switching', () => {
	test('public to private keeps followers and states the effect up front', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 99, 7)] });
		const { wrapper, fetchRef } = await mountSocialApp('/users/7', { backend });
		expect(textOf(wrapper.get('.privacy-control'))).toContain(
			'new followers will need your approval',
		);

		await wrapper.get('.privacy-control button').trigger('click');
		await settle();
		expect(socialCalls(fetchRef, { method: 'PATCH' })[0].json).toEqual({
			visibility: 'private',
			expected_version: 1,
		});
		expect(wrapper.get('[data-visibility] .badge').text()).toBe('Private profile');
		expect(textOf(wrapper.get('.profile-counts'))).toContain('1 follower');
		expect(backend.follows).toHaveLength(1);
		expect(backend.users.get(7).version).toBe(2);
	});

	test('private to public explains automatic acceptance and needs confirmation', async () => {
		const backend = new FixtureBackend({ follows: [pending(201, 7, 42), pending(202, 99, 42)] });
		const { wrapper, fetchRef } = await mountSocialApp('/users/42', { backend, viewerId: 42 });

		await wrapper.get('.privacy-control button').trigger('click');
		await flushPromises();
		const confirm = wrapper.get('.privacy-control__confirm');
		expect(confirm.text()).toContain('pending follow requests will be accepted automatically');
		expect(socialCalls(fetchRef, { method: 'PATCH' })).toHaveLength(0);

		await confirm.findAll('button')[1].trigger('click');
		await flushPromises();
		expect(wrapper.find('.privacy-control__confirm').exists()).toBe(false);
		expect(socialCalls(fetchRef, { method: 'PATCH' })).toHaveLength(0);
		expect(backend.users.get(42).visibility).toBe('private');

		await wrapper.get('.privacy-control button').trigger('click');
		await wrapper.get('.privacy-control__confirm button').trigger('click');
		await settle();
		expect(socialCalls(fetchRef, { method: 'PATCH' })).toHaveLength(1);
		expect(wrapper.get('[data-visibility] .badge').text()).toBe('Public profile');
		expect(backend.follows.map((f) => f.state)).toEqual(['accepted', 'accepted']);
		expect(textOf(wrapper.get('.profile-counts'))).toContain('2 followers');
	});

	test('moves focus into the confirmation and back to the toggle afterwards', async () => {
		const backend = new FixtureBackend({ follows: [pending(201, 7, 42)] });
		const { wrapper } = await mountSocialApp('/users/42', { backend, viewerId: 42 });
		const toggle = wrapper.get('.privacy-control > button');
		toggle.element.focus();
		await toggle.trigger('click');
		await settle();
		expect(document.activeElement).toBe(wrapper.get('.privacy-control__confirm').element);

		await wrapper.get('.privacy-control__confirm .button--secondary').trigger('click');
		await settle();
		expect(wrapper.find('.privacy-control__confirm').exists()).toBe(false);
		expect(document.activeElement?.textContent).toBe('Make profile public');

		await wrapper.get('.privacy-control > button').trigger('click');
		await settle();
		await wrapper.get('.privacy-control__confirm .button--primary').trigger('click');
		await settle();
		expect(document.activeElement?.textContent).toBe('Make profile private');
	});

	test('a duplicate submit is blocked while the change is in flight', async () => {
		const backend = new FixtureBackend();
		const gate = deferred();
		let hold = false;
		const { wrapper, fetchRef } = await mountSocialApp('/users/7', {
			backend,
			before: (request) => (hold && request.method === 'PATCH' ? gate.promise : undefined),
		});
		hold = true;
		const button = wrapper.get('.privacy-control button');
		await button.trigger('click');
		await button.trigger('click');
		await flushPromises();
		expect(button.attributes('aria-disabled')).toBe('true');
		expect(button.text()).toBe('Saving…');
		gate.release();
		await settle();
		expect(socialCalls(fetchRef, { method: 'PATCH' })).toHaveLength(1);
	});

	test('a stale version is rejected, reloaded, and never overrides the other tab', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/users/7', { backend });
		// Another tab makes the profile private, then public again (version 3).
		backend.request(7, 'PATCH', '/api/v1/users/me/privacy', {
			json: { visibility: 'private', expected_version: 1 },
		});
		backend.request(7, 'PATCH', '/api/v1/users/me/privacy', {
			json: { visibility: 'public', expected_version: 2 },
		});
		expect(backend.users.get(7).version).toBe(3);

		await wrapper.get('.privacy-control button').trigger('click');
		await settle();
		expect(textOf(wrapper.get('.privacy-control'))).toContain('changed somewhere else');
		expect(backend.users.get(7).visibility).toBe('public');
		expect(backend.users.get(7).version).toBe(3);

		// The reloaded version is used on the next explicit attempt.
		await wrapper.get('.privacy-control button').trigger('click');
		await settle();
		expect(backend.users.get(7).visibility).toBe('private');
		expect(backend.users.get(7).version).toBe(4);
		expect(wrapper.find('.privacy-control__message').text()).toBe('');
	});

	test('an unconfirmed privacy write is reported and the displayed value follows the server', async () => {
		const backend = new FixtureBackend();
		const { wrapper, fetchRef } = await mountSocialApp('/users/7', {
			backend,
			before: (request) => {
				if (request.method !== 'PATCH') return;
				backend.request(7, 'PATCH', request.url, { json: request.json });
				throw new TypeError('response lost');
			},
		});
		await wrapper.get('.privacy-control button').trigger('click');
		await settle();
		expect(textOf(wrapper.get('.privacy-control'))).toContain(
			'couldn’t confirm that privacy change',
		);
		expect(socialCalls(fetchRef, { method: 'PATCH' })).toHaveLength(1);
		expect(wrapper.get('[data-visibility] .badge').text()).toBe('Private profile');
	});

	test('a rejected privacy change is reported', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/users/7', {
			backend,
			before: (request) => {
				if (request.method === 'PATCH') request.json.visibility = 'friends';
			},
		});
		await wrapper.get('.privacy-control button').trigger('click');
		await settle();
		expect(textOf(wrapper.get('.privacy-control'))).toContain('That privacy change was rejected');
		expect(backend.users.get(7).visibility).toBe('public');
	});
});
