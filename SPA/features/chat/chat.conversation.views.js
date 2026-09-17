import { IMAGE_ACCEPT_ATTR } from '../../core/shared/utils.js';
import { escapeHTML } from '../../core/utils/html.js';

export function formatTimestamp(value) {
	if (!value) {
		return '';
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}

	return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// Bonus (D08): a DM may carry an image attachment. The backend constrains
// image_url to `/static/uploads/dm/<file>.<jpg|png|gif>` (C09), but we still
// escape it before injecting it as an attribute — defence in depth.
export function renderMessageImage(imageUrl) {
	const url = typeof imageUrl === 'string' ? imageUrl.trim() : '';
	if (!url) {
		return '';
	}

	return `<img class="chat-conversation__image" src="${escapeHTML(url)}" alt="Shared image" loading="lazy" />`;
}

export function renderMessage(message, currentUserId) {
	const senderId = Number(message?.sender_id ?? 0);
	const isOwn = Number.isFinite(currentUserId) && senderId === currentUserId;
	const username = String(message?.sender_username ?? '');
	const body = String(message?.body ?? '');
	const rawCreatedAt = message?.created_at ?? '';
	const messageId = Number(message?.id ?? 0);
	const imageMarkup = renderMessageImage(message?.image_url);

	const itemClass = isOwn
		? 'chat-conversation__message chat-conversation__message--own'
		: 'chat-conversation__message chat-conversation__message--incoming';

	// Image-only messages have no text, so the body paragraph is omitted
	// rather than rendered empty.
	const bodyMarkup = body ? `<p class="chat-conversation__body">${escapeHTML(body)}</p>` : '';

	return `
		<li class="${itemClass}" data-message-id="${messageId}">
			<div class="chat-conversation__meta">
				<span class="chat-conversation__sender">${escapeHTML(username)}</span>
				<time class="chat-conversation__time" datetime="${escapeHTML(rawCreatedAt)}">${escapeHTML(formatTimestamp(rawCreatedAt))}</time>
			</div>
			${bodyMarkup}
			${imageMarkup}
		</li>
	`;
}

// Items only (no <ul> wrapper) so older batches can be prepended into the
// existing list element during incremental history loading.
export function renderMessageItems(messages, currentUserId) {
	if (!Array.isArray(messages) || messages.length === 0) {
		return '';
	}

	return messages.map((message) => renderMessage(message, currentUserId)).join('');
}

export function renderMessageList(messages, currentUserId) {
	if (!Array.isArray(messages) || messages.length === 0) {
		return '<p class="chat-conversation__empty" data-conversation-empty>No messages yet. Say hello!</p>';
	}

	return `<ul class="chat-conversation__messages" data-conversation-messages>${renderMessageItems(messages, currentUserId)}</ul>`;
}

// The composer markup is re-rendered on its own when the other party's presence
// flips mid-conversation (issue #50), so it is kept as one self-contained block
// that can replace the contents of the composer region.
export function renderComposer(isOnline) {
	const disabledAttr = isOnline ? '' : 'disabled';
	const placeholder = isOnline ? 'Type a message…' : 'User is offline';
	const offlineNote = isOnline
		? ''
		: '<p class="chat-conversation__offline-note" data-conversation-offline>You cannot message users while they are offline.</p>';

	return `
		<div class="chat-conversation__attachment" data-conversation-image-preview hidden>
			<img class="chat-conversation__attachment-thumb" data-conversation-image-thumb alt="Attachment preview" />
			<button
				class="chat-conversation__attachment-remove"
				data-conversation-image-clear
				type="button"
				aria-label="Remove attached image">×</button>
		</div>
		<form class="chat-conversation__composer" data-conversation-composer>
			<input
				class="chat-conversation__image-input"
				data-conversation-image-input
				type="file"
				accept="${IMAGE_ACCEPT_ATTR}"
				hidden
				${disabledAttr} />
			<button
				class="chat-conversation__attach"
				data-conversation-attach
				type="button"
				aria-label="Attach an image"
				${disabledAttr}>📎</button>
			<input
				class="chat-conversation__input"
				data-conversation-input
				type="text"
				name="message"
				autocomplete="off"
				placeholder="${placeholder}"
				${disabledAttr} />
			<button class="chat-conversation__send" data-conversation-send type="submit" ${disabledAttr}>Send</button>
		</form>
		${offlineNote}
	`;
}

// Shared by the initial render and by the live presence patch in
// `chat.conversation.page.js`, so the two cannot drift apart (issue #50).
export function presenceClassName(isOnline) {
	return isOnline
		? 'chat-conversation__presence chat-conversation__presence--online'
		: 'chat-conversation__presence chat-conversation__presence--offline';
}

export function renderConversation({ username, isOnline, messages, currentUserId } = {}) {
	const safeUsername = String(username ?? '');
	const online = Boolean(isOnline);
	const presenceClass = presenceClassName(online);

	return `
		<div class="chat-conversation" data-conversation-view>
			<header class="chat-conversation__header">
				<div class="chat-conversation__header-left">
					<button type="button" class="chat-conversation__back" data-conversation-back aria-label="Back to chats">
						<span aria-hidden="true">←</span>
					</button>
					<span class="chat-conversation__title">${escapeHTML(safeUsername)}</span>
				</div>
				<span class="${presenceClass}" data-conversation-presence>${online ? 'online' : 'offline'}</span>
			</header>
			<p class="chat-conversation__error" data-conversation-error role="alert" hidden></p>
			<div class="chat-conversation__scroll" data-conversation-scroll>
				${renderMessageList(messages, currentUserId)}
			</div>
			<div class="chat-conversation__composer-region" data-conversation-composer-region>
				${renderComposer(online)}
			</div>
		</div>
	`;
}
