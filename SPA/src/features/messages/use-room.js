import { computed, inject, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';

import { MESSAGE_PAGE } from '../../api/chats.js';
import { sessionKey } from '../auth/session-state.js';
import { groupsKey } from '../groups/group-state.js';
import { socialKey } from '../social/social-state.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { fetchNewest } from './history.js';
import { messagesKey } from './message-state.js';
import { lastId, mergeMessages, roomKey } from './message-utils.js';
import { findRoom } from './rooms.js';

// One group room: the group, the viewer's current membership and read cursor,
// and the room's committed messages (ascending by ID, merged from the history
// read, the send response and socket frames).
//
// Nothing about the room is requested until the group read confirms the viewer
// is a member, so an outsider, invitee, requester or departed member never
// touches a room endpoint and sees only the members-only notice. Like a
// private conversation, the read keeps its last confirmed data while a refetch
// runs, so a signal or focus change does not unmount the composer under the
// person's hands; a failed, missing or denied read, a route change or an
// account change discards messages, draft and pending sends at once. A
// membership ID that differs from the one on screen is a different membership
// (the person left and was readmitted): the room starts fresh.
const REJOINED =
	'Your membership in this group changed, so this is a fresh view of its room. Anything you had not sent was discarded.';

export function useRoom(groupId) {
	const session = inject(sessionKey);
	const social = inject(socialKey);
	const groups = inject(groupsKey);
	const messages = inject(messagesKey);
	const viewerId = computed(() => session.state.account?.id ?? null);
	const loaded = shallowRef([]);
	const group = shallowRef(null);
	const entry = shallowRef(null);
	const readThrough = ref(0);
	// Set when the person left and was readmitted while the room was open.
	const notice = ref('');
	const older = reactive({ hasMore: false, nextBeforeId: null, loading: false, failed: false });
	let epoch = 0;

	function clearMessages() {
		epoch += 1;
		loaded.value = [];
		entry.value = null;
		readThrough.value = 0;
		older.hasMore = false;
		older.nextBeforeId = null;
		older.loading = false;
		older.failed = false;
	}
	function clear() {
		clearMessages();
		group.value = null;
		notice.value = '';
	}
	// Synchronous, so nothing from the previous subject survives into a new one.
	watch(() => [groupId.value, viewerId.value], clear, { flush: 'sync' });

	// The room's history and the viewer's summary of it, once membership is known.
	async function loadRoom(id, found) {
		const api = messages.api;
		const [history, room] = await Promise.all([
			fetchNewest((options) => api.fetchGroupMessages(id, options), lastId(loaded.value)),
			findRoom(api, id),
		]);
		if (history.status === 'unauthenticated' || room.status === 'unauthenticated')
			return { status: 'unauthenticated' };
		if (history.status !== 'ok') return history;
		if (room.status !== 'ok') return room;
		if (!room.room) return { status: 'not-found' };
		return { status: 'ok', group: found.group, history, room: room.room };
	}

	async function load() {
		const id = groupId.value;
		if (!id) return { status: 'not-found' };
		const found = await groups.api.fetchGroup(id);
		if (found.status !== 'ok') return found;
		const role = found.group.viewer.role;
		// Not a member: the group's public details and nothing from the room.
		if (role !== 'creator' && role !== 'member')
			return { status: 'ok', group: found.group, history: null, room: null };
		return loadRoom(id, found);
	}

	const resource = useSocialResource(load, {
		social,
		sources: () => [groupId.value, viewerId.value],
		retain: true,
	});

	// A viewer who is not (or no longer) a member keeps nothing of the room.
	function showNonMember(id, result) {
		clear();
		group.value = result.group;
		if (id) messages.forget(roomKey(id));
	}

	function showRoom(id, result) {
		if (entry.value && entry.value.membership_id !== result.room.membership_id) {
			// Left and readmitted between two reads: a fresh room, not the old one.
			// Anything written under the old membership is not carried over.
			clearMessages();
			if (id) messages.forget(roomKey(id));
			notice.value = REJOINED;
		}
		const wasEmpty = loaded.value.length === 0;
		loaded.value = mergeMessages(loaded.value, result.history.messages);
		if (wasEmpty) {
			older.hasMore = result.history.hasMore;
			older.nextBeforeId = result.history.nextBeforeId;
		}
		group.value = result.group;
		entry.value = result.room;
		readThrough.value = Math.max(readThrough.value, result.room.read_through_id);
		messages.acknowledge(roomKey(id), result.history.messages);
	}

	watch([resource.result, resource.status], ([result, status]) => {
		const id = groupId.value;
		if (status !== 'ready' || !result) {
			if (status === 'loading') return;
			clear();
			if (status === 'not-found' && id) messages.forget(roomKey(id));
		} else if (result.room) showRoom(id, result);
		else showNonMember(id, result);
	});

	function onMessage(message) {
		const id = groupId.value;
		if (!id || message.group_id !== id) return;
		// A frame before the first read lands may not be in that read: read again.
		// A frame for a room this account has not been confirmed in is never shown.
		if (!entry.value) {
			void resource.reload('quiet');
			return;
		}
		loaded.value = mergeMessages(loaded.value, [message]);
		messages.acknowledge(roomKey(id), [message]);
	}

	const unsubscribe = messages.subscribe((event) => {
		if (event.type === 'reset') clear();
		else if (event.type === 'group-read' && event.groupId === groupId.value)
			readThrough.value = Math.max(readThrough.value, event.throughId);
		else if (event.type === 'group-message') onMessage(event.message);
	});
	onUnmounted(unsubscribe);

	async function loadOlder() {
		const id = groupId.value;
		if (!id || !entry.value || !older.hasMore || older.loading) return;
		const mine = epoch;
		older.loading = true;
		older.failed = false;
		const result = await messages.api.fetchGroupMessages(id, {
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
		group,
		messages: loaded,
		entry,
		older,
		readThrough,
		notice,
		viewerId,
		loadOlder,
	};
}
