import { beforeEach, describe, expect, test, vi } from 'vitest';
import { WS_EVENTS } from '../../../../core/realtime/chat-socket.js';
import { resetAppState } from '../../../../core/state/app-state.js';
import {
	applyPresenceSnapshot,
	ensurePresenceBridge,
	getOnlineUserIds,
	isUserOnline,
	seedPresenceFromRoster,
	setUserPresence,
	subscribePresence,
} from '../../../../core/state/presence.js';

beforeEach(() => {
	resetAppState();
});

function createDocumentRef() {
	const listeners = new Map();
	return {
		addEventListener(type, handler) {
			if (!listeners.has(type)) {
				listeners.set(type, []);
			}
			listeners.get(type).push(handler);
		},
		dispatch(type, event) {
			for (const handler of listeners.get(type) ?? []) {
				handler(event);
			}
		},
		listenerCount(type) {
			return (listeners.get(type) ?? []).length;
		},
	};
}

describe('setUserPresence (#76)', () => {
	test('adds and removes a single user', () => {
		setUserPresence(3, true);
		expect(isUserOnline(3)).toBe(true);

		setUserPresence(3, false);
		expect(isUserOnline(3)).toBe(false);
	});

	test('replaces the Set rather than mutating it, so the store sees a change', () => {
		const before = getOnlineUserIds();
		setUserPresence(3, true);

		expect(getOnlineUserIds()).not.toBe(before);
		expect(before.has(3)).toBe(false);
	});

	test('a repeated frame writes nothing and wakes nobody', () => {
		setUserPresence(3, true);
		const listener = vi.fn();
		subscribePresence(listener);

		setUserPresence(3, true);

		expect(listener).not.toHaveBeenCalled();
	});

	test('ignores non-positive ids', () => {
		setUserPresence(0, true);
		setUserPresence(-1, true);
		setUserPresence(undefined, true);

		expect(getOnlineUserIds().size).toBe(0);
		expect(isUserOnline(0)).toBe(false);
	});
});

describe('applyPresenceSnapshot (#76)', () => {
	test('replaces the whole set — anyone absent becomes offline', () => {
		setUserPresence(1, true);
		applyPresenceSnapshot([{ user_id: 2, is_online: true }]);

		expect(isUserOnline(1)).toBe(false);
		expect(isUserOnline(2)).toBe(true);
	});

	test('entries flagged offline are excluded', () => {
		applyPresenceSnapshot([
			{ user_id: 1, is_online: true },
			{ user_id: 2, is_online: false },
		]);

		expect([...getOnlineUserIds()]).toEqual([1]);
	});

	test('a non-array payload empties presence', () => {
		setUserPresence(1, true);
		applyPresenceSnapshot(undefined);

		expect(getOnlineUserIds().size).toBe(0);
	});

	test('an equivalent snapshot does not wake subscribers', () => {
		applyPresenceSnapshot([{ user_id: 1, is_online: true }]);
		const listener = vi.fn();
		subscribePresence(listener);

		applyPresenceSnapshot([{ user_id: 1, is_online: true }]);

		expect(listener).not.toHaveBeenCalled();
	});
});

describe('seedPresenceFromRoster (#76)', () => {
	test('merges the REST roster is_online flags into the store', () => {
		seedPresenceFromRoster([
			{ user_id: 1, is_online: true },
			{ user_id: 2, is_online: false },
		]);

		expect(isUserOnline(1)).toBe(true);
		expect(isUserOnline(2)).toBe(false);
	});

	test('an all-offline roster leaves an empty set and wakes nobody', () => {
		const listener = vi.fn();
		subscribePresence(listener);

		seedPresenceFromRoster([{ user_id: 1, is_online: false }]);

		expect(getOnlineUserIds().size).toBe(0);
		expect(listener).not.toHaveBeenCalled();
	});

	test('an empty roster is a no-op', () => {
		setUserPresence(1, true);
		seedPresenceFromRoster([]);

		expect(isUserOnline(1)).toBe(true);
	});

	test('a snapshot wins: the REST payload is stale once the socket has spoken', () => {
		// The GET /chats response reflects the registry at query time. If a
		// snapshot has already landed saying user 1 is gone, the older payload
		// must not resurrect them.
		applyPresenceSnapshot([]);
		seedPresenceFromRoster([{ user_id: 1, is_online: true }]);

		expect(isUserOnline(1)).toBe(false);
	});

	test('it still seeds when no snapshot has arrived yet', () => {
		seedPresenceFromRoster([{ user_id: 1, is_online: true }]);

		expect(isUserOnline(1)).toBe(true);
	});
});

describe('ensurePresenceBridge (#76)', () => {
	test('pipes presence.snapshot and presence.update frames into the store', () => {
		const documentRef = createDocumentRef();
		ensurePresenceBridge(documentRef);

		documentRef.dispatch(WS_EVENTS.PRESENCE_SNAPSHOT, {
			detail: { users: [{ user_id: 4, is_online: true }] },
		});
		expect(isUserOnline(4)).toBe(true);

		documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {
			detail: { userId: 4, isOnline: false },
		});
		expect(isUserOnline(4)).toBe(false);
	});

	test('binds a document once so both chat slices can call it', () => {
		const documentRef = createDocumentRef();

		expect(ensurePresenceBridge(documentRef)).toBe(true);
		expect(ensurePresenceBridge(documentRef)).toBe(false);
		expect(documentRef.listenerCount(WS_EVENTS.PRESENCE_UPDATE)).toBe(1);
	});

	test('a presence.update without a detail is ignored', () => {
		const documentRef = createDocumentRef();
		ensurePresenceBridge(documentRef);

		expect(() => documentRef.dispatch(WS_EVENTS.PRESENCE_UPDATE, {})).not.toThrow();
		expect(getOnlineUserIds().size).toBe(0);
	});

	test('returns false for a documentRef that cannot listen', () => {
		expect(ensurePresenceBridge(null)).toBe(false);
		expect(ensurePresenceBridge({})).toBe(false);
	});
});
