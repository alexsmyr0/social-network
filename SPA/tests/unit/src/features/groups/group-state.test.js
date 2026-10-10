import { describe, expect, test, vi } from 'vitest';
import { nextTick, reactive } from 'vue';

import { createGroupState, groupMessage } from '../../../../../src/features/groups/group-state.js';

function setup(overrides = {}) {
	const session = { state: reactive({ account: { id: 8 } }) };
	const social = {
		refresh: vi.fn(async () => {}),
		invalidate: vi.fn(async () => {}),
		handleUnauthenticated: vi.fn(async () => {}),
	};
	let release;
	const api = {
		decideInvitation: vi.fn(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		),
		inviteToGroup: vi.fn(async () => ({ status: 'ok' })),
		requestToJoin: vi.fn(async () => ({ status: 'already-member' })),
		removeMembership: vi.fn(async () => ({ status: 'stale-membership' })),
		createGroup: vi.fn(async () => ({ status: 'unavailable' })),
		...overrides,
	};
	const groups = createGroupState({ api, session, social });
	return { groups, social, session, api, release: (value) => release(value) };
}

describe('shared group writes', () => {
	test('one pending decision per entry; repeats are busy and never sent', async () => {
		const { groups, api, release, social } = setup();
		const first = groups.decideInvitation(601, 'accept');
		expect(groups.isPending('invitation-601')).toBe(true);
		expect(await groups.decideInvitation(601, 'refuse')).toMatchObject({ status: 'busy' });
		release({ status: 'ok', membership: { id: 504 } });
		expect(await first).toMatchObject({ status: 'ok', message: '' });
		expect(api.decideInvitation).toHaveBeenCalledTimes(1);
		expect(social.invalidate).toHaveBeenCalledTimes(1);
		expect(groups.isPending('invitation-601')).toBe(false);
	});

	test('a response for a previous account is superseded and reports nothing', async () => {
		const { groups, session, release, social } = setup();
		const pending = groups.decideInvitation(601, 'accept');
		session.state.account = { id: 99 };
		await nextTick();
		release({ status: 'ok' });
		expect(await pending).toEqual({ status: 'superseded', message: '' });
		expect(social.invalidate).not.toHaveBeenCalled();
		expect(groups.isPending('invitation-601')).toBe(false);
	});

	test('membership-affecting outcomes discard views; entry creation refreshes quietly', async () => {
		const { groups, social } = setup();
		expect((await groups.leave(502)).message).toContain('already ended');
		expect(social.invalidate).toHaveBeenCalledTimes(1);
		expect((await groups.invite(301, 99)).status).toBe('ok');
		expect((await groups.requestToJoin(301)).message).toContain('already a member');
		expect((await groups.createGroup({ title: 't', description: 'd' })).message).toContain(
			'couldn’t confirm',
		);
		expect(social.refresh).toHaveBeenCalledTimes(3);
		expect(social.invalidate).toHaveBeenCalledTimes(1);
	});

	test('a 401 hands over to the session handler without any message', async () => {
		const { groups, social } = setup({
			removeMembership: vi.fn(async () => ({ status: 'unauthenticated' })),
		});
		expect(await groups.remove(502)).toEqual({ status: 'unauthenticated', message: '' });
		expect(social.handleUnauthenticated).toHaveBeenCalledTimes(1);
		expect(social.invalidate).not.toHaveBeenCalled();
	});

	test('every outcome has a specific, non-success explanation', () => {
		for (const status of [
			'stale-invitation',
			'stale-request',
			'stale-membership',
			'already-member',
			'creator-cannot-leave',
			'not-found',
			'unavailable',
		])
			expect(groupMessage({ status })).not.toMatch(/joined|success/iu);
		expect(groupMessage({ status: 'rejected', fields: { user_id: 'SELF_INVITE' } })).toBe(
			'You can’t invite yourself.',
		);
		expect(groupMessage({ status: 'mystery' })).toContain('couldn’t confirm');
	});

	test('a flash is read once, only by its route', () => {
		const { groups } = setup();
		groups.setFlash('group', 'Ready');
		expect(groups.takeFlash('groups')).toBe('');
		expect(groups.takeFlash('group')).toBe('Ready');
		expect(groups.takeFlash('group')).toBe('');
	});
});
