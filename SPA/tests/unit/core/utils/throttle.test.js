import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { throttle } from '../../../../core/utils/throttle.js';

describe('throttle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('invokes immediately on the leading edge', () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 100);
		throttled();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	test('collapses a burst of calls into a single leading invocation', () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 100);
		for (let i = 0; i < 10; i += 1) {
			throttled();
		}
		expect(fn).toHaveBeenCalledTimes(1);
	});

	test('replays the latest trailing call after the cooldown', () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 100);
		throttled('a');
		throttled('b');
		throttled('c');
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenLastCalledWith('a');

		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenLastCalledWith('c');
	});

	test('does not fire a trailing call when no calls arrive during cooldown', () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 100);
		throttled();
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	test('cancel clears any pending trailing call', () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 100);
		throttled('a');
		throttled('b');
		throttled.cancel();
		vi.advanceTimersByTime(500);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
