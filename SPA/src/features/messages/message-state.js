import { reactive, readonly, watch } from 'vue';

import * as chatsApi from '../../api/chats.js';
import { isValidId } from '../../api/social.js';
import { createImageCache } from './message-images.js';
import {
	bodyMessage,
	bodyProblem,
	imageMessage,
	imageProblem,
	newClientId,
	normalizeBody,
} from './message-utils.js';

export const messagesKey = Symbol('commonplace-messages');

const SEND_MESSAGES = {
	denied:
		'You can’t message this person any more, so this was not sent. Earlier messages stay readable.',
	conflict:
		'This message was already sent with different content, so it was not sent again. Check the conversation.',
	rejected: 'That message was rejected, so it was not sent. Check it and write it again.',
	unconfirmed:
		'We couldn’t confirm that this was sent. Check the conversation. Retrying sends it only once.',
};

const IMAGE_FAILURES = {
	'too-large': 'TOO_LARGE',
	'invalid-image': 'INVALID',
	rejected: 'INVALID',
	'not-found': 'DENIED',
};

const OWNER_STATUSES = new Set(['authenticated', 'checking']);

function validPresence(user) {
	return user && isValidId(user.user_id) && typeof user.is_online === 'boolean';
}

function readEvent(payload) {
	if (
		payload?.kind !== 'dm' ||
		!isValidId(payload.target_id) ||
		!Number.isSafeInteger(payload.through_id) ||
		payload.through_id < 0 ||
		!Number.isSafeInteger(payload.unread_count) ||
		payload.unread_count < 0
	)
		return null;
	return {
		type: 'read',
		userId: payload.target_id,
		throughId: payload.through_id,
		unreadCount: payload.unread_count,
	};
}

// One owner for the account's private-message state, separate from notices:
// the message badge, drafts and attachments, unsent and failed messages, and
// presence. It reads frames from the notification state's single session-owned
// socket and keeps no copy of server history. Views hold the conversations
// they show and merge what the server reports by message ID.
//
// Every asynchronous result carries the generation it started in, so a late
// response after logout or an account change is dropped, and logout or an
// account change discards drafts, failed messages, presence and cached images.
export function createMessageState({
	api = chatsApi,
	session,
	social,
	notifications = null,
	newId = newClientId,
	images = createImageCache({ fetchImage: (url) => api.fetchImage(url) }),
} = {}) {
	const state = reactive({
		unreadCount: null,
		unreadStatus: 'idle',
		// Bumped by every message-related change so mounted lists refetch quietly.
		revision: 0,
		drafts: {},
		outbox: {},
		presence: { snapshot: false, users: {} },
	});
	const listeners = new Set();
	const chains = new Map();
	let generation = 0;
	let owner = null;
	let unreadRevision = 0;
	let unreadQueued = false;
	let handlingUnauthorized = false;

	function subscribe(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	function emit(event) {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// One faulty view must not stop the others receiving the event.
			}
		}
	}

	const touch = () => {
		state.revision += 1;
	};

	function reset() {
		generation += 1;
		unreadRevision += 1;
		unreadQueued = false;
		chains.clear();
		images.clear();
		state.unreadCount = null;
		state.unreadStatus = 'idle';
		state.drafts = {};
		state.outbox = {};
		state.presence = { snapshot: false, users: {} };
		touch();
		emit({ type: 'reset' });
	}

	async function loadUnread() {
		if (!owner) return;
		const epoch = generation;
		const mine = ++unreadRevision;
		const result = await api.fetchUnread();
		if (epoch !== generation || mine !== unreadRevision) return;
		if (result.status === 'unauthenticated') {
			// Handling a 401 re-reads every view, including this one. A 401 the
			// session endpoint does not confirm must not loop through that again.
			state.unreadCount = null;
			state.unreadStatus = 'unavailable';
			if (handlingUnauthorized) return;
			handlingUnauthorized = true;
			try {
				await social.handleUnauthenticated();
			} finally {
				handlingUnauthorized = false;
			}
			return;
		}
		if (result.status === 'ok') {
			state.unreadCount = result.unreadCount;
			state.unreadStatus = 'ready';
		} else {
			// An unknown total is shown as unknown, never as a stale number.
			state.unreadCount = null;
			state.unreadStatus = 'unavailable';
		}
	}

	// A burst of frames collapses to one request.
	function queueUnread() {
		if (unreadQueued || !owner) return;
		unreadQueued = true;
		void Promise.resolve().then(() => {
			unreadQueued = false;
			return loadUnread();
		});
	}

	// --- socket ---------------------------------------------------------------

	function onMessageFrame(payload) {
		const message = api.normalizeMessage(payload);
		// Only this account's own conversations, whatever the frame claims.
		if (!message || (message.sender_id !== owner && message.recipient_id !== owner)) return;
		emit({ type: 'message', message });
		touch();
		queueUnread();
	}

	function onReadFrame(payload) {
		const event = readEvent(payload);
		if (!event) return;
		emit(event);
		touch();
		queueUnread();
	}

	function onSnapshotFrame(payload) {
		if (!Array.isArray(payload?.users) || !payload.users.every(validPresence)) return;
		state.presence = {
			snapshot: true,
			users: Object.fromEntries(payload.users.map((user) => [user.user_id, user.is_online])),
		};
	}

	function onUpdateFrame(payload) {
		if (validPresence(payload)) state.presence.users[payload.user_id] = payload.is_online;
	}

	// Visibility may have changed. The server follows with a filtered snapshot;
	// until then only freshly fetched roster presence counts.
	function onInvalidateFrame() {
		state.presence = { snapshot: false, users: {} };
	}

	const FRAMES = {
		'dm.message': onMessageFrame,
		'chat.read': onReadFrame,
		'presence.snapshot': onSnapshotFrame,
		'presence.update': onUpdateFrame,
		'social.invalidate': onInvalidateFrame,
	};

	const unsubscribeSocket = notifications?.subscribe?.((event) => {
		if (owner && event.kind === 'frame') FRAMES[event.frame.type]?.(event.frame.payload);
	});

	// Roster presence is shown only where the roster row carries `is_online`
	// (the server found the profile visible). Live frames then refine it.
	function presenceFor(entry) {
		if (typeof entry?.is_online !== 'boolean') return null;
		const live = state.presence.users[entry.user_id];
		if (typeof live === 'boolean') return live;
		return state.presence.snapshot ? false : entry.is_online;
	}

	// --- drafts and attachments ----------------------------------------------

	function ensureDraft(userId) {
		if (!state.drafts[userId]) state.drafts[userId] = { body: '', attachment: null };
		return state.drafts[userId];
	}

	let attachToken = 0;

	async function attachImage(userId, file) {
		const draft = ensureDraft(userId);
		const problem = imageProblem(file);
		if (problem) {
			draft.attachment = {
				name: file?.name ?? '',
				status: 'error',
				url: null,
				message: imageMessage(problem),
				token: 0,
			};
			return;
		}
		const epoch = generation;
		const token = ++attachToken;
		draft.attachment = { name: file.name, status: 'uploading', url: null, message: '', token };
		const result = await api.uploadImage(userId, file);
		if (epoch !== generation || state.drafts[userId]?.attachment?.token !== token) return;
		const attachment = state.drafts[userId].attachment;
		if (result.status === 'ok') {
			attachment.status = 'ready';
			attachment.url = result.imageUrl;
			return;
		}
		if (result.status === 'unauthenticated') {
			await social.handleUnauthenticated();
			return;
		}
		attachment.status = 'error';
		const code = IMAGE_FAILURES[result.status] ?? 'UNAVAILABLE';
		attachment.message = imageMessage(code);
		if (result.status === 'not-found') await social.invalidate();
	}

	function removeAttachment(userId) {
		const draft = state.drafts[userId];
		if (draft) draft.attachment = null;
	}

	// --- sending ---------------------------------------------------------------

	function entriesOf(userId) {
		return state.outbox[userId] ?? [];
	}

	const findEntry = (userId, clientId) =>
		entriesOf(userId).find((entry) => entry.client_id === clientId);

	function removeEntry(userId, clientId) {
		const remaining = entriesOf(userId).filter((entry) => entry.client_id !== clientId);
		if (remaining.length) state.outbox[userId] = remaining;
		else delete state.outbox[userId];
	}

	function fail(entry, message, retryable) {
		entry.status = 'failed';
		entry.message = message;
		entry.retryable = retryable;
	}

	function rejectedMessage(result) {
		const field = result.fields?.body;
		return field ? bodyMessage(field) : SEND_MESSAGES.rejected;
	}

	// Sends in one conversation run one after another, so quick successive
	// messages are committed in the order they were written.
	function enqueue(userId, task) {
		const previous = chains.get(userId) ?? Promise.resolve();
		const next = previous.then(task, task);
		chains.set(userId, next);
		void next.then(() => {
			if (chains.get(userId) === next) chains.delete(userId);
		});
		return next;
	}

	// What a failed send means for the person, and whether a retry is safe.
	async function settleFailure(entry, result) {
		if (result.status === 'not-found') {
			// The relationship may have ended. Nothing is retried; the lists
			// re-read what the server allows now.
			fail(entry, SEND_MESSAGES.denied, false);
			await social.invalidate();
		} else if (result.status === 'conflict') {
			fail(entry, SEND_MESSAGES.conflict, false);
			await social.refresh();
		} else if (result.status === 'rejected') {
			fail(entry, rejectedMessage(result), false);
		} else {
			// Lost or malformed response: the message may be stored. The same
			// retry nonce makes a retry safe (an exact replay returns the original),
			// and any later refetch shows the message if it is there. Re-reading now
			// would only discard the conversation during an outage.
			fail(entry, SEND_MESSAGES.unconfirmed, true);
		}
	}

	async function deliver(userId, clientId) {
		const epoch = generation;
		const entry = findEntry(userId, clientId);
		if (!entry) return;
		entry.status = 'sending';
		entry.message = '';
		entry.retryable = false;
		const result = await api.sendMessage(userId, {
			clientId,
			body: entry.body,
			imageUrl: entry.image_url,
		});
		const current = epoch === generation ? findEntry(userId, clientId) : null;
		if (!current) return;
		if (result.status === 'ok') {
			removeEntry(userId, clientId);
			emit({ type: 'message', message: result.message });
			touch();
			queueUnread();
		} else if (result.status === 'unauthenticated') {
			await social.handleUnauthenticated();
		} else {
			await settleFailure(current, result);
		}
	}

	function send(userId) {
		if (!owner) return { status: 'unavailable' };
		const draft = state.drafts[userId];
		if (draft?.attachment?.status === 'uploading') return { status: 'busy' };
		const body = normalizeBody(draft?.body ?? '');
		const imageUrl = draft?.attachment?.status === 'ready' ? draft.attachment.url : null;
		const problem = bodyProblem(body);
		if (problem) return { status: 'invalid', problem };
		if (body === '' && !imageUrl) return { status: 'empty' };
		const entry = {
			client_id: newId(),
			user_id: userId,
			body,
			image_url: imageUrl,
			status: 'sending',
			message: '',
			retryable: false,
			created_at: new Date().toISOString(),
		};
		state.outbox[userId] = [...entriesOf(userId), entry];
		draft.body = '';
		draft.attachment = null;
		void enqueue(userId, () => deliver(userId, entry.client_id));
		return { status: 'queued', clientId: entry.client_id };
	}

	function retry(userId, clientId) {
		const entry = findEntry(userId, clientId);
		if (!entry || entry.status !== 'failed' || !entry.retryable) return false;
		entry.status = 'sending';
		entry.message = '';
		entry.retryable = false;
		void enqueue(userId, () => deliver(userId, clientId));
		return true;
	}

	function discard(userId, clientId) {
		removeEntry(userId, clientId);
	}

	// A message the server now reports as committed ends its pending entry,
	// whether it arrived by send response, socket echo or a refetch.
	function acknowledge(userId, messages) {
		const sent = new Set(
			messages
				.filter((message) => message.sender_id === owner && message.client_id)
				.map((m) => m.client_id),
		);
		for (const entry of [...entriesOf(userId)]) {
			if (sent.has(entry.client_id)) removeEntry(userId, entry.client_id);
		}
	}

	// A conversation the server no longer shows at all (a stranger, a deleted
	// account) keeps no draft, attachment or pending message here.
	function forget(userId) {
		delete state.drafts[userId];
		delete state.outbox[userId];
		chains.delete(userId);
	}

	// --- reading ---------------------------------------------------------------

	async function markRead(userId, throughId) {
		if (!owner) return { status: 'skipped' };
		const epoch = generation;
		const result = await api.markRead(userId, throughId);
		if (epoch !== generation) return { status: 'superseded' };
		if (result.status === 'unauthenticated') {
			await social.handleUnauthenticated();
			return result;
		}
		if (result.status === 'ok') {
			emit({ type: 'read', userId, throughId: result.throughId, unreadCount: result.unreadCount });
			touch();
			queueUnread();
		} else if (result.status === 'not-found') {
			await social.invalidate();
		}
		return result;
	}

	// --- lifecycle ---------------------------------------------------------------

	const unregister = social.registerResource({
		reload(mode) {
			if (mode === 'clear') {
				unreadRevision += 1;
				state.unreadCount = null;
				state.unreadStatus = 'idle';
				return Promise.resolve();
			}
			return loadUnread();
		},
	});

	const stopWatch = watch(
		() => [session.state.account?.id ?? null, session.state.status],
		([id, status]) => {
			const next = OWNER_STATUSES.has(status) ? id : null;
			if (next === owner) return;
			reset();
			owner = next;
			if (owner) void loadUnread();
		},
		{ immediate: true, flush: 'sync' },
	);

	function dispose() {
		stopWatch();
		unregister();
		unsubscribeSocket?.();
		reset();
		owner = null;
		listeners.clear();
	}

	return {
		state: readonly(state),
		api,
		images,
		subscribe,
		connection: () => notifications?.state.connection ?? 'offline',
		presenceFor,
		draft: (userId) => state.drafts[userId] ?? null,
		setBody(userId, body) {
			ensureDraft(userId).body = body;
		},
		attachImage,
		removeAttachment,
		outbox: (userId) => state.outbox[userId] ?? [],
		send,
		retry,
		discard,
		acknowledge,
		forget,
		markRead,
		refreshUnread: loadUnread,
		dispose,
	};
}
