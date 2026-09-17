import { describe, expect, test } from 'vitest';
import {
	hasEntry,
	moveToTopForMessage,
	previewForMessage,
	withPresence,
} from '../../../../features/chat/chat.roster.logic.js';

function roster() {
	return [
		{ user_id: 1, username: 'alpha', is_online: false, last_message_preview: 'hi' },
		{ user_id: 2, username: 'beta', is_online: true, last_message_preview: null },
		{ user_id: 3, username: 'gamma', is_online: false, last_message_preview: 'yo' },
	];
}

// Presence itself moved to `core/state/presence.js` (issue #76); what stays
// here is the render-time projection of that store onto the roster rows.
describe('withPresence', () => {
	test('marks is_online true only for ids in the online set', () => {
		const result = withPresence(roster(), new Set([1]));

		expect(result.map((e) => [e.user_id, e.is_online])).toEqual([
			[1, true],
			[2, false],
			[3, false],
		]);
	});

	test('returns a new array and does not mutate the input', () => {
		const entries = roster();
		const result = withPresence(entries, new Set([2]));

		expect(result).not.toBe(entries);
		expect(result[0]).not.toBe(entries[0]);
		expect(entries[1].is_online).toBe(true); // unchanged
	});

	test('a non-Set argument marks everyone offline', () => {
		const result = withPresence(roster(), undefined);
		expect(result.every((e) => e.is_online === false)).toBe(true);
	});

	test('non-array entries returns []', () => {
		expect(withPresence(null, new Set())).toEqual([]);
	});
});

describe('hasEntry (#50)', () => {
	test('is true for a user with a row', () => {
		expect(hasEntry(roster(), 2)).toBe(true);
	});

	test('is false for a user who has no row yet', () => {
		expect(hasEntry(roster(), 999)).toBe(false);
	});

	test('is false for a non-array roster', () => {
		expect(hasEntry(null, 1)).toBe(false);
		expect(hasEntry(undefined, 1)).toBe(false);
	});
});

describe('moveToTopForMessage', () => {
	test('moves the matching entry to the front and updates the preview', () => {
		const result = moveToTopForMessage(roster(), 3, 'new preview');
		expect(result.map((e) => e.user_id)).toEqual([3, 1, 2]);
		expect(result[0].last_message_preview).toBe('new preview');
	});

	test('keeps the existing preview when the new preview is empty', () => {
		const result = moveToTopForMessage(roster(), 3, '');
		expect(result[0].user_id).toBe(3);
		expect(result[0].last_message_preview).toBe('yo');
	});

	test('unknown user returns a no-op copy in original order', () => {
		const entries = roster();
		const result = moveToTopForMessage(entries, 999, 'x');
		expect(result).not.toBe(entries);
		expect(result.map((e) => e.user_id)).toEqual([1, 2, 3]);
	});

	test('does not mutate the input array', () => {
		const entries = roster();
		moveToTopForMessage(entries, 3, 'changed');
		expect(entries.map((e) => e.user_id)).toEqual([1, 2, 3]);
		expect(entries[2].last_message_preview).toBe('yo');
	});

	test('non-array entries returns []', () => {
		expect(moveToTopForMessage(null, 1, 'x')).toEqual([]);
	});
});

describe('previewForMessage (#52)', () => {
	test('uses the trimmed body when present', () => {
		expect(previewForMessage({ body: '  hello  ' })).toBe('hello');
	});

	test('falls back to [image] for an image-only message', () => {
		expect(previewForMessage({ body: '', image_url: '/static/uploads/dm/pic.jpg' })).toBe(
			'[image]',
		);
		expect(previewForMessage({ body: '   ', image_url: '/static/uploads/dm/pic.jpg' })).toBe(
			'[image]',
		);
	});

	test('body wins over an image when both are present', () => {
		expect(previewForMessage({ body: 'caption', image_url: '/static/uploads/dm/pic.jpg' })).toBe(
			'caption',
		);
	});

	test('empty body and no image yields an empty string', () => {
		expect(previewForMessage({ body: '' })).toBe('');
		expect(previewForMessage({})).toBe('');
		expect(previewForMessage(null)).toBe('');
	});
});
