// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';

import { createSessionState } from '../../../../../src/features/auth/session-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
} from '../../../../../src/features/social/social-state.js';
import { useSocialResource } from '../../../../../src/features/social/use-social-resource.js';
import { deferred } from './harness.js';

const probes = [];

afterEach(() => {
	for (const wrapper of probes.splice(0)) wrapper.unmount();
	document.body.innerHTML = '';
	vi.useRealTimers();
});

function fakeApi(overrides = {}) {
	return {
		followUser: vi.fn(async () => ({ status: 'ok' })),
		removeFollow: vi.fn(async () => ({ status: 'ok' })),
		setProfileVisibility: vi.fn(async () => ({ status: 'ok' })),
		...overrides,
	};
}

describe('relationship actions', () => {
	test.each([
		[{ status: 'ok' }, 'changed', ''],
		[{ status: 'stale-follow' }, 'stale', 'changed in the meantime'],
		[{ status: 'not-found' }, 'gone', 'no longer available'],
		[{ status: 'rejected', fields: { user_id: 'SELF_FOLLOW' } }, 'rejected', 'follow yourself'],
		[{ status: 'rejected', fields: {} }, 'rejected', 'was rejected'],
		[{ status: 'unavailable' }, 'unconfirmed', 'couldn’t confirm'],
	])('follow result %j maps to %s', async (result, kind, text) => {
		const api = fakeApi({ followUser: vi.fn(async () => result) });
		const social = createSocialState({ api });
		const outcome = await social.follow(5);
		expect(outcome.kind).toBe(kind);
		expect(social.state.followMessages[5] ?? '').toContain(text);
		expect(social.state.pendingFollows[5]).toBeUndefined();
	});

	test('a self-follow rejection is only special for a new follow', async () => {
		const api = fakeApi({
			removeFollow: vi.fn(async () => ({ status: 'rejected', fields: { user_id: 'SELF_FOLLOW' } })),
		});
		const social = createSocialState({ api });
		await social.unfollow(5, 9);
		expect(social.state.followMessages[5]).toContain('was rejected');
	});

	test('cancel and unfollow delete by follow ID, not by user pair', async () => {
		const api = fakeApi();
		const social = createSocialState({ api });
		await social.cancel(5, 201);
		await social.unfollow(5, 202);
		expect(api.removeFollow.mock.calls).toEqual([[201], [202]]);
		expect(api.followUser).not.toHaveBeenCalled();
	});

	test('a second action for the same person is refused while one is pending', async () => {
		const gate = deferred();
		const api = fakeApi({ followUser: vi.fn(() => gate.promise) });
		const social = createSocialState({ api });
		const first = social.follow(5);
		await nextTick();
		expect(social.state.pendingFollows[5]).toBe(true);
		expect(await social.follow(5)).toEqual({ kind: 'busy' });
		expect(await social.cancel(5, 1)).toEqual({ kind: 'busy' });
		gate.release({ status: 'ok' });
		expect((await first).kind).toBe('changed');
		expect(api.followUser).toHaveBeenCalledTimes(1);
		expect(api.removeFollow).not.toHaveBeenCalled();
	});

	test('every outcome except a 401 refetches registered views, and a 401 clears them', async () => {
		const reload = vi.fn(async () => {});
		const onUnauthenticated = vi.fn();
		const api = fakeApi({
			followUser: vi
				.fn()
				.mockResolvedValueOnce({ status: 'unavailable' })
				.mockResolvedValueOnce({ status: 'unauthenticated' }),
		});
		const social = createSocialState({ api, onUnauthenticated });
		const unregister = social.registerResource({ reload });
		await social.follow(5);
		expect(reload).toHaveBeenLastCalledWith('quiet');

		reload.mockClear();
		expect(await social.follow(5)).toEqual({ kind: 'unauthenticated' });
		expect(reload).toHaveBeenCalledTimes(1);
		expect(reload).toHaveBeenCalledWith('clear');
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
		expect(social.state.pendingFollows).toEqual({});

		unregister();
		reload.mockClear();
		await social.refresh();
		expect(reload).not.toHaveBeenCalled();
	});

	test('a failing view reload does not break the action', async () => {
		const social = createSocialState({ api: fakeApi() });
		social.registerResource({
			reload: async () => {
				throw new Error('boom');
			},
		});
		await expect(social.follow(5)).resolves.toMatchObject({ kind: 'changed' });
	});
});

describe('privacy changes', () => {
	test.each([
		[{ status: 'stale-profile' }, 'stale', 'changed somewhere else', 'quiet'],
		[{ status: 'rejected' }, 'rejected', 'was rejected', 'quiet'],
		[{ status: 'unavailable' }, 'unconfirmed', 'couldn’t confirm', 'quiet'],
		[{ status: 'ok' }, 'changed', '', 'quiet'],
	])('result %j', async (result, kind, text, mode) => {
		const reload = vi.fn(async () => {});
		const api = fakeApi({ setProfileVisibility: vi.fn(async () => result) });
		const social = createSocialState({ api });
		social.registerResource({ reload });
		const outcome = await social.changePrivacy({ visibility: 'private', expectedVersion: 3 });
		expect(outcome.kind).toBe(kind);
		expect(social.state.privacyMessage).toContain(text);
		expect(reload).toHaveBeenCalledWith(mode);
		expect(api.setProfileVisibility).toHaveBeenCalledWith({
			visibility: 'private',
			expectedVersion: 3,
		});
		expect(social.state.privacyPending).toBe(false);
	});

	test('blocks a second submission and handles a revoked session', async () => {
		const gate = deferred();
		const onUnauthenticated = vi.fn();
		const api = fakeApi({ setProfileVisibility: vi.fn(() => gate.promise) });
		const social = createSocialState({ api, onUnauthenticated });
		const first = social.changePrivacy({ visibility: 'public', expectedVersion: 1 });
		expect(await social.changePrivacy({ visibility: 'public', expectedVersion: 1 })).toEqual({
			kind: 'busy',
		});
		gate.release({ status: 'unauthenticated' });
		expect(await first).toEqual({ kind: 'unauthenticated' });
		expect(onUnauthenticated).toHaveBeenCalled();
		expect(social.state.privacyPending).toBe(false);
	});
});

describe('session boundaries', () => {
	test('state is reset whenever the signed-in account changes', async () => {
		const session = createSessionState({
			fetchCurrent: async () => ({ status: 'authenticated', account: { id: 7 } }),
		});
		session.acceptAccount({ id: 7 });
		const api = fakeApi({ followUser: vi.fn(async () => ({ status: 'stale-follow' })) });
		const social = createSocialState({ api, session });
		await social.follow(5);
		expect(social.state.followMessages[5]).toBeTruthy();

		session.acceptAccount({ id: 99 });
		await nextTick();
		expect(social.state.followMessages).toEqual({});
		expect(social.state.pendingFollows).toEqual({});
		expect(social.state.privacyMessage).toBe('');

		await social.follow(5);
		expect(social.state.followMessages[5]).toBeTruthy();
		session.clearAuthenticatedState();
		await nextTick();
		expect(social.state.followMessages).toEqual({});
	});

	test.each([
		'follow',
		'privacy',
	])('%s completions from a previous session cannot affect a pending action', async (kind) => {
		const session = createSessionState();
		session.acceptAccount({ id: 7 });
		const oldResponse = deferred();
		const newResponse = deferred();
		const request = vi
			.fn()
			.mockImplementationOnce(() => oldResponse.promise)
			.mockImplementationOnce(() => newResponse.promise);
		const api = fakeApi(
			kind === 'follow' ? { followUser: request } : { setProfileVisibility: request },
		);
		const social = createSocialState({ api, session });
		const reload = vi.fn(async () => {});
		social.registerResource({ reload });
		const act = () =>
			kind === 'follow'
				? social.follow(42)
				: social.changePrivacy({ visibility: 'public', expectedVersion: 1 });
		const oldAction = act();
		// No nextTick: even logout/login as the same account must invalidate
		// the old action before Vue's usual batched watcher would run.
		session.clearAuthenticatedState();
		session.acceptAccount({ id: 7 });
		const newAction = act();
		oldResponse.release({ status: 'unavailable' });
		expect(await oldAction).toEqual({ kind: 'superseded' });
		expect(social.state.followMessages).toEqual(kind === 'follow' ? { 42: '' } : {});
		expect(social.state.privacyMessage).toBe('');
		expect(reload).not.toHaveBeenCalled();
		expect(await act()).toEqual({ kind: 'busy' });
		expect(request).toHaveBeenCalledTimes(2);
		newResponse.release({ status: 'ok' });
		expect(await newAction).toEqual({ kind: 'changed', message: '' });
	});

	test.each(['follow', 'privacy'])('old %s 401 cannot reset the new session', async (kind) => {
		const session = createSessionState();
		session.acceptAccount({ id: 7 });
		const response = deferred();
		const request = vi.fn(() => response.promise);
		const api = fakeApi(
			kind === 'follow' ? { followUser: request } : { setProfileVisibility: request },
		);
		const onUnauthenticated = vi.fn();
		const social = createSocialState({ api, session, onUnauthenticated });
		const oldAction =
			kind === 'follow'
				? social.follow(42)
				: social.changePrivacy({ visibility: 'public', expectedVersion: 1 });
		session.clearAuthenticatedState();
		session.acceptAccount({ id: 99 });
		response.release({ status: 'unauthenticated' });
		expect(await oldAction).toEqual({ kind: 'superseded' });
		expect(onUnauthenticated).not.toHaveBeenCalled();
		expect(session.state.account.id).toBe(99);
	});

	test('an unconfirmed 401 reloads views instead of leaving them on a spinner', async () => {
		const session = createSessionState({
			fetchCurrent: async () => ({ status: 'authenticated', account: { id: 7 } }),
		});
		await session.restore();
		const api = fakeApi({ followUser: vi.fn(async () => ({ status: 'unauthenticated' })) });
		const social = createSocialState({ api, session });
		const reload = vi.fn(async () => {});
		social.registerResource({ reload });
		await social.follow(5);
		expect(reload.mock.calls.map(([mode]) => mode)).toEqual(['clear', 'hard']);
	});

	test('only a confirmed unauthenticated session redirects to sign in', async () => {
		const replace = vi.fn(async () => {});
		const router = { replace, currentRoute: { value: { fullPath: '/people?q=a' } } };

		const gone = createSessionState({ fetchCurrent: async () => ({ status: 'unauthenticated' }) });
		await createUnauthenticatedHandler({ session: gone, router })();
		expect(replace).toHaveBeenCalledWith({ name: 'login', query: { redirect: '/people?q=a' } });

		replace.mockClear();
		const outage = createSessionState({ fetchCurrent: async () => ({ status: 'unavailable' }) });
		await createUnauthenticatedHandler({ session: outage, router })();
		expect(replace).not.toHaveBeenCalled();

		const valid = createSessionState({
			fetchCurrent: async () => ({ status: 'authenticated', account: { id: 7 } }),
		});
		await createUnauthenticatedHandler({ session: valid, router })();
		expect(replace).not.toHaveBeenCalled();
	});
});

describe('useSocialResource', () => {
	function mountResource(load, social, sources) {
		let exposed;
		const Probe = defineComponent({
			setup() {
				exposed = useSocialResource(load, { social, sources });
				return () => h('p', exposed.status.value);
			},
		});
		const wrapper = mount(Probe, { attachTo: document.body });
		probes.push(wrapper);
		return {
			wrapper,
			get resource() {
				return exposed;
			},
		};
	}

	test('keeps only the newest response and clears data on failure', async () => {
		const social = createSocialState({ api: fakeApi() });
		const first = deferred();
		const second = deferred();
		const queue = [first, second];
		const load = vi.fn(() => queue.shift().promise);
		const harness = mountResource(load, social);
		await flushPromises();

		void harness.resource.reload('hard');
		await flushPromises();
		second.release({ status: 'ok', value: 'new' });
		await flushPromises();
		first.release({ status: 'ok', value: 'old' });
		await flushPromises();
		expect(harness.resource.result.value.value).toBe('new');
		expect(harness.resource.status.value).toBe('ready');

		load.mockResolvedValueOnce({ status: 'unavailable' });
		await harness.resource.reload('quiet');
		expect(harness.resource.result.value).toBeNull();
		expect(harness.resource.status.value).toBe('unavailable');

		load.mockResolvedValueOnce({ status: 'rejected', fields: { q: 'TOO_LONG' } });
		await harness.resource.reload('quiet');
		expect(harness.resource.status.value).toBe('rejected');
		expect(harness.resource.failure.value.fields.q).toBe('TOO_LONG');
	});

	test('quiet reloads keep data on screen while loading; hard reloads do not', async () => {
		const social = createSocialState({ api: fakeApi() });
		const load = vi.fn(async () => ({ status: 'ok', value: 1 }));
		const harness = mountResource(load, social);
		await flushPromises();
		const gate = deferred();
		load.mockImplementationOnce(() => gate.promise);
		const quiet = harness.resource.reload('quiet');
		await flushPromises();
		expect(harness.resource.status.value).toBe('ready');
		gate.release({ status: 'ok', value: 2 });
		await quiet;
		expect(harness.resource.result.value.value).toBe(2);

		const gate2 = deferred();
		load.mockImplementationOnce(() => gate2.promise);
		const hard = harness.resource.reload('hard');
		await flushPromises();
		expect(harness.resource.status.value).toBe('loading');
		expect(harness.resource.result.value).toBeNull();
		gate2.release({ status: 'ok', value: 3 });
		await hard;
		expect(harness.resource.result.value.value).toBe(3);
	});

	test('a stronger mode wins when requests coalesce', async () => {
		const social = createSocialState({ api: fakeApi() });
		const load = vi.fn(async () => ({ status: 'ok', value: 1 }));
		const harness = mountResource(load, social);
		await flushPromises();
		load.mockClear();
		const gate = deferred();
		load.mockImplementationOnce(() => gate.promise);
		const calls = [
			harness.resource.reload('quiet'),
			harness.resource.reload('hard'),
			harness.resource.reload('quiet'),
		];
		await flushPromises();
		expect(harness.resource.status.value).toBe('loading');
		expect(load).toHaveBeenCalledTimes(1);
		gate.release({ status: 'ok', value: 9 });
		await Promise.all(calls);
	});

	test('reacts to changed sources and cleans up on unmount', async () => {
		const social = createSocialState({ api: fakeApi() });
		const reload = vi.spyOn(social, 'registerResource');
		const load = vi.fn(async () => ({ status: 'ok', value: 1 }));
		const { ref } = await import('vue');
		const source = ref(1);
		const harness = mountResource(load, social, () => source.value);
		await flushPromises();
		load.mockClear();
		source.value = 2;
		await flushPromises();
		expect(load).toHaveBeenCalledTimes(1);

		const removeSpy = vi.spyOn(window, 'removeEventListener');
		harness.wrapper.unmount();
		expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
		load.mockClear();
		window.dispatchEvent(new Event('focus'));
		await social.refresh();
		await flushPromises();
		expect(load).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalled();
	});

	test('an unauthenticated read clears the view and hands off to the session handler', async () => {
		const onUnauthenticated = vi.fn();
		const social = createSocialState({ api: fakeApi(), onUnauthenticated });
		const load = vi.fn(async () => ({ status: 'unauthenticated' }));
		const harness = mountResource(load, social);
		await flushPromises();
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
		expect(harness.resource.result.value).toBeNull();
		expect(harness.resource.status.value).toBe('loading');
	});

	test('a clear is never upgraded into a refetch by a same-tick quiet reload', async () => {
		const social = createSocialState({ api: fakeApi() });
		const load = vi.fn(async () => ({ status: 'ok', value: 1 }));
		const harness = mountResource(load, social);
		await flushPromises();
		load.mockClear();
		const calls = [harness.resource.reload('clear'), harness.resource.reload('quiet')];
		await Promise.all(calls);
		expect(load).not.toHaveBeenCalled();
		expect(harness.resource.status.value).toBe('loading');
	});

	test('hidden windows do not trigger focus or fallback reloads', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const social = createSocialState({ api: fakeApi() });
		const load = vi.fn(async () => ({ status: 'ok', value: 1 }));
		mountResource(load, social);
		await flushPromises();
		load.mockClear();
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		window.dispatchEvent(new Event('focus'));
		vi.advanceTimersByTime(60000);
		await flushPromises();
		expect(load).not.toHaveBeenCalled();
		visibility.mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		await flushPromises();
		expect(load).toHaveBeenCalledTimes(1);
	});
});
