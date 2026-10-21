// @vitest-environment jsdom
// SN-A18: group events, answers and event notices against the stateful Phase 5
// model (itself proved against the approved pack by event-model.test.js).
import { afterEach, describe, expect, test, vi } from 'vitest';

import { EventBackend } from '../../../../fixtures/phase5/event-backend.js';
import {
	button,
	cleanupMounted,
	deferred,
	mountGroupApp,
	settle,
	signal,
	textOf,
} from '../groups/harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

// Viewers in the default scenario: 42 Alex (creator, 501), 7 Ada (member 502,
// private profile), 10 Lee (member 504), 8 Sam (invitee), 9 Pat (requester),
// 12 Quinn (departed), 99 Robin (outsider).
const mount = (path, options = {}) =>
	mountGroupApp(path, { backend: new EventBackend(), ...options });
const eventCalls = (fetchRef, { method, path } = {}) =>
	fetchRef.calls.filter(
		(call) =>
			/\/groups\/\d+\/events/u.test(call.url) &&
			(!method || call.method === method) &&
			(!path || path.test(call.url)),
	);
const navLinks = (wrapper) =>
	wrapper.findAll('.group-nav a').map((link) => [link.text(), link.attributes('href')]);
const cardIds = (wrapper) =>
	wrapper
		.findAll('.event-list [data-event-id]')
		.map((card) => Number(card.attributes('data-event-id')));
const choice = (wrapper, value) => wrapper.get(`.event-choice[data-choice="${value}"]`);
const status = (wrapper) => wrapper.get('.event-response__status').text();
const answers = (wrapper) =>
	wrapper
		.findAll('.event-responses__item')
		.map((row) => [row.attributes('data-user-id'), row.attributes('data-choice')]);
const feedbackText = (wrapper) => wrapper.get('.group-feedback').text();
const PUT_RESPONSE = { method: 'PUT', path: /\/response$/u };

async function switchAccount(app, viewerId) {
	app.current.viewerId = viewerId;
	await app.session.restore({ force: true });
	await settle();
}

describe('SN-A18 role-appropriate event access', () => {
	test.each([
		[99, 'outsider'],
		[8, 'pending invitee'],
		[9, 'pending requester'],
		[12, 'departed member'],
	])('viewer %i (%s) never requests or sees event content', async (viewerId) => {
		const list = await mount('/groups/301/events', { viewerId });
		expect(textOf(list.wrapper)).toContain('Only members can see group events.');
		expect(navLinks(list.wrapper)).toEqual([['About', '/groups/301']]);
		expect(list.wrapper.find('.event-list').exists()).toBe(false);
		expect(textOf(list.wrapper)).not.toContain('Opening night');
		expect(eventCalls(list.fetchRef)).toHaveLength(0);
		cleanupMounted();

		const detail = await mount('/groups/301/events/701', { viewerId });
		expect(textOf(detail.wrapper)).toContain('Only members can see group events.');
		expect(textOf(detail.wrapper)).not.toContain('Opening night');
		expect(textOf(detail.wrapper)).not.toContain('Bring a board');
		expect(eventCalls(detail.fetchRef)).toHaveLength(0);
		cleanupMounted();

		const create = await mount('/groups/301/events/new', { viewerId });
		expect(textOf(create.wrapper)).toContain('Only members can schedule events.');
		expect(create.wrapper.find('form').exists()).toBe(false);
		expect(eventCalls(create.fetchRef)).toHaveLength(0);
	});

	test('a member gets the Events section and an unknown group or event is one unavailable state', async () => {
		const { wrapper, router } = await mount('/groups/301/events', { viewerId: 7 });
		expect(navLinks(wrapper)).toEqual([
			['About', '/groups/301'],
			['Posts', '/groups/301/posts'],
			['Events', '/groups/301/events'],
			['Chat', '/groups/301/chat'],
			['Members', '/groups/301/members'],
		]);
		expect(wrapper.get('.group-nav [aria-current="page"]').text()).toBe('Events');
		await router.push('/groups/999/events/701');
		await settle();
		expect(textOf(wrapper)).toContain('This group isn’t available.');
		// An event of another group is not found under this group's route.
		await router.push('/groups/301/events/9999');
		await settle();
		expect(textOf(wrapper)).toContain('This event isn’t available.');
		await router.push('/groups/301/events/0');
		await settle();
		expect(router.currentRoute.value.name).toBe('not-found');
	});

	test('the group About page links members to the events', async () => {
		const { wrapper } = await mount('/groups/301', { viewerId: 7 });
		expect(wrapper.find('a[href="/groups/301/events"]').exists()).toBe(true);
		cleanupMounted();
		const outsider = await mount('/groups/301', { viewerId: 99 });
		expect(outsider.wrapper.find('a[href="/groups/301/events"]').exists()).toBe(false);
	});
});

describe('SN-A18 event list', () => {
	test('lists events by start time, including past ones, with counts and the viewer’s answer', async () => {
		const { wrapper } = await mount('/groups/301/events', { viewerId: 7 });
		expect(cardIds(wrapper)).toEqual([702, 701]);
		const past = wrapper.get('[data-event-id="702"]');
		expect(past.attributes('data-past')).toBe('true');
		expect(past.text()).toContain('Past');
		expect(past.text()).toContain('Endgame workshop');
		expect(past.text()).toContain('1 going · 1 not going');
		expect(past.text()).toContain('No answer yet');
		expect(past.text()).toContain('Scheduled by Alex Example');
		expect(past.get('a').attributes('href')).toBe('/groups/301/events/702');
		const upcoming = wrapper.get('[data-event-id="701"]');
		expect(upcoming.attributes('data-past')).toBe('false');
		expect(upcoming.text()).not.toContain('Past');
		expect(upcoming.text()).toContain('You: Going');
		// Ada has a private profile; the creator shown to others is a name only.
		expect(upcoming.text()).toContain('Scheduled by Ada Lovelace');
		expect(upcoming.find('img').exists()).toBe(false);
		expect(wrapper.find('time[datetime="2099-10-20T17:30:00Z"]').exists()).toBe(true);
	});

	test('an empty group shows an honest empty state and an outage can be retried', async () => {
		const backend = new EventBackend({ given: { events: { 701: null, 702: null } } });
		const app = await mountGroupApp('/groups/301/events', { backend, viewerId: 7 });
		expect(textOf(app.wrapper)).toContain('No events yet.');
		expect(app.wrapper.find('.event-list').exists()).toBe(false);
		backend.faults.push({ method: 'GET', path: /\/events$/u, repeat: true });
		await app.wrapper.get('a[href="/groups/301"]').trigger('click');
		await app.router.push('/groups/301/events');
		await settle();
		expect(textOf(app.wrapper)).toContain('We can’t load the events right now.');
		backend.faults.length = 0;
		await button(app.wrapper, 'Try again').trigger('click');
		await settle();
		expect(textOf(app.wrapper)).toContain('No events yet.');
	});

	test('pages are navigable and a page beyond the last recovers', async () => {
		const events = {};
		for (let id = 1000; id < 1025; id += 1)
			events[id] = {
				id,
				group_id: 301,
				creator_id: 42,
				title: `Event ${id}`,
				description: 'Bulk',
				starts_at: `2099-11-${String(id - 999).padStart(2, '0')}T10:00:00Z`,
				created_at: '2026-10-09T12:00:00Z',
			};
		const backend = new EventBackend({ given: { events } });
		const app = await mountGroupApp('/groups/301/events', { backend, viewerId: 7 });
		expect(textOf(app.wrapper)).toContain('27 events');
		expect(app.wrapper.findAll('.event-list [data-event-id]')).toHaveLength(20);
		expect(textOf(app.wrapper)).toContain('Page 1 of 2');
		await app.router.push('/groups/301/events?page=2');
		await settle();
		expect(app.wrapper.findAll('.event-list [data-event-id]')).toHaveLength(7);
		await app.router.push('/groups/301/events?page=9');
		await settle();
		expect(textOf(app.wrapper)).toContain('That page doesn’t exist.');
		expect(app.wrapper.find('.event-list').exists()).toBe(false);
	});
});

describe('SN-A18 event detail and answers', () => {
	test('shows the event, counts, the viewer’s answer and who answered, names only', async () => {
		const { wrapper } = await mount('/groups/301/events/702', { viewerId: 10 });
		expect(wrapper.get('h1').text()).toBe('Endgame workshop');
		expect(textOf(wrapper)).toContain('Rook endings, step by step.');
		expect(textOf(wrapper)).toContain('Scheduled by Alex Example');
		expect(textOf(wrapper)).toContain('1 going · 1 not going');
		expect(choice(wrapper, 'not_going').attributes('aria-pressed')).toBe('true');
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('false');
		expect(answers(wrapper)).toEqual([
			['10', 'not_going'],
			['42', 'going'],
		]);
		expect(wrapper.find('.event-responses img').exists()).toBe(false);
	});

	test('a first answer, then a change, send the version the viewer saw and update counts', async () => {
		const app = await mount('/groups/301/events/702', { viewerId: 7 });
		const { wrapper, fetchRef, backend } = app;
		expect(textOf(wrapper)).toContain('You haven’t answered yet.');
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('false');
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)).toHaveLength(1);
		expect(eventCalls(fetchRef, PUT_RESPONSE)[0].json).toEqual({
			membership_id: 502,
			choice: 'going',
			expected_version: 0,
		});
		expect(status(wrapper)).toBe('Your answer is saved: Going.');
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('true');
		expect(textOf(wrapper)).toContain('2 going · 1 not going');
		expect(answers(wrapper)).toContainEqual(['7', 'going']);
		await choice(wrapper, 'not_going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)[1].json).toEqual({
			membership_id: 502,
			choice: 'not_going',
			expected_version: 1,
		});
		expect(textOf(wrapper)).toContain('1 going · 2 not going');
		expect(choice(wrapper, 'not_going').attributes('aria-pressed')).toBe('true');
		expect(backend.responses.get('702:502')).toMatchObject({ choice: 'not_going', version: 2 });
		// Choosing the selected answer again is not a write.
		await choice(wrapper, 'not_going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)).toHaveLength(2);
	});

	test('the signal the server sends back to the responder keeps the buttons, message and focus', async () => {
		const app = await mount('/groups/301/events/702', { viewerId: 7 });
		const { wrapper, fetchRef } = app;
		const going = choice(wrapper, 'going').element;
		going.focus();
		await choice(wrapper, 'going').trigger('click');
		await settle();
		const reads = eventCalls(fetchRef, { method: 'GET', path: /\/events\/702$/u }).length;
		await signal(app.sockets);
		// The refetch ran, but the answer buttons were never unmounted.
		expect(eventCalls(fetchRef, { method: 'GET', path: /\/events\/702$/u }).length).toBeGreaterThan(
			reads,
		);
		expect(choice(wrapper, 'going').element).toBe(going);
		expect(document.activeElement).toBe(going);
		expect(status(wrapper)).toBe('Your answer is saved: Going.');
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('true');
	});

	test('a double click sends one write and shows no success before it commits', async () => {
		const hold = deferred();
		const { wrapper, fetchRef } = await mount('/groups/301/events/702', {
			viewerId: 7,
			before: async (call) => {
				if (call.method === 'PUT') await hold.promise;
			},
		});
		await choice(wrapper, 'going').trigger('click');
		await choice(wrapper, 'going').trigger('click');
		await choice(wrapper, 'not_going').trigger('click');
		await settle();
		expect(status(wrapper)).toBe('');
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('false');
		expect(choice(wrapper, 'going').attributes('aria-disabled')).toBe('true');
		hold.release();
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)).toHaveLength(1);
		expect(status(wrapper)).toBe('Your answer is saved: Going.');
	});

	test('a stale answer is refused, explained, reloaded and never shown as saved', async () => {
		const app = await mount('/groups/301/events/702', { viewerId: 7 });
		const { wrapper, fetchRef, backend } = app;
		// Another session answered for Ada; this tab missed the signal.
		backend.request(7, 'PUT', '/api/v1/groups/301/events/702/response', {
			json: { membership_id: 502, choice: 'not_going', expected_version: 0 },
		});
		backend.signals.length = 0;
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)).toHaveLength(1);
		expect(status(wrapper)).toContain('Your answer changed somewhere else, so nothing was saved.');
		expect(status(wrapper)).not.toContain('Your answer is saved');
		// The page now reflects the server's answer; choosing again is deliberate.
		expect(choice(wrapper, 'not_going').attributes('aria-pressed')).toBe('true');
		expect(backend.responses.get('702:502')).toMatchObject({ choice: 'not_going', version: 1 });
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE).at(-1).json.expected_version).toBe(1);
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('true');
	});

	test('a committed answer with a lost response is reloaded, reported as unconfirmed and not retried', async () => {
		const { wrapper, fetchRef, backend } = await mount('/groups/301/events/702', { viewerId: 7 });
		backend.faults.push({ method: 'PUT', path: /\/response$/u, commit: true });
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(status(wrapper)).toContain('We couldn’t confirm that change');
		expect(status(wrapper)).not.toContain('Your answer is saved');
		expect(eventCalls(fetchRef, PUT_RESPONSE)).toHaveLength(1);
		// The refetch shows what the server actually holds.
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('true');
		expect(backend.responses.get('702:502')).toMatchObject({ choice: 'going', version: 1 });
	});

	test('an answer from a removed member is refused and no event content stays on screen', async () => {
		const app = await mount('/groups/301/events/702', { viewerId: 7 });
		const { wrapper, fetchRef, backend } = app;
		backend.removeMember(301, 7);
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)).toHaveLength(1);
		expect(textOf(wrapper)).not.toContain('Endgame workshop');
		expect(textOf(wrapper)).not.toContain('Your answer is saved');
		expect(feedbackText(wrapper)).toContain('no longer available to you');
		expect(wrapper.find('.event-choice').exists()).toBe(false);
	});

	test('an old membership ID is stale and does not act for the new membership', async () => {
		const app = await mount('/groups/301/events/702', { viewerId: 7 });
		const { wrapper, fetchRef, backend } = app;
		backend.removeMember(301, 7);
		const returned = backend.admit(301, 7, []);
		backend.signals.length = 0;
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE)[0].json.membership_id).toBe(502);
		expect(feedbackText(wrapper)).toContain('membership in this group changed');
		expect(backend.responses.has('702:502')).toBe(false);
		expect(backend.responses.has(`702:${returned.id}`)).toBe(false);
		// After the reload the member answers under the new generation.
		await settle();
		await choice(wrapper, 'going').trigger('click');
		await settle();
		expect(eventCalls(fetchRef, PUT_RESPONSE).at(-1).json).toEqual({
			membership_id: returned.id,
			choice: 'going',
			expected_version: 0,
		});
	});

	test('answers from a previous membership are not restored after rejoining', async () => {
		const app = await mount('/groups/301/events/701', { viewerId: 7 });
		const { wrapper, backend } = app;
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('true');
		backend.removeMember(301, 7);
		backend.admit(301, 7, []);
		await signal(app.sockets);
		expect(choice(wrapper, 'going').attributes('aria-pressed')).toBe('false');
		expect(textOf(wrapper)).toContain('You haven’t answered yet.');
		expect(textOf(wrapper)).toContain('0 going · 0 not going');
	});

	test('another member’s answer arrives through a signal without a page reload', async () => {
		const app = await mount('/groups/301/events/701', { viewerId: 7 });
		expect(textOf(app.wrapper)).toContain('1 going · 0 not going');
		app.backend.request(10, 'PUT', '/api/v1/groups/301/events/701/response', {
			json: { membership_id: 504, choice: 'going', expected_version: 0 },
		});
		await signal(app.sockets);
		expect(textOf(app.wrapper)).toContain('2 going · 0 not going');
		expect(answers(app.wrapper)).toEqual([
			['7', 'going'],
			['10', 'going'],
		]);
	});

	test('losing membership while the event is open clears it on the next signal', async () => {
		const app = await mount('/groups/301/events/701', { viewerId: 10 });
		expect(textOf(app.wrapper)).toContain('Opening night');
		app.backend.request(42, 'DELETE', '/api/v1/group-memberships/504', {});
		await signal(app.sockets);
		expect(textOf(app.wrapper)).toContain('Only members can see group events.');
		expect(textOf(app.wrapper)).not.toContain('Opening night');
		expect(textOf(app.wrapper)).not.toContain('Bring a board');
		expect(app.wrapper.find('.event-choice').exists()).toBe(false);
		expect(app.wrapper.find('.event-responses').exists()).toBe(false);
	});

	test('account switching never shows the previous member’s event or answer', async () => {
		const app = await mount('/groups/301/events/701', { viewerId: 7 });
		expect(choice(app.wrapper, 'going').attributes('aria-pressed')).toBe('true');
		await switchAccount(app, 99);
		expect(textOf(app.wrapper)).toContain('Only members can see group events.');
		expect(textOf(app.wrapper)).not.toContain('Opening night');
		await switchAccount(app, 42);
		expect(textOf(app.wrapper)).toContain('Opening night');
		expect(choice(app.wrapper, 'going').attributes('aria-pressed')).toBe('false');
	});

	test('an outage on the answers list is retried without leaving stale rows', async () => {
		const app = await mount('/groups/301/events/701', { viewerId: 7 });
		expect(app.wrapper.findAll('.event-responses__item')).toHaveLength(1);
		app.backend.faults.push({ method: 'GET', path: /\/responses$/u, repeat: true });
		await app.social.invalidate();
		await settle();
		expect(textOf(app.wrapper)).toContain('We can’t load the answers right now.');
		expect(app.wrapper.findAll('.event-responses__item')).toHaveLength(0);
		app.backend.faults.length = 0;
		await button(app.wrapper, 'Try again').trigger('click');
		await settle();
		expect(app.wrapper.findAll('.event-responses__item')).toHaveLength(1);
	});
});

describe('SN-A18 scheduling an event', () => {
	const fill = async (wrapper, { title, description, startsAt }) => {
		if (title !== undefined) await wrapper.get('#event-title').setValue(title);
		if (description !== undefined) await wrapper.get('#event-description').setValue(description);
		if (startsAt !== undefined) await wrapper.get('#event-starts-at').setValue(startsAt);
	};
	const submit = async (wrapper) => {
		await wrapper.get('form').trigger('submit');
		await settle();
	};
	const localInstant = (y, m, d, h, min) =>
		new Date(y, m - 1, d, h, min).toISOString().replace(/\.\d{3}Z$/u, 'Z');

	test('invalid input is explained field by field and focus lands on the first problem', async () => {
		const { wrapper, fetchRef } = await mount('/groups/301/events/new', { viewerId: 42 });
		await submit(wrapper);
		expect(document.activeElement?.id).toBe('event-title');
		expect(textOf(wrapper)).toContain('Give the event a title.');
		expect(textOf(wrapper)).toContain('Describe what will happen.');
		expect(textOf(wrapper)).toContain('Choose the day and time.');
		expect(wrapper.get('#event-title').attributes('aria-invalid')).toBe('true');
		await fill(wrapper, { title: 'Rapid night', description: '' });
		await submit(wrapper);
		expect(document.activeElement?.id).toBe('event-description');
		// A date field cannot hold an impossible date, so the only wall time that
		// reaches validation but does not exist is one a clock change skips.
		const zone = process.env.TZ;
		process.env.TZ = 'Europe/Athens';
		await fill(wrapper, { description: 'Blitz games', startsAt: '2026-03-29T03:30' });
		await submit(wrapper);
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
		expect(document.activeElement?.id).toBe('event-starts-at');
		expect(textOf(wrapper)).toContain('Choose a real date and time.');
		await fill(wrapper, { title: 'x'.repeat(101) });
		await submit(wrapper);
		expect(textOf(wrapper)).toContain('Titles can be up to 100 characters.');
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(0);
	});

	test('a valid event is sent once with the member’s generation, then opens as the creator’s event', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 42 });
		const { wrapper, fetchRef, backend, router } = app;
		await fill(wrapper, {
			title: '  Simul night  ',
			description: 'Ten boards\r\nBring a clock',
			startsAt: '2099-11-05T19:30',
		});
		await submit(wrapper);
		const posts = eventCalls(fetchRef, { method: 'POST' });
		expect(posts).toHaveLength(1);
		expect(posts[0].json).toEqual({
			membership_id: 501,
			title: 'Simul night',
			description: 'Ten boards\nBring a clock',
			starts_at: localInstant(2099, 11, 5, 19, 30),
		});
		expect(router.currentRoute.value.fullPath).toBe('/groups/301/events/703');
		expect(wrapper.get('h1').text()).toBe('Simul night');
		expect(textOf(wrapper)).toContain(
			'Simul night is scheduled. Other members have been notified.',
		);
		expect(textOf(wrapper)).toContain('0 going · 0 not going');
		expect(textOf(wrapper)).toContain('You haven’t answered yet.');
		// Every other member got one notice; the creator did not.
		const recipients = [...backend.eventNotices.values()]
			.filter((notice) => notice.event_id === 703)
			.map((notice) => notice.recipient_id)
			.sort((a, b) => a - b);
		expect(recipients).toEqual([7, 10]);
	});

	test('a sole member’s event claims no notifications', async () => {
		// Book Club (302) has only its creator, Robin.
		const { wrapper, backend } = await mount('/groups/302/events/new', { viewerId: 99 });
		await fill(wrapper, {
			title: 'Solo read',
			description: 'Just me',
			startsAt: '2099-11-06T20:00',
		});
		await submit(wrapper);
		expect(textOf(wrapper)).toContain('Solo read is scheduled.');
		expect(textOf(wrapper)).not.toContain('notified');
		expect([...backend.eventNotices.values()].filter((n) => n.event_id === 703)).toHaveLength(0);
	});

	test('a double submit while the first is in flight creates one event', async () => {
		const hold = deferred();
		const { wrapper, fetchRef, backend } = await mount('/groups/301/events/new', {
			viewerId: 7,
			before: async (call) => {
				if (call.method === 'POST') await hold.promise;
			},
		});
		await fill(wrapper, { title: 'Quiz', description: 'Pub quiz', startsAt: '2099-11-06T20:00' });
		await wrapper.get('form').trigger('submit');
		await wrapper.get('form').trigger('submit');
		await settle();
		expect(wrapper.get('button[type="submit"]').attributes('aria-disabled')).toBe('true');
		hold.release();
		await settle();
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(backend.events.size).toBe(3);
	});

	test('a lost response is never resent: the draft is kept and the member checks the list', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 42 });
		const { wrapper, fetchRef, backend } = app;
		backend.faults.push({ method: 'POST', path: /\/events$/u, commit: true });
		await fill(wrapper, { title: 'Lost', description: 'Kept draft', startsAt: '2099-11-07T18:00' });
		await submit(wrapper);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(textOf(wrapper)).toContain('We couldn’t confirm whether the event was created');
		expect(textOf(wrapper)).toContain('nothing was resent');
		expect(wrapper.get('#event-title').element.value).toBe('Lost');
		expect(wrapper.get('#event-description').element.value).toBe('Kept draft');
		expect(backend.events.size).toBe(3);
		expect(document.activeElement?.classList.contains('group-form__summary')).toBe(true);
		expect(wrapper.get('button[type="submit"]').element.disabled).toBe(true);
		// Even an explicit form submit or edited draft cannot replay the write.
		await submit(wrapper);
		await fill(wrapper, { title: 'Edited after uncertainty' });
		await submit(wrapper);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(backend.events.size).toBe(3);
		// The committed event shows once in the list; nothing was duplicated.
		await wrapper.get('.group-form__summary a[href="/groups/301/events"]').trigger('click');
		await settle();
		expect(cardIds(wrapper).filter((id) => id === 703)).toHaveLength(1);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
	});

	test('an unavailable event list does not unlock a remounted creation form', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 42 });
		const { wrapper, backend, router, fetchRef } = app;
		backend.faults.push({ method: 'POST', path: /\/events$/u, commit: true });
		await fill(wrapper, {
			title: 'Uncertain',
			description: 'Check first',
			startsAt: '2099-11-07T18:00',
		});
		await submit(wrapper);
		backend.faults.push({ method: 'GET', path: /\/events(?:\?|$)/u, repeat: true });
		await router.push('/groups/301/events');
		await settle();
		expect(textOf(wrapper)).toContain('We can’t load the events right now.');
		await router.push('/groups/301/events/new');
		await settle();
		await fill(wrapper, {
			title: 'Another',
			description: 'Still blocked',
			startsAt: '2099-11-07T18:00',
		});
		await submit(wrapper);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		backend.faults.length = 0;
		await router.push('/groups/301/events');
		await settle();
		expect(cardIds(wrapper)).toContain(703);
		await router.push('/groups/301/events/new');
		await settle();
		expect(wrapper.get('button[type="submit"]').element.disabled).toBe(false);
		await fill(wrapper, {
			title: 'Deliberate new event',
			description: 'After checking',
			startsAt: '2099-11-08T18:00',
		});
		await submit(wrapper);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(2);
	});

	test.each([
		'/groups/301/events',
		'/groups/302/events/new',
	])('a pending create cannot redirect back after navigating to %s', async (destination) => {
		const hold = deferred();
		const app = await mount('/groups/301/events/new', {
			viewerId: 42,
			before: async (call) => {
				if (call.method === 'POST') await hold.promise;
			},
		});
		await fill(app.wrapper, {
			title: 'Late success',
			description: 'Committed later',
			startsAt: '2099-11-08T18:00',
		});
		await app.wrapper.get('form').trigger('submit');
		await app.router.push(destination);
		await settle();
		hold.release();
		await settle();
		expect(app.backend.events.size).toBe(3);
		expect(app.router.currentRoute.value.fullPath).toBe(destination);
		expect(app.groups.takeFlash('event')).toBe('');
	});

	test('membership loss clears a successful creation confirmation permanently', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 10 });
		await fill(app.wrapper, {
			title: 'Protected title',
			description: 'Members only',
			startsAt: '2099-11-08T18:00',
		});
		await submit(app.wrapper);
		expect(textOf(app.wrapper)).toContain('Protected title is scheduled.');
		app.backend.removeMember(301, 10);
		await signal(app.sockets);
		expect(textOf(app.wrapper)).toContain('Only members can see group events.');
		expect(textOf(app.wrapper)).not.toContain('Protected title');
		app.backend.admit(301, 10, []);
		await signal(app.sockets);
		expect(textOf(app.wrapper)).toContain('Protected title');
		expect(textOf(app.wrapper)).not.toContain('Protected title is scheduled.');
	});

	test('server-side validation is mapped back to the fields', async () => {
		const { wrapper, backend } = await mount('/groups/301/events/new', { viewerId: 42 });
		backend.createEvent = () => ({
			status: 400,
			headers: {},
			body: {
				error: {
					code: 'VALIDATION_ERROR',
					message: 'Validation failed',
					fields: { title: 'TOO_LONG', starts_at: 'INVALID_TIME' },
				},
			},
		});
		await fill(wrapper, { title: 'Fine', description: 'Fine', startsAt: '2099-11-08T18:00' });
		await submit(wrapper);
		expect(textOf(wrapper)).toContain('Titles can be up to 100 characters.');
		expect(textOf(wrapper)).toContain('Choose a real date and time.');
		expect(document.activeElement?.id).toBe('event-title');
		expect(wrapper.get('#event-description').element.value).toBe('Fine');
	});

	test('losing membership while writing closes the form and nothing is scheduled', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 10 });
		const { wrapper, fetchRef, backend } = app;
		await fill(wrapper, { title: 'Draft', description: 'Unsent', startsAt: '2099-11-09T18:00' });
		backend.request(42, 'DELETE', '/api/v1/group-memberships/504', {});
		await signal(app.sockets);
		expect(textOf(wrapper)).toContain('Only members can schedule events.');
		expect(wrapper.find('form').exists()).toBe(false);
		expect(wrapper.find('#event-title').exists()).toBe(false);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(0);
		expect(backend.events.size).toBe(2);
		backend.admit(301, 10, []);
		await signal(app.sockets);
		expect(wrapper.get('#event-title').element.value).toBe('');
		expect(wrapper.get('#event-description').element.value).toBe('');
		expect(wrapper.get('#event-starts-at').element.value).toBe('');
	});

	test('a membership that changed under an open form is refused and nothing is created', async () => {
		const { wrapper, fetchRef, backend } = await mount('/groups/301/events/new', { viewerId: 10 });
		await fill(wrapper, { title: 'Late', description: 'Stale', startsAt: '2099-11-10T18:00' });
		backend.removeMember(301, 10);
		backend.admit(301, 10, []);
		backend.signals.length = 0;
		await submit(wrapper);
		expect(eventCalls(fetchRef, { method: 'POST' })).toHaveLength(1);
		expect(backend.events.size).toBe(2);
		expect(textOf(wrapper)).not.toContain('is scheduled');
	});

	test('a re-read of the group keeps what the member is writing', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 42 });
		await fill(app.wrapper, { title: 'Half written', description: 'Still typing' });
		await signal(app.sockets);
		await app.social.invalidate();
		await settle();
		expect(app.wrapper.get('#event-title').element.value).toBe('Half written');
		expect(app.wrapper.get('#event-description').element.value).toBe('Still typing');
	});

	test('an unsent draft does not carry over to another account', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 42 });
		await fill(app.wrapper, { title: 'Private draft', description: 'Secret' });
		await switchAccount(app, 7);
		expect(app.wrapper.get('#event-title').element.value).toBe('');
		expect(app.wrapper.get('#event-description').element.value).toBe('');
	});
});

describe('SN-A18 event notices', () => {
	const openPanel = async (wrapper) => {
		await wrapper.get('.notification-trigger').trigger('click');
		await settle();
	};

	test('the global panel shows a navigable event notice with no actions and no event text', async () => {
		const app = await mount('/groups/301', { viewerId: 42 });
		await openPanel(app.wrapper);
		const notice = app.wrapper.get('[data-notice-id="810"]');
		expect(notice.text()).toContain('Ada Lovelace');
		expect(notice.text()).toContain('Scheduled an event');
		expect(notice.text()).toContain('See the event in Chess Club');
		expect(notice.text()).not.toContain('Opening night');
		expect(notice.text()).not.toContain('Bring a board');
		expect(notice.findAll('button').map((item) => item.text())).toEqual(['Mark read']);
		expect(notice.get('a.notice__context').attributes('href')).toBe('/groups/301/events/701');
		await notice.get('a.notice__context').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/groups/301/events/701');
		expect(app.wrapper.get('h1').text()).toBe('Opening night');
	});

	test('reading an event notice leaves other notices and the event untouched', async () => {
		const app = await mount('/groups/301', { viewerId: 42 });
		await openPanel(app.wrapper);
		expect(app.wrapper.get('.notification-badge').text()).toBe('2');
		await app.wrapper.get('[data-notice-id="810"] .notice-read').trigger('click');
		await settle();
		expect(app.backend.eventNotices.get(810).is_read).toBe(true);
		expect(app.wrapper.get('.notification-badge').text()).toBe('1');
		expect(app.backend.groupNotices.get(802).is_read).toBe(false);
	});

	test('a new event notifies the other members and loses its notice when membership is lost', async () => {
		const app = await mount('/groups/301/events/new', { viewerId: 42 });
		await app.wrapper.get('#event-title').setValue('Blitz');
		await app.wrapper.get('#event-description').setValue('Fast games');
		await app.wrapper.get('#event-starts-at').setValue('2099-12-01T19:00');
		await app.wrapper.get('form').trigger('submit');
		await settle();
		await switchAccount(app, 10);
		await app.router.push('/groups/301');
		await settle();
		await openPanel(app.wrapper);
		const notices = app.wrapper.findAll('.notice-list [data-notice-id]');
		expect(notices).toHaveLength(1);
		expect(notices[0].text()).toContain('Alex Example');
		expect(notices[0].text()).toContain('Scheduled an event');
		expect(app.wrapper.get('.notification-badge').text()).toBe('1');
		// Removal signals the former member; the notice and its link disappear.
		app.backend.request(42, 'DELETE', '/api/v1/group-memberships/504', {});
		await signal(app.sockets);
		await openPanel(app.wrapper);
		expect(app.wrapper.findAll('[data-notice-id]')).toHaveLength(0);
		expect(app.wrapper.get('.notification-badge').text()).toBe('0');
		expect(app.wrapper.find('a[href^="/groups/301/events/"]').exists()).toBe(false);
	});

	test('a notice for an event that is no longer reachable opens the unavailable state', async () => {
		const app = await mount('/groups/301/events/701', { viewerId: 7 });
		app.backend.events.delete(701);
		await signal(app.sockets);
		expect(textOf(app.wrapper)).toContain('This event isn’t available.');
		expect(textOf(app.wrapper)).not.toContain('Opening night');
		expect(app.wrapper.find('.event-choice').exists()).toBe(false);
	});
});
