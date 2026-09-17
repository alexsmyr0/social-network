import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetAppState } from '../../../../core/state/app-state.js';
import {
	clearSession,
	ensureCurrentUserId,
	getCurrentUserId,
	isAuthenticated,
	setAuthenticated,
	subscribeAuth,
} from '../../../../core/state/session.js';

beforeEach(() => {
	resetAppState();
});

function meFetch(id, { ok = true } = {}) {
	return vi.fn(async () => ({ ok, status: ok ? 200 : 401, json: async () => ({ data: { id } }) }));
}

describe('session auth flag (#76)', () => {
	test('starts unauthenticated and follows setAuthenticated', () => {
		expect(isAuthenticated()).toBe(false);

		setAuthenticated(true);
		expect(isAuthenticated()).toBe(true);

		setAuthenticated(false);
		expect(isAuthenticated()).toBe(false);
	});

	test('coerces truthy/falsy inputs to a boolean slot', () => {
		setAuthenticated('yes');
		expect(isAuthenticated()).toBe(true);

		setAuthenticated(0);
		expect(isAuthenticated()).toBe(false);
	});

	test('subscribers are notified when the flag flips', () => {
		const listener = vi.fn();
		subscribeAuth(listener);

		setAuthenticated(true);

		expect(listener).toHaveBeenCalledWith(true, false, 'isAuthenticated');
	});
});

describe('ensureCurrentUserId (#76)', () => {
	test('resolves once and caches the id for later callers', async () => {
		const fetchRef = meFetch(42);

		expect(await ensureCurrentUserId(fetchRef)).toBe(42);
		expect(await ensureCurrentUserId(fetchRef)).toBe(42);

		expect(fetchRef).toHaveBeenCalledTimes(1);
		expect(getCurrentUserId()).toBe(42);
	});

	test('concurrent callers share a single in-flight request', async () => {
		const fetchRef = meFetch(7);

		const [first, second] = await Promise.all([
			ensureCurrentUserId(fetchRef),
			ensureCurrentUserId(fetchRef),
		]);

		expect(first).toBe(7);
		expect(second).toBe(7);
		expect(fetchRef).toHaveBeenCalledTimes(1);
	});

	test('a failed lookup is not cached, so the next caller retries', async () => {
		const failing = meFetch(0, { ok: false });
		expect(await ensureCurrentUserId(failing)).toBeNull();
		expect(getCurrentUserId()).toBe(0);

		const succeeding = meFetch(5);
		expect(await ensureCurrentUserId(succeeding)).toBe(5);
		expect(getCurrentUserId()).toBe(5);
	});
});

describe('clearSession (#76)', () => {
	test('drops the identity and the auth flag together', async () => {
		setAuthenticated(true);
		await ensureCurrentUserId(meFetch(11));

		clearSession();

		expect(isAuthenticated()).toBe(false);
		expect(getCurrentUserId()).toBe(0);
	});

	test('a later lookup re-resolves rather than reusing the cleared id', async () => {
		await ensureCurrentUserId(meFetch(11));
		clearSession();

		const fetchRef = meFetch(12);
		expect(await ensureCurrentUserId(fetchRef)).toBe(12);
		expect(fetchRef).toHaveBeenCalledTimes(1);
	});
});
