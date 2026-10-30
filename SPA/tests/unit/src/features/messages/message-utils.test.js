import { describe, expect, test } from 'vitest';

import {
	bodyLength,
	bodyMessage,
	bodyProblem,
	EMOJI,
	imageProblem,
	lastId,
	MESSAGE_MAX,
	mergeMessages,
	newClientId,
	normalizeBody,
	previewLabel,
	roomKey,
	roomPreview,
	timeLabel,
} from '../../../../../src/features/messages/message-utils.js';

describe('message text', () => {
	test('normalizes CRLF and surrounding whitespace like the server', () => {
		expect(normalizeBody(' \r\nHi\r\nthere\r\n ')).toBe('Hi\nthere');
		expect(normalizeBody(undefined)).toBe('');
	});

	test('counts Unicode code points, not UTF-16 units or bytes', () => {
		expect(bodyLength('😀')).toBe(1);
		expect(bodyLength('👩🏽‍💻')).toBe(4);
		expect(bodyProblem('😀'.repeat(MESSAGE_MAX))).toBeNull();
		expect(bodyProblem('😀'.repeat(MESSAGE_MAX + 1))).toBe('TOO_LONG');
		// Surrounding whitespace does not count against the limit.
		expect(bodyProblem(` ${'a'.repeat(MESSAGE_MAX)} `)).toBeNull();
	});

	test('allows newline and tab, refuses other control characters and lone surrogates', () => {
		expect(bodyProblem('a\nb\tc')).toBeNull();
		expect(bodyProblem('a\u0007b')).toBe('INVALID_TEXT');
		expect(bodyProblem('a\u0000b')).toBe('INVALID_TEXT');
		expect(bodyProblem('a\u001bb')).toBe('INVALID_TEXT');
		expect(bodyProblem('a\ud800b')).toBe('INVALID_TEXT');
		expect(bodyProblem('')).toBeNull();
		expect(bodyMessage('TOO_LONG')).toContain('2,000');
		expect(bodyMessage(null)).toBe('');
	});
});

describe('retry nonces', () => {
	test('are lowercase canonical v4 UUIDs, from randomUUID or the fallback', () => {
		const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
		expect(newClientId({ randomUUID: () => 'ABCDEF12-1234-4ABC-8ABC-ABCDEF123456' })).toBe(
			'abcdef12-1234-4abc-8abc-abcdef123456',
		);
		const fallback = new Set();
		for (let index = 0; index < 50; index += 1) {
			const id = newClientId({
				getRandomValues: (bytes) => {
					for (let at = 0; at < bytes.length; at += 1) bytes[at] = (index * 31 + at * 7) % 256;
					return bytes;
				},
			});
			expect(id).toMatch(V4);
			fallback.add(id);
		}
		expect(fallback.size).toBe(50);
		expect(newClientId({})).toMatch(V4);
		expect(newClientId()).toMatch(V4);
	});
});

describe('message merging', () => {
	const m = (id, extra = {}) => ({ id, body: `m${id}`, ...extra });

	test('is ascending by ID, deduplicated, and keeps arrival order out of it', () => {
		const merged = mergeMessages([m(1), m(3)], [m(5), m(2), m(3), m(4)]);
		expect(merged.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
	});

	test('returns the same array when nothing new arrived, and replaces a known message', () => {
		const existing = [m(1), m(2)];
		expect(mergeMessages(existing, [m(2)])).toBe(existing);
		expect(mergeMessages(existing, [])).toBe(existing);
		const replaced = mergeMessages(existing, [m(2, { body: 'new' })]);
		expect(replaced).toBe(existing);
		expect(lastId([])).toBe(0);
		expect(lastId([m(4), m(9)])).toBe(9);
	});
});

describe('labels and images', () => {
	test('previews, times and image checks', () => {
		expect(previewLabel('[image]')).toBe('Image');
		expect(previewLabel('hello')).toBe('hello');
		const now = Date.parse('2026-10-15T12:00:00Z');
		expect(timeLabel('2026-10-15T09:05:00Z', { now, timeZone: 'UTC' })).toMatch(/^0?9:05/u);
		expect(timeLabel('2026-10-14T09:05:00Z', { now, timeZone: 'UTC' })).toMatch(/14/u);
		expect(timeLabel('nonsense')).toBe('');
		expect(imageProblem(null)).toBe('REQUIRED');
		expect(imageProblem({ type: 'image/webp', size: 1 })).toBe('TYPE');
		expect(imageProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toBe('TOO_LARGE');
		expect(imageProblem({ type: 'image/gif', size: 10 * 1024 * 1024 })).toBeNull();
	});

	test('the emoji set is plain Unicode with an accessible name for each', () => {
		expect(new Set(EMOJI.map(([glyph]) => glyph)).size).toBe(EMOJI.length);
		for (const [glyph, name] of EMOJI) {
			expect(glyph.length).toBeGreaterThan(0);
			expect(name).toMatch(/^[A-Z]/u);
		}
	});
});

describe('group rooms', () => {
	test('a room key can never equal a conversation key', () => {
		expect(roomKey(301)).toBe('room-301');
		expect(String(42)).not.toBe(roomKey(42));
	});

	test('the room preview names who wrote last and shortens long text', () => {
		const room = (last) => ({ last_message: last });
		expect(roomPreview(room(null), 42)).toBe('No messages yet.');
		const written = (sender_id, body) => ({ sender_id, sender_username: 'Lee Example', body });
		expect(roomPreview(room(written(10, 'I do ♟️')), 42)).toBe('Lee Example: I do ♟️');
		expect(roomPreview(room(written(42, 'mine')), 42)).toBe('You: mine');
		const long = roomPreview(room(written(10, '😀'.repeat(500))), 42);
		expect([...long]).toHaveLength('Lee Example: '.length + 200);
	});
});
