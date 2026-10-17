import { EVENT_DESCRIPTION_MAX, EVENT_TITLE_MAX } from '../../api/events.js';
import { normalizeText } from '../content/content-utils.js';

const CONTROL = /\p{Cc}/u;
const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

export const CHOICE_LABELS = Object.freeze({ going: 'Going', not_going: 'Not going' });

// Mirrors the contract: trim, CRLF → LF, 1–100/1–1000 code points; titles
// refuse every control character, descriptions allow newline and tab.
export function eventFieldProblem(field, value) {
	const text = normalizeText(value);
	if (text === '') return 'REQUIRED';
	const max = field === 'title' ? EVENT_TITLE_MAX : EVENT_DESCRIPTION_MAX;
	if ([...text].length > max) return 'TOO_LONG';
	const checked = field === 'title' ? text : text.replace(/[\n\t]/gu, '');
	return CONTROL.test(checked) ? 'INVALID_TEXT' : null;
}

// A `datetime-local` value is a wall-clock time with no zone. The contract
// wants an absolute instant, so the value is read in the viewer's own zone.
// A wall time the zone skips (a clock change) or an impossible date is
// refused instead of being silently moved to a different hour.
export function startsAtProblem(value) {
	const match = LOCAL_INPUT.exec((value ?? '').trim());
	if (!match) return { problem: (value ?? '').trim() === '' ? 'REQUIRED' : 'INVALID_TIME' };
	const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
	if (year < 1 || year > 9999) return { problem: 'INVALID_TIME' };
	const date = new Date(2000, 0, 1, 0, 0, 0, 0);
	date.setFullYear(year, month - 1, day);
	date.setHours(hour, minute, second, 0);
	const exact =
		date.getFullYear() === year &&
		date.getMonth() === month - 1 &&
		date.getDate() === day &&
		date.getHours() === hour &&
		date.getMinutes() === minute &&
		date.getSeconds() === second;
	if (!exact) return { problem: 'INVALID_TIME' };
	const instant = date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
	// Years above 9999 serialize with a sign; the range check above prevents it.
	return /^\d{4}-/u.test(instant) ? { problem: null, instant } : { problem: 'INVALID_TIME' };
}

const FIELD_MESSAGES = {
	title: {
		REQUIRED: 'Give the event a title.',
		TOO_LONG: `Titles can be up to ${EVENT_TITLE_MAX} characters.`,
		INVALID_TEXT: 'Titles can’t contain line breaks or control characters.',
	},
	description: {
		REQUIRED: 'Describe what will happen.',
		TOO_LONG: `Descriptions can be up to ${EVENT_DESCRIPTION_MAX.toLocaleString('en-GB')} characters.`,
		INVALID_TEXT: 'Remove the hidden control characters from the description.',
	},
	starts_at: {
		REQUIRED: 'Choose the day and time.',
		INVALID_TIME:
			'Choose a real date and time. A time that your clocks skip, such as at a clock change, isn’t valid.',
	},
};

export function eventFieldMessage(field, code) {
	if (!code) return '';
	return FIELD_MESSAGES[field]?.[code] ?? 'Check this field and try again.';
}

// Events are shown in the viewer's own zone, with the zone named, so a member
// elsewhere does not read the creator's wall time as their own.
export function eventTimeLabel(value, { timeZone } = {}) {
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return '';
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		timeZoneName: 'short',
		...(timeZone ? { timeZone } : {}),
	}).format(date);
}

export function isPastEvent(value, now = Date.now()) {
	const time = Date.parse(value);
	return !Number.isNaN(time) && time < now;
}

export function countsLabel(counts) {
	return `${counts.going} going · ${counts.not_going} not going`;
}
