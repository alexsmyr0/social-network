import { WS_EVENTS } from '../../core/realtime/chat-socket.js';
import { MAX_IMAGE_BYTES } from '../../core/shared/utils.js';
import {
	ensurePresenceBridge,
	isUserOnline,
	setUserPresence,
	subscribePresence,
} from '../../core/state/presence.js';
import { ensureCurrentUserId } from '../../core/state/session.js';
import { throttle } from '../../core/utils/throttle.js';
import { fetchConversation, uploadDMImage } from './chat.conversation.api.js';
import {
	presenceClassName,
	renderComposer,
	renderConversation,
	renderMessage,
	renderMessageItems,
	renderMessageList,
} from './chat.conversation.views.js';

const ACTIVE_ROOT_SELECTOR = '[data-chat-active]';
const ROSTER_ROOT_SELECTOR = '[data-chat-roster]';
const BACK_SELECTOR = '[data-conversation-back]';
const ACTIVE_BOUND_ATTR = 'data-conversation-bound';
const COMPOSER_SELECTOR = '[data-conversation-composer]';
const INPUT_SELECTOR = '[data-conversation-input]';
const SCROLL_CONTAINER_SELECTOR = '[data-conversation-scroll]';
const MESSAGE_LIST_SELECTOR = '[data-conversation-messages]';
const ERROR_SELECTOR = '[data-conversation-error]';
const IMAGE_INPUT_SELECTOR = '[data-conversation-image-input]';
const ATTACH_SELECTOR = '[data-conversation-attach]';
const IMAGE_PREVIEW_SELECTOR = '[data-conversation-image-preview]';
const IMAGE_THUMB_SELECTOR = '[data-conversation-image-thumb]';
const IMAGE_CLEAR_SELECTOR = '[data-conversation-image-clear]';
const PRESENCE_SELECTOR = '[data-conversation-presence]';
const COMPOSER_REGION_SELECTOR = '[data-conversation-composer-region]';
const SPLIT_LAYOUT_QUERY = '(min-width: 861px)';

// Outbound composer submissions are published as this DOM event; the app shell
// owns the socket and forwards it as a dm.send frame. Keeps the conversation
// view decoupled from the transport.
export const SEND_MESSAGE_EVENT = 'chat:send-message';

// Published when the open thread is minimised back to the roster. The roster
// listens so it knows the conversation is no longer being read and can start
// counting arriving messages as unread again.
export const CONVERSATION_CLOSED_EVENT = 'chat:conversation-closed';

// Trigger an older-history load once the viewport is within this many pixels
// of the top, and rate-limit scroll handling to avoid burst requests.
const SCROLL_LOAD_THRESHOLD_PX = 80;
const SCROLL_THROTTLE_MS = 200;

function renderInto(activeRoot, data) {
	activeRoot.innerHTML = renderConversation(data);
}

function oldestMessageId(messages) {
	if (!Array.isArray(messages) || messages.length === 0) {
		return null;
	}
	const id = Number(messages[0]?.id);
	return Number.isFinite(id) && id > 0 ? id : null;
}

export function initChatConversation(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const fetchRef = options.fetchRef ?? (typeof fetch === 'function' ? fetch : null);

	if (
		!windowRef ||
		!documentRef ||
		typeof fetchRef !== 'function' ||
		typeof documentRef.querySelector !== 'function' ||
		typeof documentRef.addEventListener !== 'function'
	) {
		return null;
	}

	const activeRoot = documentRef.querySelector(ACTIVE_ROOT_SELECTOR);
	if (!activeRoot) {
		return null;
	}

	if (activeRoot.getAttribute(ACTIVE_BOUND_ATTR) === 'true') {
		return null;
	}

	activeRoot.setAttribute(ACTIVE_BOUND_ATTR, 'true');

	// Tracks the conversation currently on screen so live dm.message frames can
	// be matched to the active thread.
	const state = { recipientId: 0, username: '', isOnline: false };

	// Small screens use a single chat slot, while desktop keeps roster and
	// conversation as two persistent panels in the sticky chat column.
	const rosterRoot = documentRef.querySelector(ROSTER_ROOT_SELECTOR);

	function usesSplitLayout() {
		if (typeof windowRef.matchMedia !== 'function') {
			return false;
		}
		return windowRef.matchMedia(SPLIT_LAYOUT_QUERY).matches;
	}

	function showConversationPanel() {
		activeRoot.removeAttribute?.('hidden');
		if (usesSplitLayout()) {
			rosterRoot?.removeAttribute?.('hidden');
			return;
		}
		rosterRoot?.setAttribute?.('hidden', '');
	}

	function showRosterPanel() {
		rosterRoot?.removeAttribute?.('hidden');
		if (usesSplitLayout()) {
			activeRoot.removeAttribute?.('hidden');
			return;
		}
		activeRoot.setAttribute?.('hidden', '');
	}

	showRosterPanel();

	// Minimise the open thread and return to the user list. Clearing
	// recipientId stops live dm.message frames from targeting the closed thread.
	function closeConversation() {
		state.recipientId = 0;
		state.username = '';
		state.isOnline = false;
		revokeAttachmentPreview();
		showRosterPanel();

		if (typeof CustomEvent === 'function') {
			documentRef.dispatchEvent?.(new CustomEvent(CONVERSATION_CLOSED_EVENT, { bubbles: true }));
		}
	}

	// The signed-in user id (needed to style own vs incoming messages) now comes
	// from the shared session slice, so the roster and the conversation resolve
	// GET /users/me once between them rather than once each (issue #76).
	let currentUserId = null;
	function resolveCurrentUserId() {
		return ensureCurrentUserId(fetchRef).then((id) => {
			currentUserId = id;
			return id;
		});
	}

	// One state object per active conversation. Replacing it on each selection
	// invalidates any older-history fetch still in flight for the prior user.
	let conversationState = null;

	async function loadOlderHistory(scrollEl, listEl) {
		const state = conversationState;
		if (!state || state.isLoading || !state.hasMore || !state.oldestId) {
			return;
		}

		state.isLoading = true;
		// Capture geometry before the prepend so we can restore the viewport.
		const previousHeight = scrollEl.scrollHeight ?? 0;
		const previousTop = scrollEl.scrollTop ?? 0;

		const older = await fetchConversation(fetchRef, state.userId, { beforeId: state.oldestId });

		// Bail if the user switched conversations while the request was pending.
		// Reset the captured state's loading flag so nothing observing the
		// abandoned conversation is left wedged as "loading".
		if (conversationState !== state) {
			state.isLoading = false;
			return;
		}

		// A transient failure (server/network) must NOT be read as
		// end-of-history: leave hasMore untouched so a later scroll retries.
		if (!older.ok) {
			state.isLoading = false;
			return;
		}

		if (older.messages.length > 0) {
			listEl.insertAdjacentHTML?.('afterbegin', renderMessageItems(older.messages, currentUserId));
			state.oldestId = oldestMessageId(older.messages) ?? state.oldestId;

			// Keep the previously-visible message anchored: the list grew above
			// the viewport, so push scrollTop down by exactly that delta.
			const newHeight = scrollEl.scrollHeight ?? previousHeight;
			scrollEl.scrollTop = previousTop + (newHeight - previousHeight);
			state.hasMore = older.hasMore;
		} else {
			// Genuine end-of-history (fetch succeeded, no older messages).
			state.hasMore = false;
		}

		state.isLoading = false;
	}

	function bindIncrementalLoading() {
		if (typeof activeRoot.querySelector !== 'function') {
			return;
		}

		const scrollEl = activeRoot.querySelector(SCROLL_CONTAINER_SELECTOR);
		const listEl = activeRoot.querySelector(MESSAGE_LIST_SELECTOR);
		if (!scrollEl || !listEl || typeof scrollEl.addEventListener !== 'function') {
			return;
		}

		// innerHTML was just replaced, so this is a fresh node with no prior
		// listeners — a throttled handler can be attached without leaking.
		// ONE throttled loader is shared by both listeners below, so a gesture
		// that fires `scroll` and `wheel` together still costs a single request.
		const maybeLoadOlder = throttle(() => {
			if ((scrollEl.scrollTop ?? 0) <= SCROLL_LOAD_THRESHOLD_PX) {
				void loadOlderHistory(scrollEl, listEl);
			}
		}, SCROLL_THROTTLE_MS);

		scrollEl.addEventListener('scroll', maybeLoadOlder);

		// A batch of 10 short messages does not fill a tall panel, so
		// scrollHeight === clientHeight and the browser emits NO `scroll` event
		// however hard the user scrolls — on a 1080p viewport the pane measured
		// 772px of content in a 772px box. Scroll-driven paging could therefore
		// never bootstrap: it only worked once enough messages had arrived to
		// overflow the panel on their own.
		//
		// An upward `wheel` fires whether or not the container can move, so it
		// drives the same throttled loader. `scroll` stays the primary trigger
		// (and is what fires once the thread does overflow); this only covers the
		// gap. Loading still happens strictly 10 at a time — auto-filling the
		// panel instead would show more than the last 10 messages on open.
		scrollEl.addEventListener('wheel', (event) => {
			if ((event?.deltaY ?? 0) < 0) {
				maybeLoadOlder();
			}
		});
	}

	async function onUserSelected(event) {
		const detail = event?.detail;
		if (!detail || !Number.isFinite(detail.userId) || detail.userId <= 0) {
			return;
		}

		// Seed the presence store from the roster row BEFORE awaiting history: a
		// live frame that lands while the fetch is in flight must win over this
		// click-time snapshot rather than being clobbered by it.
		setUserPresence(detail.userId, detail.isOnline);

		const [resolvedId, conversation] = await Promise.all([
			resolveCurrentUserId(),
			fetchConversation(fetchRef, detail.userId),
		]);

		state.recipientId = detail.userId;
		state.username = detail.username;
		state.isOnline = isUserOnline(detail.userId);

		renderInto(activeRoot, {
			username: detail.username,
			isOnline: state.isOnline,
			messages: conversation.messages,
			currentUserId: resolvedId,
		});

		// The previous composer (and any pending attachment preview) was just
		// discarded with the innerHTML swap; release its object URL.
		revokeAttachmentPreview();

		conversationState = {
			userId: detail.userId,
			oldestId: oldestMessageId(conversation.messages),
			hasMore: Boolean(conversation.hasMore),
			isLoading: false,
		};

		bindIncrementalLoading();
		showConversationPanel();
		// After the panel is shown, never before: on the narrow layout the thread
		// is still `hidden` up to this point, so its scrollHeight would read 0 and
		// pin it to the top — exactly the bug being fixed.
		scrollToLatest();
	}

	// A freshly rendered thread must open on its NEWEST message, the way every
	// chat client does. Leaving it at scrollTop 0 also silently disabled
	// incremental history: the container was already pinned to the top, so
	// scrolling up could not move it, no `scroll` event was ever emitted, and
	// `loadOlderHistory` never ran. Older messages were unreachable without
	// first scrolling down.
	function scrollToLatest() {
		const scrollEl = activeRoot.querySelector?.(SCROLL_CONTAINER_SELECTOR);
		if (!scrollEl || typeof scrollEl.scrollHeight !== 'number') {
			return;
		}
		scrollEl.scrollTop = scrollEl.scrollHeight;
	}

	// Appends a single live message to the open thread, replacing the empty
	// state if necessary, and keeps the viewport pinned to the latest message.
	function appendLiveMessage(message, me) {
		const scroll = activeRoot.querySelector?.(SCROLL_CONTAINER_SELECTOR);
		if (!scroll) {
			return;
		}

		const list = scroll.querySelector?.(MESSAGE_LIST_SELECTOR);
		if (list && typeof list.insertAdjacentHTML === 'function') {
			list.insertAdjacentHTML('beforeend', renderMessage(message, me));
		} else {
			scroll.innerHTML = renderMessageList([message], me);
		}

		if (typeof scroll.scrollHeight === 'number') {
			scroll.scrollTop = scroll.scrollHeight;
		}
	}

	function showError(message) {
		const banner = activeRoot.querySelector?.(ERROR_SELECTOR);
		if (!banner) {
			return;
		}
		banner.textContent = message;
		banner.removeAttribute('hidden');
	}

	function clearError() {
		const banner = activeRoot.querySelector?.(ERROR_SELECTOR);
		banner?.setAttribute('hidden', '');
	}

	// Bonus (D08): object URL backing the in-composer attachment preview. Tracked
	// so it can be revoked when the selection changes, is cleared, or is sent.
	let attachmentObjectUrl = null;

	function revokeAttachmentPreview() {
		if (attachmentObjectUrl && typeof URL?.revokeObjectURL === 'function') {
			URL.revokeObjectURL(attachmentObjectUrl);
		}
		attachmentObjectUrl = null;
	}

	function resetComposerImage() {
		revokeAttachmentPreview();
		const input = activeRoot.querySelector?.(IMAGE_INPUT_SELECTOR);
		if (input) {
			input.value = '';
		}
		activeRoot.querySelector?.(IMAGE_PREVIEW_SELECTOR)?.setAttribute?.('hidden', '');
		activeRoot.querySelector?.(IMAGE_THUMB_SELECTOR)?.removeAttribute?.('src');
	}

	function showAttachmentPreview(file) {
		if (file && file.size > MAX_IMAGE_BYTES) {
			resetComposerImage();
			showError('Image must be 20MB or smaller.');
			return;
		}

		revokeAttachmentPreview();

		const preview = activeRoot.querySelector?.(IMAGE_PREVIEW_SELECTOR);
		const thumb = activeRoot.querySelector?.(IMAGE_THUMB_SELECTOR);
		if (!file || !preview || !thumb) {
			resetComposerImage();
			return;
		}

		if (typeof URL?.createObjectURL === 'function') {
			attachmentObjectUrl = URL.createObjectURL(file);
			thumb.src = attachmentObjectUrl;
		}
		preview.removeAttribute?.('hidden');
		clearError();
	}

	function setComposerBusy(composer, busy) {
		for (const el of [
			composer.querySelector?.('[data-conversation-send]'),
			composer.querySelector?.(ATTACH_SELECTOR),
		]) {
			if (busy) {
				el?.setAttribute?.('disabled', '');
			} else {
				el?.removeAttribute?.('disabled');
			}
		}
	}

	function selectedComposerFile(composer) {
		return composer.querySelector?.(IMAGE_INPUT_SELECTOR)?.files?.[0] ?? null;
	}

	// Uploads the attachment with the send/attach controls disabled, returning the
	// saved image URL or '' on failure (the caller surfaces the error).
	async function uploadComposerImage(composer, recipientId, file) {
		setComposerBusy(composer, true);
		const imageUrl = await uploadDMImage(fetchRef, recipientId, file);
		setComposerBusy(composer, false);
		return imageUrl;
	}

	// Upload any attached image first, then publish the outbound message (with the
	// returned image_url) through the shell-owned socket. A message may carry just
	// text, just an image, or both; only a completely empty submit (no text and no
	// file) is silently ignored.
	async function handleComposerSubmit(composer) {
		const recipientId = state.recipientId;
		if (!recipientId) {
			return;
		}

		const input = composer.querySelector?.(INPUT_SELECTOR);
		const body = String(input?.value ?? '').trim();
		const file = selectedComposerFile(composer);

		if (!body && !file) {
			return;
		}

		// `accepted` is filled in by the shell's synchronous listener, which owns
		// the socket. Clearing the composer before knowing the frame went out
		// used to destroy what the user had typed whenever the send failed.
		const detail = { recipientId, body, accepted: false };
		if (file) {
			const imageUrl = await uploadComposerImage(composer, recipientId, file);
			if (!imageUrl) {
				showError('Image upload failed. Please try again.');
				return;
			}
			detail.imageUrl = imageUrl;
		}

		documentRef.dispatchEvent?.(new CustomEvent(SEND_MESSAGE_EVENT, { detail, bubbles: true }));

		if (detail.accepted === false) {
			// The shell already surfaced why. Leave the text and the attachment
			// exactly where they are so the message can be retried.
			return;
		}

		if (input) {
			input.value = '';
		}
		resetComposerImage();
		clearError();
	}

	// --- Live presence for the OPEN thread (issue #50) ------------------------
	//
	// The composer used to be frozen at whatever presence the roster row carried
	// when the conversation was opened, so a partner coming online left the input
	// disabled (and one going offline left it invitingly enabled) until the user
	// reselected them. The conversation now follows the presence store.
	function applyConversationPresence() {
		if (!state.recipientId) {
			return;
		}

		const isOnline = isUserOnline(state.recipientId);
		if (isOnline === state.isOnline) {
			return;
		}
		state.isOnline = isOnline;

		const badge = activeRoot.querySelector?.(PRESENCE_SELECTOR);
		if (badge) {
			badge.textContent = isOnline ? 'online' : 'offline';
			badge.setAttribute?.('class', presenceClassName(isOnline));
		}

		const region = activeRoot.querySelector?.(COMPOSER_REGION_SELECTOR);
		if (!region) {
			return;
		}

		// Whatever is already typed survives the swap. A pending attachment cannot
		// (the file input is discarded with the markup) and must not be carried
		// into an offline thread anyway, so its object URL is released first.
		const draft = String(activeRoot.querySelector?.(INPUT_SELECTOR)?.value ?? '');
		revokeAttachmentPreview();
		region.innerHTML = renderComposer(isOnline);

		const input = activeRoot.querySelector?.(INPUT_SELECTOR);
		if (input && draft) {
			input.value = draft;
		}
	}

	// Presence frames reach the store through the shared bridge; both chat slices
	// call this so presence works whichever of them mounts first.
	ensurePresenceBridge(documentRef);
	subscribePresence(() => {
		applyConversationPresence();
	});

	documentRef.addEventListener('chat:user-selected', (event) => {
		void onUserSelected(event);
	});

	// Incoming/echoed messages: render live only when they belong to the open
	// thread. The backend echoes the sender's own message back, so sent messages
	// also arrive here — no optimistic rendering needed.
	documentRef.addEventListener(WS_EVENTS.DM_MESSAGE, (event) => {
		const message = event?.detail?.message;
		if (!message || !state.recipientId) {
			return;
		}
		void resolveCurrentUserId().then((me) => {
			const senderId = Number(message.sender_id ?? 0);
			const recipientId = Number(message.recipient_id ?? 0);
			const otherUserId = senderId === me ? recipientId : senderId;
			if (otherUserId !== state.recipientId) {
				return;
			}
			clearError();
			appendLiveMessage(message, me);
		});
	});

	documentRef.addEventListener(WS_EVENTS.ERROR, (event) => {
		showError(event?.detail?.message ?? 'Something went wrong.');
	});

	// Composer submit emits the outbound message through the shell-owned socket.
	// Offline recipients are already blocked via the disabled input/button.
	activeRoot.addEventListener('submit', (event) => {
		const composer = event.target?.closest?.(COMPOSER_SELECTOR);
		if (!composer) {
			return;
		}
		event.preventDefault?.();
		void handleComposerSubmit(composer);
	});

	// Attachment controls and the header back arrow are delegated on the
	// persistent root because the conversation markup is replaced on every
	// conversation switch (D08).
	activeRoot.addEventListener?.('click', (event) => {
		if (event.target?.closest?.(BACK_SELECTOR)) {
			closeConversation();
			return;
		}
		if (event.target?.closest?.(ATTACH_SELECTOR)) {
			activeRoot.querySelector?.(IMAGE_INPUT_SELECTOR)?.click?.();
			return;
		}
		if (event.target?.closest?.(IMAGE_CLEAR_SELECTOR)) {
			resetComposerImage();
		}
	});

	activeRoot.addEventListener?.('change', (event) => {
		if (!event.target?.matches?.(IMAGE_INPUT_SELECTOR)) {
			return;
		}
		showAttachmentPreview(event.target.files?.[0] ?? null);
	});

	return { activeRoot };
}
