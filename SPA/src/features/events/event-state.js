import { reactive, readonly, watch } from 'vue';

import * as eventsApi from '../../api/events.js';

export const eventsKey = Symbol('commonplace-events');

const MESSAGES = {
	'stale-response':
		'Your answer changed somewhere else, so nothing was saved. The current answer has been reloaded; choose again if you still want to change it.',
	'stale-membership':
		'Your membership in this group changed, so nothing was saved. Showing what the group allows now.',
	'not-found':
		'That event or group is no longer available to you, so nothing was saved. The current state has been reloaded.',
	rejected: 'That change was rejected. Reload the page and try again.',
	unavailable:
		'We couldn’t confirm that change. Showing what the server reports now; nothing was retried.',
};

// A stale or missing membership changes what the viewer may read, so every
// mounted protected view discards its data before refetching. Anything else
// refetches quietly to keep the member's place and focus.
const PERMISSION_LOSS = new Set(['stale-membership', 'not-found']);

export function eventMessage(result) {
	return MESSAGES[result.status] ?? MESSAGES.unavailable;
}

// Shared event writes for the creation form and the response control. Like the
// group and social states it keeps no copy of server data: each write is
// guarded against duplicate submission, ignored once the account changes, and
// followed by a refetch so views converge on what the server reports. No write
// is ever replayed automatically.
export function createEventState({ api = eventsApi, session, social } = {}) {
	const state = reactive({ pending: {} });
	let revision = 0;

	function reset() {
		revision += 1;
		state.pending = {};
	}

	if (session) {
		watch(() => session.state.account?.id ?? null, reset, { flush: 'sync' });
	}

	async function run(key, request) {
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
			const outcome = { ...result, message: ok ? '' : eventMessage(result) };
			if (PERMISSION_LOSS.has(result.status)) await social.invalidate();
			else await social.refresh();
			return revision === startedAt ? outcome : { status: 'superseded', message: '' };
		} finally {
			if (revision === startedAt) delete state.pending[key];
		}
	}

	function isPending(key) {
		return Boolean(state.pending[key]);
	}

	return {
		state: readonly(state),
		api,
		isPending,
		reset,
		create: (groupId, fields) => run(`create-${groupId}`, () => api.createEvent(groupId, fields)),
		respond: (groupId, eventId, fields) =>
			run(`respond-${eventId}`, () => api.respondToEvent(groupId, eventId, fields)),
	};
}
