import { IMAGE_MAX_BYTES, IMAGE_TYPES, normalizeText } from '../content/content-utils.js';

export const MESSAGE_MAX = 2000;

// Drafts, pending messages and chains are kept per conversation. A private
// conversation is keyed by the partner's account ID; a group room by this key,
// which can never equal a number.
export function roomKey(groupId) {
	return `room-${groupId}`;
}
export { IMAGE_MAX_BYTES, IMAGE_TYPES };

// Newline and tab are ordinary message text; every other control character is
// refused rather than silently removed.
const CONTROL = /\p{Cc}/u;
const LONE_SURROGATE = /\p{Cs}/u;

// Mirrors the contract: CRLF → LF, trim, 0–2000 code points. A message needs
// text, an image or both; emoji, variation selectors and joiners count as the
// code points they are.
export function normalizeBody(value) {
	return normalizeText(value);
}

export function bodyLength(value) {
	return [...normalizeBody(value)].length;
}

export function bodyProblem(value) {
	const text = normalizeBody(value);
	if ([...text].length > MESSAGE_MAX) return 'TOO_LONG';
	if (CONTROL.test(text.replace(/[\n\t]/gu, '')) || LONE_SURROGATE.test(text))
		return 'INVALID_TEXT';
	return null;
}

const BODY_MESSAGES = {
	TOO_LONG: `Messages can be up to ${MESSAGE_MAX.toLocaleString('en-GB')} characters.`,
	INVALID_TEXT: 'Remove the hidden control characters from your message.',
};

export function bodyMessage(code) {
	return code ? (BODY_MESSAGES[code] ?? 'Check your message and try again.') : '';
}

export function imageProblem(file) {
	if (!file) return 'REQUIRED';
	if (!IMAGE_TYPES.includes(file.type)) return 'TYPE';
	if (file.size > IMAGE_MAX_BYTES) return 'TOO_LARGE';
	return null;
}

const IMAGE_MESSAGES = {
	REQUIRED: 'Choose an image first.',
	TYPE: 'Choose a JPEG, PNG or GIF image.',
	TOO_LARGE: 'Images can be up to 5 MiB.',
	INVALID: 'That file isn’t a valid JPEG, PNG or GIF image.',
	DENIED: 'You can’t send images to this person any more.',
	UNAVAILABLE: 'We couldn’t upload that image. Nothing was sent; try again.',
};

export function imageMessage(code) {
	return IMAGE_MESSAGES[code] ?? IMAGE_MESSAGES.UNAVAILABLE;
}

// Retry nonce: a lowercase canonical UUID v4, unique per message the person
// deliberately sends. Reused only to retry the very same message.
export function newClientId(cryptoRef = globalThis.crypto) {
	if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID().toLowerCase();
	const bytes = new Uint8Array(16);
	if (typeof cryptoRef?.getRandomValues === 'function') cryptoRef.getRandomValues(bytes);
	else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Committed messages by ID. The same message arriving by send response, socket
// echo and refetch is one entry; the order is always ascending ID, never
// arrival order. Returns the same array when nothing changed.
export function mergeMessages(existing, incoming) {
	const byId = new Map(existing.map((message) => [message.id, message]));
	let changed = false;
	for (const message of incoming) {
		if (!byId.has(message.id)) changed = true;
		byId.set(message.id, message);
	}
	if (!changed) return existing;
	return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function lastId(messages) {
	return messages.length ? messages[messages.length - 1].id : 0;
}

export function previewLabel(preview) {
	return preview === '[image]' ? 'Image' : preview;
}

const PREVIEW_MAX = 200;

// A room row's last-message line: who wrote it and the start of what they wrote.
export function roomPreview(room, viewerId) {
	const last = room.last_message;
	if (!last) return 'No messages yet.';
	const who = last.sender_id === viewerId ? 'You' : last.sender_username;
	const text = [...last.body].slice(0, PREVIEW_MAX).join('');
	return `${who}: ${text}`;
}

export function timeLabel(value, { now = Date.now(), timeZone } = {}) {
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return '';
	const sameDay = new Date(now).toDateString() === date.toDateString();
	return new Intl.DateTimeFormat(
		undefined,
		sameDay
			? { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }
			: {
					day: 'numeric',
					month: 'short',
					hour: '2-digit',
					minute: '2-digit',
					...(timeZone ? { timeZone } : {}),
				},
	).format(date);
}

// A small, accessible set. The picker inserts the character itself, so a
// message carries plain Unicode and needs no asset or shortcode handling.
export const EMOJI = Object.freeze([
	['😀', 'Grinning face'],
	['😂', 'Face with tears of joy'],
	['😊', 'Smiling face with smiling eyes'],
	['😍', 'Smiling face with heart-eyes'],
	['😎', 'Smiling face with sunglasses'],
	['🤔', 'Thinking face'],
	['😢', 'Crying face'],
	['😮', 'Face with open mouth'],
	['😴', 'Sleeping face'],
	['🙄', 'Face with rolling eyes'],
	['👍', 'Thumbs up'],
	['👎', 'Thumbs down'],
	['👋', 'Waving hand'],
	['🙏', 'Folded hands'],
	['👏', 'Clapping hands'],
	['💪', 'Flexed biceps'],
	['❤️', 'Red heart'],
	['💔', 'Broken heart'],
	['🔥', 'Fire'],
	['🎉', 'Party popper'],
	['✨', 'Sparkles'],
	['⭐', 'Star'],
	['☀️', 'Sun'],
	['🌧️', 'Rain cloud'],
	['🍕', 'Pizza'],
	['☕', 'Hot beverage'],
	['🎵', 'Musical note'],
	['🏠', 'House'],
	['✅', 'Check mark'],
	['❌', 'Cross mark'],
	['💯', 'Hundred points'],
	['👨‍👩‍👧', 'Family'],
]);
