import { parsePage, parseUserId } from '../social/social-utils.js';

export const TITLE_MAX = 200;
export const BODY_MAX = 10000;
export const CATEGORY_MAX = 50;
export const SELECTION_MAX = 500;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif']);

// The contract allows newline and tab in bodies and no control characters in
// titles. A lone carriage return is still rejected after CRLF normalization.
const CONTROL = /\p{Cc}/u;

export const AUDIENCE_LABELS = Object.freeze({
	public: 'Public',
	followers: 'Followers',
	selected: 'Selected followers',
});

export const STATUS_LABELS = Object.freeze({
	published: 'Published',
	draft: 'Draft',
	archived: 'Archived',
});

// Mirrors server normalization: CRLF becomes LF, then surrounding Unicode
// whitespace is trimmed. Lengths count code points of the normalized text.
export function normalizeText(value) {
	return (value ?? '').replace(/\r\n/gu, '\n').trim();
}

export function codePoints(value) {
	return [...normalizeText(value)].length;
}

export function normalizeTitle(value) {
	const title = normalizeText(value);
	return title === '' ? null : title;
}

const TEXT_MESSAGES = {
	title: {
		TOO_LONG: `Titles can be up to ${TITLE_MAX} characters.`,
		INVALID_TEXT: 'Titles can’t contain line breaks or control characters.',
	},
	body: {
		TOO_LONG: `Posts can be up to ${BODY_MAX.toLocaleString('en-GB')} characters.`,
		INVALID_TEXT: 'Remove the hidden control characters from your text.',
	},
};

export function textProblem(field, value) {
	const text = normalizeText(value);
	const max = field === 'title' ? TITLE_MAX : BODY_MAX;
	if ([...text].length > max) return 'TOO_LONG';
	const checked = field === 'title' ? text : text.replace(/[\n\t]/gu, '');
	if (CONTROL.test(checked)) return 'INVALID_TEXT';
	return null;
}

const FIELD_MESSAGES = {
	CONTENT_REQUIRED: 'Write something or add an image before publishing.',
	INVALID_IDS: 'That selection isn’t valid. Review it and try again.',
	TOO_MANY: 'That selection is too large.',
	INVALID_CATEGORY: 'One of those categories is no longer available. Review the list.',
	INVALID_AUDIENCE: 'Choose Public, Followers or Selected followers.',
	INVALID_SELECTION:
		'Some selected people can’t receive this post. They may no longer follow you — review the recipients.',
	INVALID_STATUS: 'That publication status isn’t available.',
	INVALID_IMAGE: 'That image couldn’t be used. Choose a valid JPEG, PNG or GIF.',
};

export function fieldMessage(field, code) {
	return TEXT_MESSAGES[field]?.[code] ?? FIELD_MESSAGES[code] ?? 'Check this field and try again.';
}

export function imageProblem(file) {
	if (!IMAGE_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or GIF image.';
	if (file.size > IMAGE_MAX_BYTES) return 'Images can be up to 5 MiB.';
	return '';
}

// Route state for feeds. Anything outside the canonical form (unknown keys,
// repeated or malformed values) is recovered to the nearest valid filters.
export function readFeedQuery(query) {
	const single = (value) => (Array.isArray(value) ? value[0] : value);
	return {
		feed: single(query.feed) === 'following' ? 'following' : 'all',
		categoryId: parseUserId(single(query.category)),
		page: parsePage(query.page),
	};
}

export function feedQuery({ feed, categoryId, page }) {
	const next = {};
	if (feed === 'following') next.feed = 'following';
	if (categoryId) next.category = String(categoryId);
	if (page > 1) next.page = String(page);
	return next;
}

export function readStatusQuery(value) {
	const text = Array.isArray(value) ? value[0] : value;
	return text === 'published' || text === 'draft' ? text : 'all';
}

export function sameQuery(a, b) {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((key) => a[key] === b[key]);
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC',
});

export function formatPostDate(value) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : `${DATE_FORMAT.format(date)} UTC`;
}

export function sortedIds(ids) {
	return [...new Set(ids)].sort((a, b) => a - b);
}

export function sameIds(a, b) {
	const left = sortedIds(a);
	const right = sortedIds(b);
	return left.length === right.length && left.every((id, index) => id === right[index]);
}
