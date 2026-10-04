import { isValidId } from '../../api/social.js';

export const SEARCH_MAX_LENGTH = 100;
const MAX_PAGE = 1000000;
const CONTROL_CHARACTERS = /\p{Cc}/u;

// Route params arrive as strings. Only canonical positive decimal IDs name a
// user; "007", "1e3" and values beyond JavaScript's exact range are missing.
export function parseUserId(value) {
	if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
	const id = Number(value);
	return isValidId(id) ? id : null;
}

export function parsePage(value) {
	const text = Array.isArray(value) ? value[0] : value;
	if (typeof text !== 'string' || !/^[1-9]\d*$/u.test(text)) return 1;
	const page = Number(text);
	return page <= MAX_PAGE ? page : 1;
}

export function readSearchQuery(value) {
	const text = Array.isArray(value) ? value[0] : value;
	return typeof text === 'string' ? text : '';
}

// Mirrors the contract's `q` rules so the common mistakes are caught before a
// request: surrounding whitespace is trimmed, the limit counts code points,
// and control characters are refused rather than silently removed.
export function validateSearch(text) {
	const value = text.trim();
	if ([...value].length > SEARCH_MAX_LENGTH) {
		return { value, error: `Search must be ${SEARCH_MAX_LENGTH} characters or fewer.` };
	}
	if (CONTROL_CHARACTERS.test(value)) {
		return { value, error: 'Search can’t contain control characters.' };
	}
	return { value, error: '' };
}

export function initialsOf(name) {
	const words = name.trim().split(/\s+/u).filter(Boolean);
	if (words.length === 0) return '?';
	const first = [...words[0]][0];
	const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
	return `${first}${last}`.toUpperCase();
}

export function formatBirthDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? '')) return value ?? '';
	const date = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(date);
}

export function countLabel(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}
