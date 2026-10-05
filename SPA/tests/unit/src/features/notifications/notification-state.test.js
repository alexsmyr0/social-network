// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createSessionState } from '../../../../../src/features/auth/session-state.js';
import { createNotificationState } from '../../../../../src/features/notifications/notification-state.js';
import { createSocialState } from '../../../../../src/features/social/social-state.js';
import { createFixtureFetch, FixtureBackend } from '../../../../fixtures/phase2/fixture-backend.js';
import { deferred } from '../social/harness.js';

const retained = [];
afterEach(() => {
	for (const dispose of retained.splice(0)) dispose();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
function setup({ before, socketThrows = false, viewerId = 42 } = {}) {
	const backend = new FixtureBackend();
	backend.request(7, 'POST', '/api/v1/follows', { json: { user_id: 42 } });
	const viewer = { id: viewerId };
	const fetchRef = createFixtureFetch(backend, { viewer: () => viewer.id, before });
	vi.stubGlobal('fetch', fetchRef);
	const session = createSessionState();
	session.acceptAccount(backend.account(backend.user(viewerId)));
	const social = createSocialState({
		session,
		onUnauthenticated: () => session.restore({ force: true }),
	});
	const sockets = [];
	const factory = vi.fn((url) => {
		if (socketThrows) throw new Error('connection unavailable');
		const socket = {
			url,
			close: vi.fn(),
			emit: (type) => socket.onmessage?.({ data: JSON.stringify({ type }) }),
		};
		sockets.push(socket);
		return socket;
	});
	const notifications = createNotificationState({
		session,
		social,
		socketFactory: factory,
		location: { href: 'https://example.test/people' },
	});
	retained.push(notifications.dispose);
	return { backend, viewer, session, social, sockets, factory, notifications, fetchRef };
}
const reads = (fetchRef) =>
	fetchRef.calls.filter(
		(call) => call.url.startsWith('/api/v1/notifications') && call.method === 'GET',
	);

describe('session-owned notifications and realtime recovery', () => {
	test('initial read and first connection reconcile persistent notices without opening a second socket', async () => {
		const { notifications, sockets, factory } = setup();
		await flushPromises();
		expect(notifications.state.unreadCount).toBe(1);
		expect(sockets[0].url).toBe('wss://example.test/ws');
		sockets[0].onopen();
		await flushPromises();
		expect(notifications.state.connection).toBe('online');
		expect(factory).toHaveBeenCalledTimes(1);
	});

	test('route session rechecks retain the same socket', async () => {
		const { session, sockets, factory } = setup();
		await flushPromises();
		await session.restore({ force: true });
		expect(factory).toHaveBeenCalledTimes(1);
		expect(sockets[0].close).not.toHaveBeenCalled();
	});

	test('reconnect recovers a missed decision and resumes subsequent signals', async () => {
		vi.useFakeTimers();
		const { backend, notifications, sockets } = setup();
		await flushPromises();
		sockets[0].onclose();
		backend.request(42, 'PATCH', '/api/v1/follow-requests/201', { json: { decision: 'accept' } });
		await vi.advanceTimersByTimeAsync(1000);
		expect(sockets).toHaveLength(2);
		sockets[1].onopen();
		await flushPromises();
		expect(notifications.state.unreadCount).toBe(0);
		expect(notifications.state.requests).toEqual([]);
		expect(notifications.state.notifications[0].target.state).toBe('accepted');
		backend.request(7, 'DELETE', '/api/v1/follows/201');
		sockets[1].emit('social.invalidate');
		await flushPromises();
		expect(notifications.state.notifications[0].target.state).toBe('unfollowed');
	});

	test('signal bursts coalesce and discard the displayed protected state synchronously', async () => {
		const { notifications, sockets, fetchRef } = setup();
		await flushPromises();
		const count = reads(fetchRef).length;
		for (let i = 0; i < 5; i += 1)
			sockets[0].emit(i % 2 ? 'social.invalidate' : 'notification.new');
		expect(notifications.state.notifications).toEqual([]);
		expect(notifications.state.unreadCount).toBeNull();
		await flushPromises();
		expect(reads(fetchRef)).toHaveLength(count + 1);
		expect(notifications.state.notifications).toHaveLength(1);
	});

	test('a response predating invalidation cannot overwrite the current authorized list', async () => {
		const { notifications, sockets, social } = setup();
		await flushPromises();
		const held = deferred();
		const old = {
			status: 'ok',
			notifications: [{ id: 900, actor: { display_name: 'obsolete' } }],
			unreadCount: 99,
			pagination: {},
		};
		vi.spyOn(social.api, 'fetchNotifications').mockImplementationOnce(() => held.promise);
		void notifications.reload('quiet');
		await flushPromises();
		sockets[0].emit('social.invalidate');
		await flushPromises();
		held.release(old);
		await flushPromises();
		expect(notifications.state.unreadCount).toBe(1);
		expect(notifications.state.notifications[0].id).toBe(501);
		vi.restoreAllMocks();
	});

	test('logout cancels reconnect, clears all data and ignores retained socket callbacks', async () => {
		vi.useFakeTimers();
		const { notifications, session, sockets, factory } = setup();
		await flushPromises();
		const oldSignal = sockets[0].onmessage;
		sockets[0].onclose();
		session.clearAuthenticatedState();
		oldSignal({ data: '{"type":"notification.new"}' });
		await vi.advanceTimersByTimeAsync(60000);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(notifications.state.notifications).toEqual([]);
		expect(notifications.state.requests).toEqual([]);
		expect(notifications.state.unreadCount).toBeNull();
	});

	test('account switching discards previous reads and delayed writes', async () => {
		const { session, notifications, viewer, backend, sockets, social } = setup();
		await flushPromises();
		const held = deferred();
		vi.spyOn(social.api, 'markNotificationRead').mockImplementationOnce(() => held.promise);
		const pending = notifications.markRead(501);
		viewer.id = 99;
		session.acceptAccount(backend.account(backend.user(99)));
		await flushPromises();
		held.release({ status: 'unavailable' });
		await pending;
		expect(sockets[0].close).toHaveBeenCalledTimes(1);
		expect(sockets).toHaveLength(2);
		expect(notifications.state.notifications).toEqual([]);
		expect(notifications.state.unreadCount).toBe(0);
		expect(notifications.state.message).toBe('');
		vi.restoreAllMocks();
	});

	test('duplicate read controls cannot issue repeated writes or a concurrent read-all', async () => {
		const held = deferred();
		const { notifications, fetchRef } = setup({
			before: (call) => (call.method === 'PATCH' ? held.promise : undefined),
		});
		await flushPromises();
		const pending = notifications.markRead(501);
		await notifications.markRead(501);
		await notifications.markRead();
		expect(fetchRef.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
		held.release();
		await pending;
		expect(notifications.state.unreadCount).toBe(0);
		expect(notifications.state.requests).toHaveLength(1);
	});

	test('a lost read write is reconciled without automatic replay', async () => {
		const { notifications, fetchRef } = setup({
			before: (call) => {
				if (call.method === 'PATCH') throw new Error('lost response');
			},
		});
		await flushPromises();
		await notifications.markRead(501);
		expect(notifications.state.message).toContain('couldn’t confirm');
		expect(notifications.state.unreadCount).toBe(1);
		expect(fetchRef.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
	});

	test('401 clears socket and confirms the session; network failure clears notices without false logout', async () => {
		const { notifications, viewer, sockets, session } = setup();
		await flushPromises();
		viewer.id = null;
		await notifications.reload();
		expect(session.state.status).toBe('unauthenticated');
		expect(sockets[0].close).toHaveBeenCalled();
		expect(notifications.state.notifications).toEqual([]);
	});

	test('outage and manual retry preserve session identity and recover notices', async () => {
		let offline = false;
		const { notifications, session } = setup({
			before: () => {
				if (offline) throw new Error('offline');
			},
		});
		await flushPromises();
		offline = true;
		await notifications.reload();
		expect(notifications.state.status).toBe('unavailable');
		expect(notifications.state.notifications).toEqual([]);
		expect(session.state.status).toBe('authenticated');
		offline = false;
		await notifications.reload();
		expect(notifications.state.unreadCount).toBe(1);
	});

	test('60-second fallback and focus recover missed signals only while visible', async () => {
		vi.useFakeTimers();
		const { notifications, backend, fetchRef } = setup();
		await flushPromises();
		backend.request(42, 'PATCH', '/api/v1/follow-requests/201', { json: { decision: 'decline' } });
		await vi.advanceTimersByTimeAsync(60000);
		expect(notifications.state.notifications[0].target.state).toBe('declined');
		const count = reads(fetchRef).length;
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		window.dispatchEvent(new Event('focus'));
		await vi.advanceTimersByTimeAsync(60000);
		expect(reads(fetchRef)).toHaveLength(count);
		vi.restoreAllMocks();
		window.dispatchEvent(new Event('focus'));
		await flushPromises();
		expect(reads(fetchRef)).toHaveLength(count + 1);
	});

	test('invalid and unrelated message frames do not refetch or show payloads', async () => {
		const { sockets, fetchRef } = setup();
		await flushPromises();
		const count = reads(fetchRef).length;
		sockets[0].onmessage({ data: 'not json' });
		sockets[0].onmessage({ data: 'null' });
		sockets[0].emit('chat.message');
		await flushPromises();
		expect(reads(fetchRef)).toHaveLength(count);
	});

	test('a constructor failure retries with bounded backoff and disposal cancels timers', async () => {
		vi.useFakeTimers();
		const { notifications, factory } = setup({ socketThrows: true });
		await flushPromises();
		await vi.advanceTimersByTimeAsync(1000);
		expect(factory).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(factory).toHaveBeenCalledTimes(3);
		notifications.dispose();
		await vi.advanceTimersByTimeAsync(120000);
		expect(factory).toHaveBeenCalledTimes(3);
	});

	test('a privacy switch automatically accepts requests and read controls converge across sessions', async () => {
		const { notifications, sockets, backend } = setup();
		await flushPromises();
		backend.request(42, 'PATCH', '/api/v1/users/me/privacy', {
			json: { visibility: 'public', expected_version: 1 },
		});
		sockets[0].emit('social.invalidate');
		await flushPromises();
		expect(notifications.state.requests).toEqual([]);
		expect(notifications.state.notifications[0].actions).toEqual([]);
		expect(notifications.state.notifications[0].is_read).toBe(true);
	});
});

test('401 with a still-valid session settles as unavailable instead of a recursive refetch loop', async () => {
	const { notifications, social, session, sockets } = setup();
	await flushPromises();
	const read = vi
		.spyOn(social.api, 'fetchNotifications')
		.mockResolvedValue({ status: 'unauthenticated' });
	await notifications.reload();
	expect(session.state.status).toBe('authenticated');
	expect(notifications.state.status).toBe('unavailable');
	expect(read).toHaveBeenCalledTimes(2);
	expect(sockets).toHaveLength(1);
	expect(sockets[0].close).toHaveBeenCalled();
	read.mockRestore();
	await notifications.reload();
	expect(notifications.state.unreadCount).toBe(1);
});

test('a 401 from any social view closes the shared socket before session confirmation', async () => {
	const { social, notifications, session, sockets } = setup();
	await flushPromises();
	const held = deferred();
	const restore = vi.spyOn(session, 'restore').mockImplementationOnce(() => held.promise);
	const pending = social.handleUnauthenticated();
	await flushPromises();
	expect(sockets[0].close).toHaveBeenCalledTimes(1);
	expect(notifications.state.notifications).toEqual([]);
	held.release('authenticated');
	await pending;
	expect(sockets).toHaveLength(2);
	restore.mockRestore();
});

test('disposal during 401 session confirmation cannot restart a fallback timer', async () => {
	vi.useFakeTimers();
	const { notifications, social, session } = setup();
	await flushPromises();
	const held = deferred();
	const restore = vi.spyOn(session, 'restore').mockImplementationOnce(() => held.promise);
	const read = vi
		.spyOn(social.api, 'fetchNotifications')
		.mockResolvedValueOnce({ status: 'unauthenticated' });
	const pending = notifications.reload();
	await flushPromises();
	notifications.dispose();
	held.release('authenticated');
	await pending;
	expect(vi.getTimerCount()).toBe(0);
	read.mockRestore();
	restore.mockRestore();
});
