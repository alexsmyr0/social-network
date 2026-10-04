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
const listCalls = (fetchRef) =>
	socialCalls(fetchRef).filter((call) => /\/(followers|following)/u.test(call.url));

describe('followers and following lists', () => {
	test('the owner sees followers, with private members reduced to their names', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42), accepted(202, 99, 42)] });
		const { wrapper } = await mountSocialApp('/users/42/followers', { backend, viewerId: 42 });

		expect(wrapper.get('h1').text()).toBe('People following Alex Example');
		expect(wrapper.get('.social-status').text()).toBe('2 people');
		expect(wrapper.findAll('.person__name').map((a) => a.text())).toEqual([
			'Ada Lovelace',
			'Robin',
		]);
		const robin = wrapper.get('[data-person-id="99"]');
		expect(robin.attributes('data-access')).toBe('teaser');
		expect(robin.find('img').exists()).toBe(false);
		expect(textOf(robin)).toContain('Private profile · name only');
		expect(wrapper.get('[data-person-id="7"]').attributes('data-access')).toBe('full');
		expect(document.title).toBe('Followers · Commonplace');
	});

	test('shows who a person follows and links back to the profile', async () => {
		const backend = new FixtureBackend({ follows: [accepted(301, 7, 99)] });
		const { wrapper, router } = await mountSocialApp('/users/7/following', { backend });
		expect(wrapper.get('h1').text()).toBe('People followed by Ada Lovelace');
		expect(wrapper.findAll('.person__name').map((a) => a.text())).toEqual(['Robin']);
		await wrapper.get('.text-link').trigger('click');
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/users/7');
	});

	test('relationship controls inside a list act on that person and refresh the list', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42), accepted(202, 99, 42)] });
		const { wrapper } = await mountSocialApp('/users/42/followers', { backend, viewerId: 42 });
		expect(wrapper.get('[data-person-id="7"]').find('.follow-control').exists()).toBe(true);
		await wrapper.get('[data-person-id="7"] button').trigger('click');
		await settle();
		expect(backend.follows.some((f) => f.follower_id === 42 && f.followed_id === 7)).toBe(true);
		expect(textOf(wrapper.get('[data-person-id="7"]'))).toContain('Following');
	});

	test('a private profile’s lists are denied without requesting them', async () => {
		const backend = new FixtureBackend();
		const { wrapper, fetchRef } = await mountSocialApp('/users/42/followers', { backend });
		expect(wrapper.get('[data-state="missing"] h1').text()).toBe('This list isn’t available.');
		expect(listCalls(fetchRef)).toHaveLength(0);
		expect(wrapper.findAll('.person')).toHaveLength(0);

		const pending = await mountSocialApp('/users/42/following', {
			backend: new FixtureBackend({
				follows: [{ ...accepted(201, 7, 42), state: 'pending', accepted_at: null }],
			}),
		});
		expect(pending.wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(listCalls(pending.fetchRef)).toHaveLength(0);
	});

	test('a list the server denies is shown as unavailable, never as empty', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42)] });
		const { wrapper } = await mountSocialApp('/users/42/followers', {
			backend,
			before: (request) => {
				if (request.url.includes('/followers')) backend.follows.length = 0;
			},
		});
		expect(wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(wrapper.findAll('.person')).toHaveLength(0);
	});

	test('losing access while the list is open removes it on the next revalidation', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 7, 42), accepted(202, 99, 42)] });
		const gate = deferred();
		let hold = false;
		const { wrapper } = await mountSocialApp('/users/42/followers', {
			backend,
			viewerId: 7,
			before: () => (hold ? gate.promise : undefined),
		});
		expect(wrapper.findAll('.person')).toHaveLength(2);

		backend.follows.splice(
			backend.follows.findIndex((f) => f.follower_id === 7),
			1,
		);
		hold = true;
		window.dispatchEvent(new Event('focus'));
		await flushPromises();
		expect(wrapper.findAll('.person')).toHaveLength(0);
		gate.release();
		await settle();
		expect(wrapper.find('[data-state="missing"]').exists()).toBe(true);
		expect(textOf(wrapper)).not.toContain('Robin');
	});

	test('empty lists have honest wording for each kind', async () => {
		const backend = new FixtureBackend();
		const followers = await mountSocialApp('/users/7/followers', { backend });
		expect(textOf(followers.wrapper)).toContain('No followers yet.');
		const following = await mountSocialApp('/users/7/following', { backend });
		expect(textOf(following.wrapper)).toContain('Not following anyone yet.');
	});

	test('paginates, survives duplicate names, and recovers from a vanished page', async () => {
		const followers = [];
		const users = [...contractUsers()];
		for (let id = 100; id < 125; id += 1) {
			users.push(makeUser(id, { first_name: 'Sam', last_name: 'Twin' }));
			followers.push(accepted(1000 + id, id, 7));
		}
		const backend = new FixtureBackend({ users, follows: followers });
		const { wrapper, router } = await mountSocialApp('/users/7/followers', { backend });

		expect(wrapper.get('.social-status').text()).toBe('25 people');
		expect(wrapper.findAll('.person')).toHaveLength(20);
		expect(wrapper.get('.pager__position').text()).toBe('Page 1 of 2');
		await wrapper.get('a[rel="next"]').trigger('click');
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/users/7/followers?page=2');
		expect(wrapper.findAll('.person')).toHaveLength(5);

		await router.push('/users/7/followers?page=9');
		await settle();
		expect(textOf(wrapper)).toContain('That page doesn’t exist.');
		await wrapper.get('.social-state a').trigger('click');
		await settle();
		expect(wrapper.findAll('.person')).toHaveLength(20);
	});

	test('moving between followers and following reloads the matching list', async () => {
		const backend = new FixtureBackend({ follows: [accepted(201, 99, 7), accepted(202, 7, 42)] });
		const { wrapper, router, fetchRef } = await mountSocialApp('/users/7/followers', { backend });
		expect(wrapper.findAll('.person__name').map((a) => a.text())).toEqual(['Robin']);
		await router.push('/users/7/following');
		await settle();
		expect(wrapper.get('[data-screen="following"]').exists()).toBe(true);
		expect(wrapper.findAll('.person__name').map((a) => a.text())).toEqual(['Alex Example']);
		const urls = listCalls(fetchRef).map((c) => c.url);
		expect(urls[0]).toBe('/api/v1/users/7/followers');
		expect(urls.at(-1)).toBe('/api/v1/users/7/following');
	});

	test('invalid IDs and outages are reported without list data', async () => {
		const backend = new FixtureBackend();
		const huge = await mountSocialApp('/users/9007199254740993/followers', { backend });
		expect(huge.wrapper.find('[data-state="missing"]').exists()).toBe(true);

		let down = true;
		const outage = await mountSocialApp('/users/7/followers', {
			backend,
			before: (request) => {
				if (down && request.url.includes('/profile')) throw new TypeError('offline');
			},
		});
		expect(outage.wrapper.get('[role="alert"]').text()).toContain(
			'We can’t load this list right now.',
		);
		down = false;
		await outage.wrapper.get('[role="alert"] button').trigger('click');
		await settle();
		expect(outage.wrapper.get('h1').text()).toContain('Ada Lovelace');

		const listDown = await mountSocialApp('/users/7/following', {
			backend,
			before: (request) => {
				if (request.url.endsWith('/following')) throw new TypeError('offline');
			},
		});
		expect(listDown.wrapper.find('[role="alert"]').exists()).toBe(true);
	});
});
