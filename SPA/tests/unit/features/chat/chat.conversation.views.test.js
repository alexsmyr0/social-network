import { describe, expect, test } from 'vitest';
import {
	formatTimestamp,
	renderComposer,
	renderConversation,
	renderMessage,
	renderMessageImage,
	renderMessageList,
} from '../../../../features/chat/chat.conversation.views.js';

describe('formatTimestamp', () => {
	test('returns an empty string for falsy input', () => {
		expect(formatTimestamp('')).toBe('');
		expect(formatTimestamp(null)).toBe('');
	});

	test('returns the raw value when it is not a valid date', () => {
		expect(formatTimestamp('not-a-date')).toBe('not-a-date');
	});

	test('formats a valid date into a non-empty human string', () => {
		const formatted = formatTimestamp('2026-01-02T03:04:05Z');
		expect(typeof formatted).toBe('string');
		expect(formatted).not.toBe('2026-01-02T03:04:05Z');
		expect(formatted.length).toBeGreaterThan(0);
	});
});

describe('renderMessage', () => {
	const message = {
		id: 7,
		sender_id: 9,
		sender_username: 'bob',
		body: 'hello there',
		created_at: '2026-01-01T00:00:00Z',
	};

	test('renders sender username, timestamp and body', () => {
		const html = renderMessage(message, 1);
		expect(html).toContain('data-message-id="7"');
		expect(html).toContain('bob');
		expect(html).toContain('hello there');
		expect(html).toContain('datetime="2026-01-01T00:00:00Z"');
	});

	test('marks the message as own when sender matches current user', () => {
		expect(renderMessage(message, 9)).toContain('chat-conversation__message--own');
		expect(renderMessage(message, 1)).toContain('chat-conversation__message--incoming');
	});

	test('escapes message body to prevent injection', () => {
		const html = renderMessage({ ...message, body: '<img src=x onerror=alert(1)>' }, 1);
		expect(html).not.toContain('<img src=x');
		expect(html).toContain('&lt;img');
	});

	test('renders an inline image when image_url is present (D08)', () => {
		const html = renderMessage({ ...message, image_url: '/static/uploads/dm/a.jpg' }, 1);
		expect(html).toContain('chat-conversation__image');
		expect(html).toContain('src="/static/uploads/dm/a.jpg"');
		expect(html).toContain('loading="lazy"');
	});

	test('omits the image element when there is no attachment (D08)', () => {
		expect(renderMessage(message, 1)).not.toContain('chat-conversation__image');
		expect(renderMessage({ ...message, image_url: '   ' }, 1)).not.toContain(
			'chat-conversation__image',
		);
	});

	test('escapes the image url to prevent attribute injection (D08)', () => {
		const html = renderMessage({ ...message, image_url: '/x.jpg" onerror="alert(1)' }, 1);
		expect(html).not.toContain('onerror="alert(1)"');
		expect(html).toContain('&quot;');
	});

	test('renders an image-only message without an empty body paragraph', () => {
		const html = renderMessage({ ...message, body: '', image_url: '/static/uploads/dm/a.jpg' }, 1);
		expect(html).toContain('chat-conversation__image');
		expect(html).not.toContain('chat-conversation__body');
	});
});

describe('renderMessageImage', () => {
	test('returns an empty string for missing or blank urls', () => {
		expect(renderMessageImage('')).toBe('');
		expect(renderMessageImage('   ')).toBe('');
		expect(renderMessageImage(null)).toBe('');
		expect(renderMessageImage(undefined)).toBe('');
	});

	test('renders an img element for a valid url', () => {
		const html = renderMessageImage('/static/uploads/dm/pic.png');
		expect(html).toContain('<img');
		expect(html).toContain('src="/static/uploads/dm/pic.png"');
	});
});

describe('renderMessageList', () => {
	test('renders an empty state when there are no messages', () => {
		const html = renderMessageList([], 1);
		expect(html).toContain('data-conversation-empty');
		expect(html).not.toContain('<li');
	});

	test('renders one list item per message in order', () => {
		const html = renderMessageList(
			[
				{ id: 1, sender_id: 1, sender_username: 'me', body: 'a', created_at: '' },
				{ id: 2, sender_id: 2, sender_username: 'you', body: 'b', created_at: '' },
			],
			1,
		);
		expect(html).toContain('data-conversation-messages');
		expect(html.indexOf('data-message-id="1"')).toBeLessThan(html.indexOf('data-message-id="2"'));
	});
});

describe('renderComposer', () => {
	test('is enabled when the user is online', () => {
		const html = renderComposer(true);
		expect(html).not.toContain('disabled');
		expect(html).not.toContain('data-conversation-offline');
	});

	test('disables input and send button when the user is offline', () => {
		const html = renderComposer(false);
		expect(html).toContain('disabled');
		expect(html).toContain('data-conversation-offline');
	});

	test('exposes the image attachment controls (D08)', () => {
		const html = renderComposer(true);
		expect(html).toContain('data-conversation-image-input');
		expect(html).toContain('type="file"');
		expect(html).toContain('data-conversation-attach');
		expect(html).toContain('data-conversation-image-preview');
		expect(html).toContain('data-conversation-image-clear');
	});
});

describe('renderConversation', () => {
	test('renders header, history and composer for an online user', () => {
		const html = renderConversation({
			username: 'alice',
			isOnline: true,
			messages: [{ id: 1, sender_id: 1, sender_username: 'alice', body: 'hey', created_at: '' }],
			currentUserId: 2,
		});
		expect(html).toContain('alice');
		expect(html).toContain('chat-conversation__presence--online');
		expect(html).toContain('data-conversation-messages');
		expect(html).toContain('data-conversation-composer');
	});

	test('shows the empty state and a disabled composer for an offline user with no history', () => {
		const html = renderConversation({
			username: 'sam',
			isOnline: false,
			messages: [],
			currentUserId: 2,
		});
		expect(html).toContain('chat-conversation__presence--offline');
		expect(html).toContain('data-conversation-empty');
		expect(html).toContain('disabled');
	});

	test('renders a back control to return to the user list', () => {
		const html = renderConversation({
			username: 'alice',
			isOnline: true,
			messages: [],
			currentUserId: 2,
		});
		expect(html).toContain('data-conversation-back');
		expect(html).toContain('chat-conversation__back');
	});
});
