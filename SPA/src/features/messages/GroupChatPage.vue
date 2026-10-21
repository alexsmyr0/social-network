<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import GroupNav from '../groups/GroupNav.vue';
import { parseUserId } from '../social/social-utils.js';
import MessageComposer from './MessageComposer.vue';
import MessageList from './MessageList.vue';
import { messagesKey } from './message-state.js';
import { lastId, roomKey } from './message-utils.js';
import { useRoom } from './use-room.js';

const messages = inject(messagesKey);
const route = useRoute();
const groupId = computed(() => parseUserId(route.params.id));
const room = useRoom(groupId);
const composer = ref(null);
const key = computed(() => (groupId.value ? roomKey(groupId.value) : null));

// The room is shown only while the server confirms the viewer's membership. A
// viewer who is not (or is no longer) a member sees the group's name and a
// members-only notice, never the room, its history, its counts or a composer.
const view = computed(() => {
	const status = room.status.value;
	if (status === 'loading') return 'checking';
	if (status === 'unavailable') return 'unavailable';
	if (status !== 'ready') return 'missing';
	if (room.entry.value) return 'ready';
	return room.group.value ? 'restricted' : 'checking';
});
const group = computed(() => room.group.value);
const draft = computed(() => (key.value ? messages.draft(key.value) : null));
const pending = computed(() => (key.value ? messages.outbox(key.value) : []));
const reconnecting = computed(() => messages.connection() !== 'online');

function setBody(value) {
	messages.setBody(key.value, value);
}

function submit() {
	if (!room.entry.value) return;
	messages.sendRoom(groupId.value, room.entry.value.membership_id);
	composer.value?.focus();
}

// Mark read only after the messages are rendered on a visible page, using the
// largest committed ID shown and the membership the room was read under. The
// cursor never moves backwards and own sends never count as unread, so only an
// unread message from someone else triggers a write.
const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
const onVisibility = () => {
	visible.value = document.visibilityState !== 'hidden';
};
document.addEventListener('visibilitychange', onVisibility);
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility));

let marking = 0;
watch([groupId, () => room.entry.value?.membership_id], () => {
	marking = 0;
});
watch(
	[() => lastId(room.messages.value), visible, view, () => room.entry.value],
	async () => {
		if (view.value !== 'ready' || !visible.value) return;
		const rendered = lastId(room.messages.value);
		const unread = room.messages.value.some(
			(message) => message.sender_id !== room.viewerId.value && message.id > room.readThrough.value,
		);
		if (!unread || rendered <= Math.max(room.readThrough.value, marking)) return;
		marking = rendered;
		const result = await messages.markRoomRead(
			groupId.value,
			room.entry.value.membership_id,
			rendered,
		);
		if (result.status !== 'ok') marking = 0;
	},
	{ flush: 'post', immediate: true },
);
</script>

<template>
	<section class="social-view message-view conversation-view room-view" data-screen="group-chat" :aria-busy="view === 'checking'">
		<p v-if="view === 'checking'" class="social-status" role="status">Opening the group chat…</p>

		<div v-else-if="view === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t open this group chat right now.</h1>
			<p>Nothing is shown until we can confirm you are a member.</p>
			<button class="button button--secondary" type="button" @click="room.reload('hard')">Try again</button>
		</div>

		<div v-else-if="view === 'missing'" class="social-state" data-state="missing">
			<p class="eyebrow">Group chat</p>
			<h1>This group chat isn’t available.</h1>
			<p>The group may not exist, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'groups' }">Browse groups</RouterLink>
		</div>

		<div v-else-if="view === 'restricted'" class="social-state" role="status" data-state="restricted">
			<p class="eyebrow">Group chat</p>
			<h1>Only members of {{ group.title }} can chat here.</h1>
			<p>Join by invitation or request to read and write in the group’s room.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'group', params: { id: group.id } }">About this group</RouterLink>
		</div>

		<template v-else>
			<header class="social-view__head group-view__head">
				<p class="eyebrow">Group chat</p>
				<h1>{{ group.title }}</h1>
				<p class="group-view__meta"><span>Only members of this group can read and write here.</span></p>
				<RouterLink class="text-link" :to="{ name: 'messages' }">All messages <span aria-hidden="true">↗</span></RouterLink>
			</header>

			<GroupNav :group="group" />

			<p v-if="room.notice.value" class="message-connection" role="status" data-testid="room-notice">{{ room.notice.value }}</p>
			<p v-if="reconnecting" class="message-connection" role="status">Live delivery is reconnecting. Messages you send are still saved, and the room refreshes on its own.</p>

			<MessageList
				:messages="room.messages.value"
				:pending="pending"
				:viewer-id="room.viewerId.value"
				:label="`Messages in ${group.title}`"
				:older="room.older"
				@load-older="room.loadOlder()"
				@retry="(id) => messages.retry(key, id)"
				@discard="(id) => messages.discard(key, id)"
			/>

			<MessageComposer
				ref="composer"
				:model-value="draft?.body ?? ''"
				:allow-image="false"
				:label="`Message ${group.title}`"
				@update:model-value="setBody"
				@submit="submit"
			/>
		</template>
	</section>
</template>
