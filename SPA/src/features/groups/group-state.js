import { reactive, readonly, watch } from 'vue';

import * as groupsApi from '../../api/groups.js';

export const groupsKey = Symbol('commonplace-groups');

const MESSAGES = {
	'stale-invitation':
		'That invitation is no longer open. It was already answered, cancelled or replaced, so nothing changed. The current state has been reloaded.',
	'stale-request':
		'That join request was already decided or replaced, so nothing changed. The current state has been reloaded.',
	'stale-membership':
		'That membership has already ended, so nothing changed. The current members have been reloaded.',
	'already-member': 'They are already a member of this group.',
	'creator-cannot-leave': 'The creator stays a member while the group exists.',
	'not-found':
		'That group or action is no longer available to you. The current state has been reloaded.',
	rejected: 'That change was rejected. Reload the page and try again.',
	'self-invite': 'You can’t invite yourself.',
	unavailable:
		'We couldn’t confirm that change. Showing what the server reports now; nothing was retried.',
};

// Decisions, departures and removals can add or remove a membership, which
// changes what the viewer may read. Whatever the outcome (an uncertain one may
// have committed; a stale one means someone else changed the group), every
// mounted protected view discards its data before refetching.
const MEMBERSHIP_WRITES = new Set(['decision', 'leave', 'remove']);

export function groupMessage(result) {
	if (result.status === 'rejected' && result.fields?.user_id === 'SELF_INVITE')
		return MESSAGES['self-invite'];
	return MESSAGES[result.status] ?? MESSAGES.unavailable;
}

// Shared group writes for discovery, the group view and notification actions.
// Like the social and content states it keeps no copy of server data: each
// write is guarded against duplicate submission, ignored once the account
// changes, and followed by a refetch so views converge on what the server
// reports. No write is ever replayed automatically.
export function createGroupState({ api = groupsApi, session, social } = {}) {
	const state = reactive({ pending: {}, flash: null });
	let revision = 0;

	function reset() {
		revision += 1;
		state.pending = {};
		state.flash = null;
	}

	if (session) {
		watch(() => session.state.account?.id ?? null, reset, { flush: 'sync' });
	}

	async function run(key, effect, request) {
		if (state.pending[key]) return { status: 'busy', message: '' };
		const startedAt = revision;
		state.pending[key] = true;
		try {
			const result = await request();
			if (revision !== startedAt) return { status: 'superseded', message: '' };
			if (result.status === 'unauthenticated') {
				await social.handleUnauthenticated();
				return { status: 'unauthenticated', message: '' };
			}
			const ok = result.status === 'ok';
			const outcome = { ...result, message: ok ? '' : groupMessage(result) };
			if (MEMBERSHIP_WRITES.has(effect)) await social.invalidate();
			else await social.refresh();
			return revision === startedAt ? outcome : { status: 'superseded', message: '' };
		} finally {
			if (revision === startedAt) delete state.pending[key];
		}
	}

	function isPending(key) {
		return Boolean(state.pending[key]);
	}

	// A one-shot notice for the screen a navigation is heading to, readable
	// only by that route so a briefly remounted view cannot consume it.
	function setFlash(route, message) {
		state.flash = { route, message };
	}

	function takeFlash(route) {
		if (state.flash?.route !== route) return '';
		const { message } = state.flash;
		state.flash = null;
		return message;
	}

	return {
		state: readonly(state),
		api,
		isPending,
		setFlash,
		takeFlash,
		reset,
		createGroup: (fields) => run('create', 'create', () => api.createGroup(fields)),
		requestToJoin: (groupId) => run(`join-${groupId}`, 'request', () => api.requestToJoin(groupId)),
		invite: (groupId, userId) =>
			run(`invite-${groupId}-${userId}`, 'invite', () => api.inviteToGroup(groupId, userId)),
		decideInvitation: (id, decision) =>
			run(`invitation-${id}`, 'decision', () => api.decideInvitation(id, decision)),
		decideJoinRequest: (id, decision) =>
			run(`request-${id}`, 'decision', () => api.decideJoinRequest(id, decision)),
		leave: (membershipId) =>
			run(`membership-${membershipId}`, 'leave', () => api.removeMembership(membershipId)),
		remove: (membershipId) =>
			run(`membership-${membershipId}`, 'remove', () => api.removeMembership(membershipId)),
	};
}
