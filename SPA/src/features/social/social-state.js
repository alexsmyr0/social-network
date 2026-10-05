import { reactive, readonly, watch } from 'vue';

import * as socialApi from '../../api/social.js';

export const socialKey = Symbol('commonplace-social');

const FOLLOW_MESSAGES = {
	stale:
		'This relationship changed in the meantime, so we reloaded it. Check the current state before trying again.',
	gone: 'That person is no longer available.',
	self: 'You can’t follow yourself.',
	rejected: 'That request was rejected. Reload the page and try again.',
	unconfirmed:
		'We couldn’t confirm that change. Showing what the server reports now; nothing was retried.',
};

const PRIVACY_MESSAGES = {
	stale:
		'Your privacy setting was changed somewhere else. We reloaded it; review it before saving again.',
	rejected: 'That privacy change was rejected. Reload the page and try again.',
	unconfirmed:
		'We couldn’t confirm that privacy change. Showing what the server reports now; nothing was retried.',
};

// Shared relationship and privacy actions for the people, profile and (A10)
// notification surfaces. The state keeps no copy of server data: every
// successful or uncertain write triggers a refetch of the registered views, so
// controls converge on what the server reports instead of an optimistic guess.
export function createSocialState({ api = socialApi, session, onUnauthenticated = () => {} } = {}) {
	const state = reactive({
		pendingFollows: {},
		followMessages: {},
		privacyPending: false,
		privacyMessage: '',
	});
	const resources = new Set();
	let revision = 0;

	function registerResource(resource) {
		resources.add(resource);
		return () => resources.delete(resource);
	}

	async function reloadAll(mode) {
		await Promise.allSettled([...resources].map((resource) => resource.reload(mode)));
	}

	// Quiet reads preserve focus when access is unchanged. Hard reads discard
	// data when signals or relationship removal may have revoked access.
	const refresh = () => reloadAll('quiet');
	const invalidate = () => reloadAll('hard');

	function reset() {
		revision += 1;
		state.pendingFollows = {};
		state.followMessages = {};
		state.privacyPending = false;
		state.privacyMessage = '';
	}

	async function handleUnauthenticated() {
		reset();
		await reloadAll('clear');
		await onUnauthenticated();
		// A 401 the session endpoint does not confirm (transient, or refreshed
		// in another tab) must not strand views on a spinner: read again.
		if (session && session.state.status !== 'unauthenticated') await reloadAll('hard');
	}

	if (session) {
		// Observe logout/login immediately, including a same-account login in
		// one tick, so old writes cannot affect the next session.
		watch(() => session.state.account?.id ?? null, reset, { flush: 'sync' });
	}

	function followOutcome(result, subject) {
		if (result.status === 'ok') return { kind: 'changed', message: '' };
		if (result.status === 'stale-follow') return { kind: 'stale', message: FOLLOW_MESSAGES.stale };
		if (result.status === 'not-found') return { kind: 'gone', message: FOLLOW_MESSAGES.gone };
		if (result.status === 'rejected') {
			const self = result.fields?.user_id === 'SELF_FOLLOW' && subject === 'follow';
			return { kind: 'rejected', message: self ? FOLLOW_MESSAGES.self : FOLLOW_MESSAGES.rejected };
		}
		return { kind: 'unconfirmed', message: FOLLOW_MESSAGES.unconfirmed };
	}

	async function runFollowAction(userId, subject, request) {
		if (state.pendingFollows[userId]) return { kind: 'busy' };
		const startedAt = revision;
		state.pendingFollows[userId] = true;
		state.followMessages[userId] = '';
		try {
			const result = await request();
			if (revision !== startedAt) return { kind: 'superseded' };
			if (result.status === 'unauthenticated') {
				await handleUnauthenticated();
				return { kind: 'unauthenticated' };
			}
			const outcome = followOutcome(result, subject);
			if (outcome.message) state.followMessages[userId] = outcome.message;
			// Every non-401 outcome, including a lost response, re-reads current
			// state. Unfollow may revoke private-profile access even when the
			// response is lost; discard cached details before revalidation.
			// Old creation requests are never replayed automatically.
			if (subject === 'unfollow') await invalidate();
			else await refresh();
			return revision === startedAt ? outcome : { kind: 'superseded' };
		} finally {
			if (revision === startedAt) delete state.pendingFollows[userId];
		}
	}

	const follow = (userId) => runFollowAction(userId, 'follow', () => api.followUser(userId));
	const cancel = (userId, followId) =>
		runFollowAction(userId, 'cancel', () => api.removeFollow(followId));
	const decideRequest = (userId, followId, decision) =>
		runFollowAction(userId, 'decision', () => api.decideFollowRequest(followId, decision));
	const unfollow = (userId, followId) =>
		runFollowAction(userId, 'unfollow', () => api.removeFollow(followId));

	function privacyOutcome(result) {
		if (result.status === 'ok') return { kind: 'changed', message: '' };
		if (result.status === 'stale-profile')
			return { kind: 'stale', message: PRIVACY_MESSAGES.stale };
		if (result.status === 'rejected') {
			return { kind: 'rejected', message: PRIVACY_MESSAGES.rejected };
		}
		return { kind: 'unconfirmed', message: PRIVACY_MESSAGES.unconfirmed };
	}

	async function changePrivacy({ visibility, expectedVersion }) {
		if (state.privacyPending) return { kind: 'busy' };
		const startedAt = revision;
		state.privacyPending = true;
		state.privacyMessage = '';
		try {
			const result = await api.setProfileVisibility({ visibility, expectedVersion });
			if (revision !== startedAt) return { kind: 'superseded' };
			if (result.status === 'unauthenticated') {
				await handleUnauthenticated();
				return { kind: 'unauthenticated' };
			}
			const outcome = privacyOutcome(result);
			state.privacyMessage = outcome.message;
			// Counts and access depend on the switch, so views re-read instead of
			// patching; quietly, to keep the owner's focus and place on the page.
			await refresh();
			return revision === startedAt ? outcome : { kind: 'superseded' };
		} finally {
			if (revision === startedAt) state.privacyPending = false;
		}
	}

	return {
		state: readonly(state),
		api,
		registerResource,
		refresh,
		invalidate,
		reset,
		handleUnauthenticated,
		follow,
		cancel,
		unfollow,
		decideRequest,
		changePrivacy,
	};
}

// A 401 from a social read/write is confirmed against the session endpoint
// before leaving: only a real "unauthenticated" answer redirects to sign in,
// while an outage keeps the app's private-by-default gate.
export function createUnauthenticatedHandler({ session, router }) {
	return async () => {
		await session.restore({ force: true });
		if (session.state.status !== 'unauthenticated') return;
		await router.replace({
			name: 'login',
			query: { redirect: router.currentRoute.value.fullPath },
		});
	};
}
