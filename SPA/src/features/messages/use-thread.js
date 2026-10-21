import { computed, inject, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';

import { MESSAGE_PAGE, ROSTER_PAGE } from '../../api/chats.js';
import { sessionKey } from '../auth/session-state.js';
import { socialKey } from '../social/social-state.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { fetchNewest } from './history.js';
import { messagesKey } from './message-state.js';
import { lastId, mergeMessages } from './message-utils.js';

// Finds the roster row for one partner. The roster is the only source of
// "may I still write to them" and of the name of someone with no history, so a
// partner outside the first page is looked for page by page.
async function findRosterEntry(api, userId) {
	let page = 1;
	for (;;) {
		const result = await api.fetchRoster({ page, perPage: ROSTER_PAGE });
		if (result.status !== 'ok') return result;
		const entry = result.entries.find((item) => item.user_id === userId);
		if (entry) return { status: 'ok', entry };
		if (page >= result.pagination.total_pages) return { status: 'ok', entry: null };
		page += 1;
	}
}

// One private conversation: its committed messages (ascending by ID, merged
// from the history read, the send response and socket frames), the partner's
// roster row (name, may-send, presence) and older-history paging.
//
// The read keeps the last confirmed data while a refetch runs, so a signal or
// focus change does not unmount the composer under the person's hands. A
// failed, missing or denied read, a route change or an account change
// discards it at once. A partner who is no longer reachable and has no
// history disappears; one with history stays readable with sending off.
export function useThread(userId) {
	const session = inject(sessionKey);
	const social = inject(socialKey);
	const messages = inject(messagesKey);
	const viewerId = computed(() => session.state.account?.id ?? null);
	const loaded = shallowRef([]);
	const entry = shallowRef(null);
	const readThrough = ref(0);
	const older = reactive({ hasMore: false, nextBeforeId: null, loading: false, failed: false });
	let epoch = 0;

	function clear() {
		epoch += 1;
		loaded.value = [];
		entry.value = null;
		readThrough.value = 0;
		older.hasMore = false;
		older.nextBeforeId = null;
		older.loading = false;
		older.failed = false;
	}
	// Synchronous, so nothing from the previous subject survives into a new one.
	watch(() => [userId.value, viewerId.value], clear, { flush: 'sync' });

	async function load() {
		const id = userId.value;
		// You can't message yourself; no request is needed to know that.
		if (!id || id === viewerId.value) return { status: 'not-found' };
		const [history, roster] = await Promise.all([
			fetchNewest((options) => messages.api.fetchMessages(id, options), lastId(loaded.value)),
			findRosterEntry(messages.api, id),
		]);
		if (history.status === 'unauthenticated' || roster.status === 'unauthenticated')
			return { status: 'unauthenticated' };
		if (history.status !== 'ok') return history;
		if (roster.status !== 'ok') return roster;
		if (!roster.entry) return { status: 'not-found' };
		return { status: 'ok', history, entry: roster.entry };
	}

	const resource = useSocialResource(load, {
		social,
		sources: () => [userId.value, viewerId.value],
		retain: true,
	});

	watch([resource.result, resource.status], ([result, status]) => {
		const id = userId.value;
		if (status !== 'ready' || !result) {
			if (status === 'loading') return;
			clear();
			if (status === 'not-found' && id) messages.forget(id);
			return;
		}
		const wasEmpty = loaded.value.length === 0;
		loaded.value = mergeMessages(loaded.value, result.history.messages);
		if (wasEmpty) {
			older.hasMore = result.history.hasMore;
			older.nextBeforeId = result.history.nextBeforeId;
		}
		entry.value = result.entry;
		readThrough.value = Math.max(readThrough.value, result.entry.read_through_id);
		messages.acknowledge(id, result.history.messages);
	});

	function onMessage(message) {
		const id = userId.value;
		const partner = message.sender_id === viewerId.value ? message.recipient_id : message.sender_id;
		if (!id || partner !== id) return;
		// A frame before the first read lands may not be in that read: read again.
		if (!entry.value) {
			void resource.reload('quiet');
			return;
		}
		loaded.value = mergeMessages(loaded.value, [message]);
		messages.acknowledge(id, [message]);
	}

	const unsubscribe = messages.subscribe((event) => {
		if (event.type === 'reset') clear();
		else if (event.type === 'read' && event.userId === userId.value)
			readThrough.value = Math.max(readThrough.value, event.throughId);
		else if (event.type === 'message') onMessage(event.message);
	});
	onUnmounted(unsubscribe);

	async function loadOlder() {
		const id = userId.value;
		if (!id || !entry.value || !older.hasMore || older.loading) return;
		const mine = epoch;
		older.loading = true;
		older.failed = false;
		const result = await messages.api.fetchMessages(id, {
			beforeId: older.nextBeforeId,
			limit: MESSAGE_PAGE,
		});
		if (mine !== epoch) return;
		older.loading = false;
		if (result.status === 'unauthenticated') {
			await social.handleUnauthenticated();
			return;
		}
		if (result.status === 'not-found') {
			await social.invalidate();
			return;
		}
		if (result.status !== 'ok') {
			older.failed = true;
			return;
		}
		loaded.value = mergeMessages(loaded.value, result.messages);
		older.hasMore = result.hasMore;
		older.nextBeforeId = result.nextBeforeId;
	}

	return {
		status: resource.status,
		reload: resource.reload,
		messages: loaded,
		entry,
		older,
		readThrough,
		viewerId,
		loadOlder,
	};
}
