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
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function crowd(count, extra = []) {
	const people = [];
	for (let id = 100; id < 100 + count; id += 1) {
		people.push(makeUser(id, { first_name: `Name${String(id).padStart(3, '0')}` }));
	}
	return new FixtureBackend({ users: [...contractUsers(), ...people, ...extra] });
}

const rowFor = (wrapper, id) => wrapper.get(`[data-person-id="${id}"]`);
const peopleCalls = (fetchRef) =>
	socialCalls(fetchRef, { method: 'GET' }).filter(
		(call) => call.url.split('?')[0] === '/api/v1/users',
	);

describe('people directory', () => {
	test('lists active people by display name with relationship-aware access', async () => {
		const backend = new FixtureBackend({
			users: [
				...contractUsers(),
				makeUser(5, { first_name: 'Zed', avatar_url: '/api/v1/users/5/avatar' }),
			],
		});
		const { wrapper } = await mountSocialApp('/people', { backend });

		const names = wrapper.findAll('.person__name').map((link) => link.text());
		expect(names).toEqual(['Ada Lovelace', 'Alex Example', 'Robin', 'Zed Example']);
		expect(textOf(rowFor(wrapper, 7))).toContain('This is you');
		expect(rowFor(wrapper, 7).find('button').exists()).toBe(false);

		const teaser = rowFor(wrapper, 42);
		expect(teaser.attributes('data-access')).toBe('teaser');
		expect(textOf(teaser)).toContain('Private profile · name only');
		expect(teaser.find('img').exists()).toBe(false);
		expect(teaser.html()).not.toContain('/avatar');

		expect(rowFor(wrapper, 5).get('img').attributes('src')).toBe('/api/v1/users/5/avatar');
		expect(wrapper.get('.social-status').text()).toBe('4 people');
		expect(rowFor(wrapper, 42).get('a').attributes('href')).toBe('/users/42');
	});

	test('searches display names, keeps the query in the URL and clears it', async () => {
		const backend = new FixtureBackend();
		const { wrapper, router, fetchRef } = await mountSocialApp('/people', { backend });

		await wrapper.get('input[name="q"]').setValue('  ALEX ');
		await wrapper.get('form').trigger('submit');
		await settle();

		expect(router.currentRoute.value.fullPath).toBe('/people?q=ALEX');
		expect(peopleCalls(fetchRef).at(-1).url).toBe('/api/v1/users?q=ALEX');
		expect(wrapper.findAll('.person__name').map((link) => link.text())).toEqual(['Alex Example']);
		expect(wrapper.get('.social-status').text()).toBe('1 person matching “ALEX”');

		await wrapper.get('.button--secondary').trigger('click');
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/people');
		expect(wrapper.get('input[name="q"]').element.value).toBe('');
		expect(wrapper.findAll('.person')).toHaveLength(3);
	});

	test('treats search characters literally and explains empty results', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/people?q=%25_%5C', { backend });

		expect(wrapper.get('input[name="q"]').element.value).toBe('%_\\');
		expect(wrapper.findAll('.person')).toHaveLength(0);
		expect(textOf(wrapper)).toContain('No one matches “%_\\”.');
		expect(textOf(wrapper)).toContain('without fuzzy search');

		const emptyDirectory = await mountSocialApp('/people', {
			backend: new FixtureBackend({ users: [contractUsers()[0]] }),
		});
		expect(emptyDirectory.wrapper.findAll('.person')).toHaveLength(1);
	});

	test('does not search email addresses', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/people?q=alex%40example.com', { backend });
		expect(wrapper.findAll('.person')).toHaveLength(0);
	});

	test('rejects over-long and control-character searches before any request', async () => {
		const backend = new FixtureBackend();
		const { wrapper, router, fetchRef } = await mountSocialApp('/people', { backend });
		const before = peopleCalls(fetchRef).length;

		await wrapper.get('input[name="q"]').setValue('x'.repeat(101));
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(wrapper.get('#people-search-error').text()).toContain('100 characters');
		expect(wrapper.get('input[name="q"]').attributes('aria-invalid')).toBe('true');
		expect(wrapper.get('input[name="q"]').attributes('aria-describedby')).toBe(
			'people-search-error',
		);

		await wrapper.get('input[name="q"]').setValue('bad\u0000name');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		expect(wrapper.get('#people-search-error').text()).toContain('control characters');

		expect(peopleCalls(fetchRef)).toHaveLength(before);
		expect(router.currentRoute.value.fullPath).toBe('/people');

		await wrapper.get('input[name="q"]').setValue('ada');
		await wrapper.get('form').trigger('submit');
		await settle();
		expect(wrapper.find('#people-search-error').exists()).toBe(false);
		expect(wrapper.findAll('.person')).toHaveLength(1);
	});

	test('shows the server search error when a deep link carries an invalid query', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp(`/people?q=${'x'.repeat(101)}`, { backend });
		expect(wrapper.get('#people-search-error').text()).toBe('Search is too long.');
		expect(textOf(wrapper)).toContain('That search can’t be shown.');
	});

	test('pages results through links, so back navigation restores the previous page', async () => {
		const backend = crowd(45);
		const { wrapper, router } = await mountSocialApp('/people', { backend });

		expect(wrapper.findAll('.person')).toHaveLength(20);
		expect(wrapper.get('.social-status').text()).toBe('48 people');
		expect(wrapper.get('.pager__position').text()).toBe('Page 1 of 3');
		expect(wrapper.get('.pager').findAll('span[aria-disabled="true"]')[0].text()).toBe('Previous');

		await wrapper.get('a[rel="next"]').trigger('click');
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/people?page=2');
		expect(wrapper.get('.pager__position').text()).toBe('Page 2 of 3');
		expect(wrapper.findAll('.person')).toHaveLength(20);

		router.back();
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/people');
		expect(wrapper.get('.pager__position').text()).toBe('Page 1 of 3');
	});

	test('a new search returns to the first page and a vanished page offers a way back', async () => {
		const backend = crowd(45);
		const { wrapper, router } = await mountSocialApp('/people?page=3', { backend });
		await wrapper.get('input[name="q"]').setValue('Name');
		await wrapper.get('form').trigger('submit');
		await settle();
		expect(router.currentRoute.value.fullPath).toBe('/people?q=Name');

		const gone = await mountSocialApp('/people?page=9', { backend });
		expect(textOf(gone.wrapper)).toContain('That page doesn’t exist.');
		expect(gone.wrapper.findAll('.person')).toHaveLength(0);
		await gone.wrapper.get('.social-state a').trigger('click');
		await settle();
		expect(gone.router.currentRoute.value.fullPath).toBe('/people');
		expect(gone.wrapper.findAll('.person')).toHaveLength(20);
	});

	test('keeps duplicate display names and missing optional fields usable', async () => {
		const backend = new FixtureBackend({
			users: [
				contractUsers()[0],
				makeUser(21, { first_name: 'Sam', last_name: 'Twin' }),
				makeUser(22, { first_name: 'Sam', last_name: 'Twin', nickname: null, about_me: null }),
			],
		});
		const { wrapper } = await mountSocialApp('/people', { backend });
		const twins = wrapper.findAll('.person__name').filter((link) => link.text() === 'Sam Twin');
		expect(twins.map((link) => link.attributes('href'))).toEqual(['/users/21', '/users/22']);
	});

	test('shows an honest error with retry when the service is unavailable', async () => {
		const backend = new FixtureBackend();
		let failing = true;
		const { wrapper } = await mountSocialApp('/people', {
			backend,
			before: (request) => {
				if (failing && request.url.startsWith('/api/v1/users?')) throw new TypeError('offline');
				if (failing && request.url === '/api/v1/users') throw new TypeError('offline');
			},
		});
		expect(wrapper.get('[role="alert"]').text()).toContain('We can’t load people right now.');
		expect(wrapper.findAll('.person')).toHaveLength(0);

		failing = false;
		await wrapper.get('.social-state button').trigger('click');
		await settle();
		expect(wrapper.findAll('.person')).toHaveLength(3);
	});
});

describe('follow controls in the directory', () => {
	test('follows a private account as a pending request and cancels it', async () => {
		const backend = new FixtureBackend();
		const { wrapper, fetchRef } = await mountSocialApp('/people', { backend });
		const button = () => rowFor(wrapper, 42).get('button');

		expect(button().text()).toBe('Follow');
		expect(button().attributes('aria-label')).toBe('Follow Alex Example');
		await button().trigger('click');
		await settle();

		expect(socialCalls(fetchRef, { method: 'POST' })[0].json).toEqual({ user_id: 42 });
		expect(textOf(rowFor(wrapper, 42))).toContain('Request pending');
		expect(button().text()).toBe('Cancel request');
		expect(button().attributes('aria-label')).toBe('Cancel follow request to Alex Example');
		expect(rowFor(wrapper, 42).attributes('data-access')).toBe('teaser');

		await button().trigger('click');
		await settle();
		expect(socialCalls(fetchRef, { method: 'DELETE' })[0].url).toBe('/api/v1/follows/201');
		expect(button().text()).toBe('Follow');
		expect(backend.follows).toEqual([]);
	});

	test('follows a public account immediately and unfollows it', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/people', { backend, viewerId: 99 });
		const button = () => rowFor(wrapper, 7).get('button');

		await button().trigger('click');
		await settle();
		expect(textOf(rowFor(wrapper, 7))).toContain('Following');
		expect(button().text()).toBe('Unfollow');
		expect(backend.follows[0]).toMatchObject({
			follower_id: 99,
			followed_id: 7,
			state: 'accepted',
		});

		await button().trigger('click');
		await settle();
		expect(button().text()).toBe('Follow');
		expect(backend.follows).toEqual([]);
	});

	test('keeps keyboard focus on the same control while its action changes', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/people', { backend });
		const button = rowFor(wrapper, 42).get('button');
		button.element.focus();
		await button.trigger('click');
		await settle();
		expect(document.activeElement?.textContent).toBe('Cancel request');
	});

	test('ignores duplicate clicks while a write is in flight', async () => {
		const backend = new FixtureBackend();
		const gate = deferred();
		let hold = false;
		const { wrapper, fetchRef } = await mountSocialApp('/people', {
			backend,
			before: (request) => (hold && request.method === 'POST' ? gate.promise : undefined),
		});
		hold = true;
		const button = rowFor(wrapper, 42).get('button');
		await button.trigger('click');
		await button.trigger('click');
		await flushPromises();
		expect(button.attributes('aria-disabled')).toBe('true');
		expect(button.text()).toBe('Working…');
		expect(socialCalls(fetchRef, { method: 'POST' })).toHaveLength(1);

		gate.release();
		await settle();
		expect(socialCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(rowFor(wrapper, 42).get('button').text()).toBe('Cancel request');
	});

	test('a stale cancel cannot touch a later relationship and shows the current state', async () => {
		const backend = new FixtureBackend();
		const { wrapper, fetchRef, social } = await mountSocialApp('/people', { backend });
		await rowFor(wrapper, 42).get('button').trigger('click');
		await settle();
		expect(backend.follows[0].id).toBe(201);

		// Elsewhere: the recipient declines, then the sender requests again (ID 202).
		backend.request(42, 'PATCH', '/api/v1/follow-requests/201', { json: { decision: 'decline' } });
		backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
		expect(backend.follows[0].id).toBe(202);

		await rowFor(wrapper, 42).get('button').trigger('click');
		await settle();

		expect(socialCalls(fetchRef, { method: 'DELETE' })[0].url).toBe('/api/v1/follows/201');
		expect(backend.follows).toHaveLength(1);
		expect(backend.follows[0]).toMatchObject({ id: 202, state: 'pending' });
		expect(textOf(rowFor(wrapper, 42))).toContain('changed in the meantime');
		expect(rowFor(wrapper, 42).get('button').text()).toBe('Cancel request');
		expect(social.state.followMessages[42]).toContain('Check the current state');
	});

	test('does not report success when the response is lost, and never replays the write', async () => {
		const backend = new FixtureBackend();
		const { wrapper, fetchRef } = await mountSocialApp('/people', {
			backend,
			before: (request) => {
				if (request.method !== 'POST') return;
				// The server commits, but the response never arrives.
				backend.request(7, 'POST', '/api/v1/follows', { json: request.json });
				throw new TypeError('response lost');
			},
		});
		await rowFor(wrapper, 42).get('button').trigger('click');
		await settle();

		expect(socialCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(textOf(rowFor(wrapper, 42))).toContain('We couldn’t confirm that change');
		// The refetch reflects what the server committed.
		expect(rowFor(wrapper, 42).get('button').text()).toBe('Cancel request');
	});

	test('reports a person who is no longer available and refreshes the list', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/people', { backend });
		backend.users.get(42).active = false;
		await rowFor(wrapper, 42).get('button').trigger('click');
		await settle();
		expect(wrapper.find('[data-person-id="42"]').exists()).toBe(false);
		expect(wrapper.findAll('.person')).toHaveLength(2);
	});
});

describe('stale data and session changes', () => {
	test('a slow earlier response cannot replace a newer search', async () => {
		const backend = new FixtureBackend();
		const slow = deferred();
		let holdFirst = false;
		const { wrapper } = await mountSocialApp('/people', {
			backend,
			before: (request) =>
				holdFirst && request.url === '/api/v1/users?q=ada' ? slow.promise : undefined,
		});
		holdFirst = true;
		await wrapper.get('input[name="q"]').setValue('ada');
		await wrapper.get('form').trigger('submit');
		await flushPromises();
		await wrapper.get('input[name="q"]').setValue('robin');
		await wrapper.get('form').trigger('submit');
		await settle();
		expect(wrapper.findAll('.person__name').map((link) => link.text())).toEqual(['Robin']);

		slow.release();
		await settle();
		expect(wrapper.findAll('.person__name').map((link) => link.text())).toEqual(['Robin']);
	});

	test('window focus discards shown people and shows what the server now allows', async () => {
		const backend = new FixtureBackend({
			users: [
				...contractUsers(),
				makeUser(5, { first_name: 'Zed', avatar_url: '/api/v1/users/5/avatar' }),
			],
		});
		const gate = deferred();
		let hold = false;
		const { wrapper } = await mountSocialApp('/people', {
			backend,
			before: () => (hold ? gate.promise : undefined),
		});
		expect(rowFor(wrapper, 5).get('img').exists()).toBe(true);

		// Zed goes private elsewhere: their avatar and details must not linger
		// on screen while the revalidation is still in flight.
		backend.users.get(5).visibility = 'private';
		hold = true;
		window.dispatchEvent(new Event('focus'));
		await flushPromises();
		expect(wrapper.find('.person').exists()).toBe(false);
		expect(wrapper.get('.social-status').text()).toBe('Loading people…');

		gate.release();
		await settle();
		expect(rowFor(wrapper, 5).attributes('data-access')).toBe('teaser');
		expect(rowFor(wrapper, 5).find('img').exists()).toBe(false);
	});

	test('the 60-second fallback refetches quietly while the page is visible', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const backend = new FixtureBackend();
		const { wrapper, fetchRef } = await mountSocialApp('/people', { backend });
		const before = peopleCalls(fetchRef).length;

		backend.follows.push({
			id: 900,
			follower_id: 7,
			followed_id: 99,
			state: 'pending',
			created_at: '2026-10-02T12:00:00Z',
			accepted_at: null,
		});
		vi.advanceTimersByTime(59999);
		await flushPromises();
		expect(peopleCalls(fetchRef)).toHaveLength(before);

		vi.advanceTimersByTime(1);
		await flushPromises();
		expect(peopleCalls(fetchRef)).toHaveLength(before + 1);
		expect(textOf(rowFor(wrapper, 99))).toContain('Request pending');
	});

	test('server invalidation bursts coalesce into one hard refetch', async () => {
		const backend = new FixtureBackend();
		const { wrapper, social, fetchRef } = await mountSocialApp('/people', { backend });
		const before = peopleCalls(fetchRef).length;
		await Promise.all([
			social.invalidate(),
			social.invalidate(),
			social.refresh(),
			social.invalidate(),
		]);
		await settle();
		expect(peopleCalls(fetchRef)).toHaveLength(before + 1);
		expect(wrapper.findAll('.person')).toHaveLength(3);
	});

	test('a revoked session clears the page and returns to sign in without stale people', async () => {
		const backend = new FixtureBackend();
		const { wrapper, router, current, session } = await mountSocialApp('/people', { backend });
		expect(wrapper.findAll('.person')).toHaveLength(3);

		current.viewerId = null;
		window.dispatchEvent(new Event('focus'));
		await settle();

		expect(session.state.status).toBe('unauthenticated');
		expect(router.currentRoute.value.name).toBe('login');
		expect(router.currentRoute.value.query.redirect).toBe('/people');
		expect(wrapper.find('.person').exists()).toBe(false);
		expect(textOf(wrapper)).not.toContain('Alex Example');
	});

	test('an unreachable account service keeps the private gate instead of redirecting', async () => {
		const backend = new FixtureBackend();
		let down = false;
		const { wrapper, router, current, session } = await mountSocialApp('/people', {
			backend,
			before: (request) => {
				if (down && request.url === '/api/v1/users/me') throw new TypeError('offline');
			},
		});
		down = true;
		current.viewerId = null;
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(session.state.status).toBe('unavailable');
		expect(router.currentRoute.value.name).toBe('people');
		expect(wrapper.find('.person').exists()).toBe(false);
		expect(wrapper.get('.session-gate').text()).toContain('still private');
	});

	test('switching accounts never shows the previous account’s relationships or messages', async () => {
		const backend = new FixtureBackend();
		const { wrapper, router, session, social, current } = await mountSocialApp('/people', {
			backend,
		});
		await rowFor(wrapper, 42).get('button').trigger('click');
		await settle();
		expect(rowFor(wrapper, 42).get('button').text()).toBe('Cancel request');

		await session.signOut();
		await router.replace({ name: 'login' });
		current.viewerId = 99;
		await session.signIn({ email: 'outsider@example.com', password: 'unused' }).catch(() => {});
		session.acceptAccount(backend.account(backend.users.get(99)));
		await router.replace({ name: 'people' });
		await settle();

		expect(rowFor(wrapper, 42).get('button').text()).toBe('Follow');
		expect(social.state.followMessages).toEqual({});
		expect(social.state.pendingFollows).toEqual({});
	});

	test('a delayed previous-account write cannot unlock the current account’s button', async () => {
		const backend = new FixtureBackend();
		const { wrapper, router, session, social, current, fetchRef } = await mountSocialApp(
			'/people',
			{ backend },
		);
		const oldGate = deferred();
		const newGate = deferred();
		let writes = 0;
		vi.stubGlobal('fetch', async (url, init) => {
			if (url !== '/api/v1/follows' || init?.method !== 'POST') return fetchRef(url, init);
			const response = await fetchRef(url, init);
			writes += 1;
			if (writes === 1) {
				await oldGate.promise;
				throw new TypeError('old response lost after commit');
			}
			await newGate.promise;
			return response;
		});
		const oldAction = social.follow(42);
		await settle();
		// The global logout handler uses this same session cleanup, then routes
		// to login. The social state remains shared across route remounts.
		session.clearAuthenticatedState();
		current.viewerId = null;
		await router.replace({ name: 'login' });
		current.viewerId = 99;
		session.acceptAccount(backend.account(backend.users.get(99)));
		await router.replace({ name: 'people' });
		await settle();
		await rowFor(wrapper, 42).get('button').trigger('click');
		await settle();
		oldGate.release();
		await oldAction;
		await settle();
		try {
			expect(rowFor(wrapper, 42).get('button').attributes('aria-disabled')).toBe('true');
			expect(social.state.followMessages[42] ?? '').toBe('');
			await rowFor(wrapper, 42).get('button').trigger('click');
			await settle();
			expect(writes).toBe(2);
		} finally {
			newGate.release();
			await settle();
		}
		expect(rowFor(wrapper, 42).get('button').text()).toBe('Cancel request');
	});

	test('the Profile and People links are in the authenticated shell', async () => {
		const backend = new FixtureBackend();
		const { wrapper } = await mountSocialApp('/people', { backend });
		const links = wrapper
			.findAll('.site-nav a')
			.map((link) => [link.text(), link.attributes('href')]);
		expect(links).toEqual([
			['Home', '/'],
			['Feed', '/feed'],
			['People', '/people'],
			['Groups', '/groups'],
			['Activity', '/activity'],
			['Profile', '/users/7'],
		]);
		expect(wrapper.get('.site-nav a.router-link-active').text()).toBe('People');
	});
});
