import { describe, expect, test, vi } from 'vitest';
import { createStore } from '../../../../core/state/store.js';

describe('createStore — Proxy writes (#76)', () => {
	test('a plain assignment through state notifies key subscribers', () => {
		const store = createStore({ count: 0 });
		const listener = vi.fn();
		store.subscribe('count', listener);

		store.state.count = 3;

		expect(store.get('count')).toBe(3);
		expect(listener).toHaveBeenCalledWith(3, 0, 'count');
	});

	test('set(key, value) and a direct assignment are the same write', () => {
		const store = createStore({ count: 0 });
		const listener = vi.fn();
		store.subscribe('count', listener);

		store.set('count', 1);
		store.state.count = 2;

		expect(listener.mock.calls.map(([value]) => value)).toEqual([1, 2]);
	});

	test('writing the same value again notifies nobody', () => {
		const store = createStore({ flag: false });
		const listener = vi.fn();
		store.subscribe('flag', listener);

		store.state.flag = false;
		store.set('flag', false);

		expect(listener).not.toHaveBeenCalled();
	});

	test('deleting a slot notifies with undefined', () => {
		const store = createStore({ token: 'abc' });
		const listener = vi.fn();
		store.subscribe('token', listener);

		delete store.state.token;

		expect(store.get('token')).toBeUndefined();
		expect(listener).toHaveBeenCalledWith(undefined, 'abc', 'token');
	});
});

describe('createStore — subscriptions', () => {
	test('a global subscriber receives a snapshot and the changed keys', () => {
		const store = createStore({ a: 1, b: 2 });
		const listener = vi.fn();
		store.subscribe(listener);

		store.set({ a: 9, b: 8 });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith({ a: 9, b: 8 }, ['a', 'b']);
	});

	test('a patch only reports the keys that actually moved', () => {
		const store = createStore({ a: 1, b: 2 });
		const listener = vi.fn();
		store.subscribe(listener);

		store.set({ a: 1, b: 5 });

		expect(listener).toHaveBeenCalledWith({ a: 1, b: 5 }, ['b']);
	});

	test('unsubscribe stops delivery for that listener only', () => {
		const store = createStore({ a: 0 });
		const stays = vi.fn();
		const goes = vi.fn();
		store.subscribe('a', stays);
		const unsubscribe = store.subscribe('a', goes);

		unsubscribe();
		store.state.a = 1;

		expect(stays).toHaveBeenCalledTimes(1);
		expect(goes).not.toHaveBeenCalled();
	});

	test('a listener that unsubscribes mid-notification does not break the pass', () => {
		const store = createStore({ a: 0 });
		const later = vi.fn();
		const unsubscribeSelf = store.subscribe('a', () => unsubscribeSelf());
		store.subscribe('a', later);

		expect(() => {
			store.state.a = 1;
		}).not.toThrow();
		expect(later).toHaveBeenCalledTimes(1);
	});

	test('subscribe ignores malformed arguments and returns a safe teardown', () => {
		const store = createStore({ a: 0 });
		const unsubscribe = store.subscribe('a', 'not-a-function');

		expect(typeof unsubscribe).toBe('function');
		expect(() => unsubscribe()).not.toThrow();
	});

	test('get() with no key returns a detached snapshot', () => {
		const store = createStore({ a: 1 });
		const snapshot = store.get();

		snapshot.a = 99;

		expect(store.get('a')).toBe(1);
	});

	test('set ignores a non-object patch', () => {
		const store = createStore({ a: 1 });
		const listener = vi.fn();
		store.subscribe(listener);

		store.set(null);
		store.set(42);

		expect(listener).not.toHaveBeenCalled();
		expect(store.get()).toEqual({ a: 1 });
	});
});

describe('createStore — reset', () => {
	test('restores the construction-time values and notifies what moved', () => {
		const store = createStore({ a: 1, b: 2 });
		store.set({ a: 5, b: 2 });

		const listener = vi.fn();
		store.subscribe(listener);
		store.reset();

		expect(store.get()).toEqual({ a: 1, b: 2 });
		expect(listener).toHaveBeenCalledWith({ a: 1, b: 2 }, ['a']);
	});

	test('drops slots that were added after construction', () => {
		const store = createStore({ a: 1 });
		store.set('extra', true);

		store.reset();

		expect(store.get()).toEqual({ a: 1 });
		expect(store.get('extra')).toBeUndefined();
	});

	test('subscribers survive a reset', () => {
		const store = createStore({ a: 1 });
		const listener = vi.fn();
		store.subscribe('a', listener);

		store.reset();
		store.state.a = 7;

		expect(listener).toHaveBeenCalledWith(7, 1, 'a');
	});
});
