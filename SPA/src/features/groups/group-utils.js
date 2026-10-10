import { GROUP_DESCRIPTION_MAX, GROUP_TITLE_MAX } from '../../api/groups.js';
import { normalizeText } from '../content/content-utils.js';
import { parsePage, readSearchQuery } from '../social/social-utils.js';

const CONTROL = /\p{Cc}/u;

export const ROLE_LABELS = Object.freeze({
	creator: 'Creator',
	member: 'Member',
});

// Discovery state lives in the URL so links, Back and reloads land on the
// same view. Unknown or malformed values fall back to the defaults.
export function readGroupsQuery(query) {
	const membership = readSearchQuery(query.membership) === 'member' ? 'member' : 'all';
	return { q: readSearchQuery(query.q).trim(), membership, page: parsePage(query.page) };
}

export function groupsQuery({ q, membership, page }) {
	const result = {};
	if (q) result.q = q;
	if (membership === 'member') result.membership = 'member';
	if (page > 1) result.page = String(page);
	return result;
}

// Mirrors the contract: trim, CRLF → LF, 1–100/1–1000 code points; titles
// refuse every control character, descriptions allow newline and tab.
export function groupFieldProblem(field, value) {
	const text = normalizeText(value);
	if (text === '') return 'REQUIRED';
	const max = field === 'title' ? GROUP_TITLE_MAX : GROUP_DESCRIPTION_MAX;
	if ([...text].length > max) return 'TOO_LONG';
	const checked = field === 'title' ? text : text.replace(/[\n\t]/gu, '');
	return CONTROL.test(checked) ? 'INVALID_TEXT' : null;
}

const FIELD_MESSAGES = {
	title: {
		REQUIRED: 'Give the group a name.',
		TOO_LONG: `Names can be up to ${GROUP_TITLE_MAX} characters.`,
		INVALID_TEXT: 'Names can’t contain line breaks or control characters.',
	},
	description: {
		REQUIRED: 'Describe what the group is for.',
		TOO_LONG: `Descriptions can be up to ${GROUP_DESCRIPTION_MAX.toLocaleString('en-GB')} characters.`,
		INVALID_TEXT: 'Remove the hidden control characters from the description.',
	},
};

export function groupFieldMessage(field, code) {
	if (!code) return '';
	return FIELD_MESSAGES[field]?.[code] ?? 'Check this field and try again.';
}

export function dateLabel(value) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf())
		? ''
		: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
