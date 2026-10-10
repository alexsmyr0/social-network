// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { GroupBackend } from '../../../../fixtures/phase4/group-backend.js';
import {
	button,
	cleanupMounted,
	deferred,
	groupCalls,
	hasButton,
	mountGroupApp,
	settle,
	signal,
	textOf,
} from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const ACCEPT_601 = 'Accept invitation to Chess Club from Ada Lovelace';
const feedbackText = (wrapper) => wrapper.get('.group-feedback').text();
const navLinks = (wrapper) =>
	wrapper.findAll('.group-nav a').map((link) => [link.text(), link.attributes('href')]);

async function switchAccount(app, viewerId) {
	app.current.viewerId = viewerId;
	await app.session.restore({ force: true });
	await settle();
}

describe('SN-A15 role-appropriate group controls', () => {
	test.each([
		[99, 'outsider', 'Request to join Chess Club'],
		[10, 'nonmember follower of a member', 'Request to join Chess Club'],
		[12, 'departed member', 'Request to join Chess Club'],
	])('viewer %i (%s) sees public metadata and a join request only', async (viewerId, _role, label) => {
		const { wrapper, fetchRef } = await mountGroupApp('/groups/301', { viewerId });
		expect(textOf(wrapper)).toContain('Chess Club');
		expect(textOf(wrapper)).toContain('Weekly games and tactics.');
		expect(textOf(wrapper)).toContain('Members only see who belongs');
		expect(textOf(wrapper)).not.toMatch(/\d+ members?\b/u);
		expect(hasButton(wrapper, label)).toBe(true);
		expect(navLinks(wrapper)).toEqual([['About', '/groups/301']]);
		expect(wrapper.find('#group-invite-heading').exists()).toBe(false);
		expect(hasButton(wrapper, 'Leave group')).toBe(false);
		expect(groupCalls(fetchRef, { path: /members|join-requests/u })).toHaveLength(0);
	});

	test('a pending invitee and a pending requester see only their own entries', async () => {
		const invitee = await mountGroupApp('/groups/301', { viewerId: 8 });
		expect(hasButton(invitee.wrapper, ACCEPT_601)).toBe(true);
		expect(hasButton(invitee.wrapper, 'Refuse invitation to Chess Club from Ada Lovelace')).toBe(
			true,
		);
		expect(textOf(invitee.wrapper)).not.toMatch(/\d+ members?\b/u);
		cleanupMounted();
		const requester = await mountGroupApp('/groups/301', { viewerId: 9 });
		expect(textOf(requester.wrapper)).toContain('Join request pending');
		expect(hasButton(requester.wrapper, 'Request to join Chess Club')).toBe(false);
	});

	test('an ordinary member may invite and leave but not remove anyone or review requests', async () => {
		const { wrapper, fetchRef, router } = await mountGroupApp('/groups/301', { viewerId: 7 });
		expect(textOf(wrapper)).toContain('2 members');
		expect(navLinks(wrapper)).toEqual([
			['About', '/groups/301'],
			['Members', '/groups/301/members'],
		]);
		expect(hasButton(wrapper, 'Leave group')).toBe(true);
		expect(wrapper.find('#group-invite-heading').exists()).toBe(true);
		await router.push('/groups/301/members');
		await settle();
		expect(wrapper.findAll('[data-membership-id]')).toHaveLength(2);
		expect(wrapper.findAll('[data-membership-id] button')).toHaveLength(0);
		await router.push('/groups/301/requests');
		await settle();
		expect(textOf(wrapper)).toContain('Only the creator reviews join requests.');
		expect(groupCalls(fetchRef, { path: /join-requests/u })).toHaveLength(0);
	});

	test('the creator reviews requests and removes others, but cannot leave or be removed', async () => {
		const { wrapper, router } = await mountGroupApp('/groups/301', { viewerId: 42 });
		expect(navLinks(wrapper)).toEqual([
			['About', '/groups/301'],
			['Members', '/groups/301/members'],
			['Join requests', '/groups/301/requests'],
		]);
		expect(hasButton(wrapper, 'Leave group')).toBe(false);
		expect(textOf(wrapper)).toContain('As the creator you stay a member');
		await router.push('/groups/301/members');
		await settle();
		const ada = wrapper.get('[data-membership-id="502"]');
		expect(ada.attributes('data-access')).toBe('teaser');
		expect(textOf(ada)).toContain('Private profile · name only');
		expect(ada.find('img').exists()).toBe(false);
		expect(hasButton(ada, 'Remove Ada Lovelace from Chess Club')).toBe(true);
		expect(wrapper.get('[data-membership-id="501"]').find('button').exists()).toBe(false);
		await router.push('/groups/301/requests');
		await settle();
		expect(hasButton(wrapper, 'Accept join request from Pat Example')).toBe(true);
	});

	test('unknown or malformed group links show one unavailable state', async () => {
		const { wrapper, router } = await mountGroupApp('/groups/999', { viewerId: 42 });
		expect(textOf(wrapper)).toContain('This group isn’t available.');
		await router.push('/groups/0');
		await settle();
		expect(router.currentRoute.value.name).toBe('not-found');
	});
});

describe('SN-A15 admission journeys', () => {
	test('an invitee accepts once, then sees members without a false success before it commits', async () => {
		const hold = deferred();
		const { wrapper, fetchRef, backend } = await mountGroupApp('/groups/301', {
			viewerId: 8,
			before: async (call) => {
				if (call.method === 'PATCH') await hold.promise;
			},
		});
		await button(wrapper, ACCEPT_601).trigger('click');
		await button(wrapper, ACCEPT_601).trigger('click');
		await settle();
		expect(feedbackText(wrapper)).toBe('');
		expect(button(wrapper, ACCEPT_601).attributes('aria-disabled')).toBe('true');
		hold.release();
		await settle();
		expect(groupCalls(fetchRef, { method: 'PATCH' })).toHaveLength(1);
		expect(feedbackText(wrapper)).toBe('You joined Chess Club.');
		expect(document.activeElement?.classList.contains('group-feedback')).toBe(true);
		expect(textOf(wrapper)).toContain('3 members');
		expect(navLinks(wrapper).map(([label]) => label)).toEqual(['About', 'Members']);
		expect(backend.groupNotices.get(801)).toMatchObject({ state: 'accepted', is_read: true });
	});

	test('a request waits for the creator, who accepts it from the review list', async () => {
		const app = await mountGroupApp('/groups/301', { viewerId: 99 });
		await button(app.wrapper, 'Request to join Chess Club').trigger('click');
		await settle();
		expect(feedbackText(app.wrapper)).toContain('Request sent.');
		expect(textOf(app.wrapper)).toContain('Join request pending');
		await switchAccount(app, 42);
		await app.router.push('/groups/301/requests');
		await settle();
		expect(app.wrapper.findAll('[data-request-id]')).toHaveLength(2);
		await button(app.wrapper, 'Accept join request from Robin Example').trigger('click');
		await settle();
		expect(feedbackText(app.wrapper)).toBe('Robin Example joined Chess Club.');
		expect(
			app.wrapper.findAll('[data-request-id]').map((row) => row.attributes('data-request-id')),
		).toEqual(['701']);
		expect(app.backend.membershipOf(301, 99)).toBeTruthy();
	});

	test('refusal is not a ban: the requester may ask again with a fresh identity', async () => {
		const app = await mountGroupApp('/groups/301/requests', { viewerId: 42 });
		await button(app.wrapper, 'Refuse join request from Pat Example').trigger('click');
		await settle();
		expect(feedbackText(app.wrapper)).toContain('Pat Example’s request was refused.');
		expect(textOf(app.wrapper)).toContain('No one is waiting.');
		await switchAccount(app, 9);
		await app.router.push('/groups/301');
		await settle();
		await button(app.wrapper, 'Request to join Chess Club').trigger('click');
		await settle();
		expect([...app.backend.joinRequests.keys()]).toEqual([702]);
	});
});

describe('SN-A15 departure journeys', () => {
	test('an ordinary member confirms leaving; their invitations are cancelled and lists close', async () => {
		const app = await mountGroupApp('/groups/301', { viewerId: 7 });
		await button(app.wrapper, 'Leave group').trigger('click');
		expect(textOf(app.wrapper)).toContain('any invitations you sent are cancelled');
		await button(app.wrapper, 'Stay in group').trigger('click');
		expect(app.backend.membershipOf(301, 7)).toBeTruthy();
		await button(app.wrapper, 'Leave group').trigger('click');
		await button(app.wrapper, 'Confirm leaving').trigger('click');
		await settle();
		expect(feedbackText(app.wrapper)).toContain('You left Chess Club.');
		expect(hasButton(app.wrapper, 'Request to join Chess Club')).toBe(true);
		expect(app.backend.groupNotices.get(801).state).toBe('cancelled');
		const before = groupCalls(app.fetchRef, { path: /members/u }).length;
		await app.router.push('/groups/301/members');
		await settle();
		expect(textOf(app.wrapper)).toContain('Only members can see who belongs.');
		expect(groupCalls(app.fetchRef, { path: /members/u })).toHaveLength(before);
	});

	test('the creator removes a member, who returns only through a fresh request and membership', async () => {
		const app = await mountGroupApp('/groups/301/members', { viewerId: 42 });
		await button(app.wrapper, 'Remove Ada Lovelace from Chess Club').trigger('click');
		expect(textOf(app.wrapper)).toContain('Remove Ada Lovelace? Their posts stay in the group.');
		await button(app.wrapper, 'Confirm removal').trigger('click');
		await settle();
		expect(feedbackText(app.wrapper)).toContain('Ada Lovelace was removed from Chess Club.');
		expect(app.wrapper.findAll('[data-membership-id]')).toHaveLength(1);
		await switchAccount(app, 7);
		await app.router.push('/groups/301');
		await settle();
		expect(hasButton(app.wrapper, 'Request to join Chess Club')).toBe(true);
		await button(app.wrapper, 'Request to join Chess Club').trigger('click');
		await settle();
		await switchAccount(app, 42);
		await app.router.push('/groups/301/requests');
		await settle();
		await button(app.wrapper, 'Accept join request from Ada Lovelace').trigger('click');
		await settle();
		const membership = app.backend.membershipOf(301, 7);
		expect(membership.id).not.toBe(502);
		// The old generation can never remove the returned member.
		expect(app.backend.request(42, 'DELETE', '/api/v1/group-memberships/502').status).toBe(409);
		expect(app.backend.membershipOf(301, 7)).toBeTruthy();
	});

	test('a removed member returns through a fresh invitation from any current member', async () => {
		const backend = new GroupBackend();
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502');
		backend.request(42, 'POST', '/api/v1/groups/301/invitations', { json: { user_id: 7 } });
		const { wrapper } = await mountGroupApp('/groups/301', { backend, viewerId: 7 });
		await button(wrapper, 'Accept invitation to Chess Club from Alex Example').trigger('click');
		await settle();
		expect(feedbackText(wrapper)).toBe('You joined Chess Club.');
		expect(backend.membershipOf(301, 7).id).toBe(504);
	});
});

describe('SN-A15 stale, simultaneous and uncertain actions', () => {
	test('an invitation cancelled by its inviter leaving cannot show a membership success', async () => {
		const { wrapper, backend, fetchRef } = await mountGroupApp('/groups/301', { viewerId: 8 });
		backend.request(7, 'DELETE', '/api/v1/group-memberships/502');
		await button(wrapper, ACCEPT_601).trigger('click');
		await settle();
		expect(feedbackText(wrapper)).toContain('That invitation is no longer open.');
		expect(feedbackText(wrapper)).not.toContain('joined');
		expect(hasButton(wrapper, ACCEPT_601)).toBe(false);
		expect(hasButton(wrapper, 'Request to join Chess Club')).toBe(true);
		expect(backend.membershipOf(301, 8)).toBeNull();
		expect(groupCalls(fetchRef, { method: 'PATCH' })).toHaveLength(1);
	});

	test('a request admitted by an invitation meanwhile is stale for the creator', async () => {
		const backend = new GroupBackend();
		backend.request(42, 'POST', '/api/v1/groups/301/invitations', { json: { user_id: 9 } });
		const { wrapper } = await mountGroupApp('/groups/301/requests', { backend, viewerId: 42 });
		backend.request(9, 'PATCH', '/api/v1/group-invitations/602', { json: { decision: 'accept' } });
		await button(wrapper, 'Accept join request from Pat Example').trigger('click');
		await settle();
		expect(feedbackText(wrapper)).toContain('That join request was already decided or replaced');
		expect(feedbackText(wrapper)).not.toContain('joined');
		expect(wrapper.findAll('[data-request-id]')).toHaveLength(0);
	});

	test('a member already removed elsewhere is stale, and leave versus removal never double-succeeds', async () => {
		const app = await mountGroupApp('/groups/301/members', { viewerId: 42 });
		app.backend.request(7, 'DELETE', '/api/v1/group-memberships/502');
		await button(app.wrapper, 'Remove Ada Lovelace from Chess Club').trigger('click');
		await button(app.wrapper, 'Confirm removal').trigger('click');
		await settle();
		expect(feedbackText(app.wrapper)).toContain('That membership has already ended');
		expect(app.wrapper.findAll('[data-membership-id]')).toHaveLength(1);
	});

	test('an uncommitted outcome is never retried and only the refetched state is shown', async () => {
		const backend = new GroupBackend();
		backend.faults.push({ method: 'PATCH', path: /group-invitations/u, commit: true });
		const { wrapper, fetchRef } = await mountGroupApp('/groups/301', { backend, viewerId: 8 });
		await button(wrapper, ACCEPT_601).trigger('click');
		await settle();
		expect(feedbackText(wrapper)).toContain('We couldn’t confirm that change.');
		expect(groupCalls(fetchRef, { method: 'PATCH' })).toHaveLength(1);
		// It did commit: the refetch, not the response, shows membership.
		expect(textOf(wrapper)).toContain('You’re a member');
	});

	test('a rejected invitation (already a member, self) is explained per person', async () => {
		const { wrapper, fetchRef } = await mountGroupApp('/groups/301', { viewerId: 7 });
		expect(wrapper.find('[aria-label="Invite Ada Lovelace to Chess Club"]').exists()).toBe(false);
		await button(wrapper, 'Invite Robin Example to Chess Club').trigger('click');
		await settle();
		expect(textOf(wrapper.get('[data-person-id="99"]'))).toContain('Invitation pending for Robin');
		await button(wrapper, 'Invite Robin Example to Chess Club').trigger('click');
		await settle();
		expect(textOf(wrapper.get('[data-person-id="99"]'))).toContain('Invitation pending for Robin');
		await button(wrapper, 'Invite Alex Example to Chess Club').trigger('click');
		await settle();
		expect(textOf(wrapper.get('[data-person-id="42"]'))).toContain(
			'Alex Example is already a member.',
		);
		expect(groupCalls(fetchRef, { method: 'POST' })).toHaveLength(3);
	});
});

describe('SN-A15 notices, signals and session changes', () => {
	async function openNotices(wrapper) {
		await wrapper.get('.notification-trigger').trigger('click');
		await settle();
	}

	test('an invitee answers from the global notice with the exact invitation ID', async () => {
		const { wrapper, fetchRef, backend } = await mountGroupApp('/feed', { viewerId: 8 });
		await openNotices(wrapper);
		const notice = wrapper.get('[data-notice-id="801"]');
		expect(textOf(notice)).toContain('Invited you to join');
		expect(notice.get('a.notice__context').attributes('href')).toBe('/groups/301');
		await button(notice, ACCEPT_601).trigger('click');
		await settle();
		expect(groupCalls(fetchRef, { method: 'PATCH' })[0].url).toBe('/api/v1/group-invitations/601');
		expect(textOf(wrapper.get('#notification-panel'))).toContain('You joined Chess Club.');
		const resolved = wrapper.get('[data-notice-id="801"]');
		expect(textOf(resolved)).toContain('Invitation accepted');
		expect(resolved.find('.notice__actions').exists()).toBe(false);
		expect(backend.membershipOf(301, 8)).toBeTruthy();
	});

	test('the creator decides a join request notice; a stale notice reports the change', async () => {
		const backend = new GroupBackend();
		backend.request(42, 'POST', '/api/v1/groups/301/invitations', { json: { user_id: 9 } });
		const { wrapper } = await mountGroupApp('/feed', { backend, viewerId: 42 });
		await openNotices(wrapper);
		backend.request(9, 'PATCH', '/api/v1/group-invitations/602', { json: { decision: 'accept' } });
		await button(wrapper, 'Accept Pat Example’s request to join Chess Club').trigger('click');
		await settle();
		const panel = textOf(wrapper.get('#notification-panel'));
		expect(panel).toContain('That join request was already decided or replaced');
		expect(panel).toContain('Join request closed · they joined another way');
		expect(panel).not.toContain('Pat Example joined');
	});

	test('ordinary members never get decision controls from notices', async () => {
		const backend = new GroupBackend();
		const { wrapper } = await mountGroupApp('/feed', { backend, viewerId: 7 });
		await openNotices(wrapper);
		expect(wrapper.findAll('[data-notice-id]')).toHaveLength(0);
		expect(hasButton(wrapper, 'Accept Pat Example’s request to join Chess Club')).toBe(false);
	});

	test('a removal signal discards the member list; a reconnect refetches a missed one', async () => {
		const app = await mountGroupApp('/groups/301/members', { viewerId: 7 });
		expect(app.wrapper.findAll('[data-membership-id]')).toHaveLength(2);
		app.backend.request(42, 'DELETE', '/api/v1/group-memberships/502');
		await signal(app.sockets);
		expect(app.wrapper.find('[data-membership-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can see who belongs.');
		// Missed signal: the creator re-admits Ada while the socket is down.
		app.backend.request(42, 'POST', '/api/v1/groups/301/invitations', { json: { user_id: 7 } });
		app.backend.request(7, 'PATCH', '/api/v1/group-invitations/602', {
			json: { decision: 'accept' },
		});
		const socket = app.sockets.at(-1);
		socket.onopen?.();
		await settle();
		expect(app.wrapper.findAll('[data-membership-id]')).toHaveLength(2);
	});

	test('a delayed member list from before removal can never repaint after the signal', async () => {
		const hold = deferred();
		let holdNext = false;
		const app = await mountGroupApp('/groups/301/members', {
			viewerId: 7,
			before: async (call) => {
				if (holdNext && call.url.includes('/members')) {
					holdNext = false;
					await hold.promise;
				}
			},
		});
		holdNext = true;
		void app.social.refresh();
		await settle();
		app.backend.request(42, 'DELETE', '/api/v1/group-memberships/502');
		await signal(app.sockets);
		hold.release();
		await settle();
		expect(app.wrapper.find('[data-membership-id]').exists()).toBe(false);
	});

	test('switching accounts discloses no previous member list or controls', async () => {
		const app = await mountGroupApp('/groups/301/members', { viewerId: 42 });
		expect(app.wrapper.findAll('[data-membership-id]')).toHaveLength(2);
		const before = groupCalls(app.fetchRef, { path: /members/u }).length;
		await switchAccount(app, 99);
		expect(app.wrapper.find('[data-membership-id]').exists()).toBe(false);
		expect(textOf(app.wrapper)).toContain('Only members can see who belongs.');
		expect(textOf(app.wrapper)).not.toContain('Ada Lovelace');
		expect(groupCalls(app.fetchRef, { path: /members/u })).toHaveLength(before);
	});

	test('an expired session during an action returns to sign in without claiming success', async () => {
		const app = await mountGroupApp('/groups/301', { viewerId: 8 });
		app.current.viewerId = null;
		await button(app.wrapper, ACCEPT_601).trigger('click');
		await settle();
		expect(app.router.currentRoute.value.name).toBe('login');
		expect(app.router.currentRoute.value.query.redirect).toBe('/groups/301');
		expect(app.backend.membershipOf(301, 8)).toBeNull();
	});

	test('a group outage keeps members-only details hidden and recovers on retry', async () => {
		const backend = new GroupBackend();
		const app = await mountGroupApp('/groups/301/members', { backend, viewerId: 42 });
		backend.faults.push({ method: 'GET', path: /\/groups\/301$/u, repeat: true });
		await signal(app.sockets);
		expect(textOf(app.wrapper)).toContain('We can’t load this group right now.');
		expect(app.wrapper.find('[data-membership-id]').exists()).toBe(false);
		backend.faults.length = 0;
		await button(app.wrapper, 'Try again').trigger('click');
		await settle();
		expect(app.wrapper.findAll('[data-membership-id]')).toHaveLength(2);
	});
});
