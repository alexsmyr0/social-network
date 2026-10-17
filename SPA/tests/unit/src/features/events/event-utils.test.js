import { afterEach, describe, expect, test } from 'vitest';

import {
	countsLabel,
	eventFieldMessage,
	eventFieldProblem,
	eventTimeLabel,
	isPastEvent,
	startsAtProblem,
} from '../../../../../src/features/events/event-utils.js';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
	if (ORIGINAL_TZ === undefined) delete process.env.TZ;
	else process.env.TZ = ORIGINAL_TZ;
});

describe('SN-A18 event text rules mirror the contract', () => {
	test.each([
		['title', '', 'REQUIRED'],
		['title', '   \r\n ', 'REQUIRED'],
		['title', 'x'.repeat(101), 'TOO_LONG'],
		['title', 'a\nb', 'INVALID_TEXT'],
		['title', 'tab\there', 'INVALID_TEXT'],
		['title', 'x'.repeat(100), null],
		['title', '🎉'.repeat(100), null],
		['title', '🎉'.repeat(101), 'TOO_LONG'],
		['description', 'Line one\r\nLine two\tend', null],
		['description', 'bell\u0007', 'INVALID_TEXT'],
		['description', 'x'.repeat(1001), 'TOO_LONG'],
		['description', 'x'.repeat(1000), null],
	])('%s text %#', (field, value, problem) => {
		expect(eventFieldProblem(field, value)).toBe(problem);
	});

	test('every problem has a plain message and an unknown code falls back', () => {
		for (const [field, code] of [
			['title', 'REQUIRED'],
			['title', 'TOO_LONG'],
			['title', 'INVALID_TEXT'],
			['description', 'REQUIRED'],
			['description', 'TOO_LONG'],
			['description', 'INVALID_TEXT'],
			['starts_at', 'REQUIRED'],
			['starts_at', 'INVALID_TIME'],
		])
			expect(eventFieldMessage(field, code)).not.toBe('');
		expect(eventFieldMessage('title', null)).toBe('');
		expect(eventFieldMessage('title', 'WEIRD')).toBe('Check this field and try again.');
	});
});

describe('SN-A18 event time is an absolute instant read in the viewer’s zone', () => {
	test('a wall time becomes whole-second UTC in the viewer’s zone', () => {
		process.env.TZ = 'Europe/Athens';
		expect(startsAtProblem('2026-10-16T20:00')).toEqual({
			problem: null,
			instant: '2026-10-16T17:00:00Z',
		});
		expect(startsAtProblem('2026-01-16T20:00:30')).toEqual({
			problem: null,
			instant: '2026-01-16T18:00:30Z',
		});
		process.env.TZ = 'America/New_York';
		expect(startsAtProblem('2026-10-16T20:00').instant).toBe('2026-10-17T00:00:00Z');
	});

	test.each([
		['', 'REQUIRED'],
		['   ', 'REQUIRED'],
		['tomorrow', 'INVALID_TIME'],
		['2026-02-30T12:00', 'INVALID_TIME'],
		['2026-13-01T12:00', 'INVALID_TIME'],
		['2026-10-16T24:00', 'INVALID_TIME'],
		['2026-10-16T18:00:00.5', 'INVALID_TIME'],
		['10000-01-01T00:00', 'INVALID_TIME'],
		['0000-01-01T00:00', 'INVALID_TIME'],
	])('time input %j is refused', (value, problem) => {
		expect(startsAtProblem(value).problem).toBe(problem);
	});

	test('a time the zone skips at a clock change is refused, not moved', () => {
		process.env.TZ = 'Europe/Athens';
		// Clocks go from 03:00 to 04:00 on 2026-03-29.
		expect(startsAtProblem('2026-03-29T03:30').problem).toBe('INVALID_TIME');
		expect(startsAtProblem('2026-03-29T04:30').problem).toBeNull();
	});

	test('the same instant reads differently per zone and always names the zone', () => {
		const athens = eventTimeLabel('2026-10-16T17:00:00Z', { timeZone: 'Europe/Athens' });
		const newYork = eventTimeLabel('2026-10-16T17:00:00Z', { timeZone: 'America/New_York' });
		expect(athens).toContain('Friday');
		expect(athens).toContain('16 October 2026');
		expect(athens).toContain('20:00');
		expect(newYork).toContain('13:00');
		expect(athens).not.toBe(newYork);
		expect(athens).toMatch(/GMT|UTC|EEST/u);
		expect(eventTimeLabel('nonsense')).toBe('');
	});

	test('past events are labelled against the supplied clock', () => {
		const now = Date.parse('2026-10-16T12:00:00Z');
		expect(isPastEvent('2026-10-16T11:59:59Z', now)).toBe(true);
		expect(isPastEvent('2026-10-16T12:00:01Z', now)).toBe(false);
		expect(isPastEvent('nonsense', now)).toBe(false);
	});

	test('counts read as one line', () => {
		expect(countsLabel({ going: 2, not_going: 0 })).toBe('2 going · 0 not going');
	});
});
