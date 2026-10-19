<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import SocialAvatar from '../social/SocialAvatar.vue';
import { parseUserId } from '../social/social-utils.js';
import MessageComposer from './MessageComposer.vue';
import MessageList from './MessageList.vue';
import { messagesKey } from './message-state.js';
import { lastId } from './message-utils.js';
import { useThread } from './use-thread.js';

const messages = inject(messagesKey);
const route = useRoute();
const userId = computed(() => parseUserId(route.params.id));
const thread = useThread(userId);
const composer = ref(null);

// The conversation is shown only while the server confirms it: a stranger, a
// pending requester, a missing account and a lost relationship with no history
// are one and the same unavailable state, with nothing about the person.
const view = computed(() => {
	if (thread.status.value === 'loading') return 'checking';
	if (thread.status.value === 'unavailable') return 'unavailable';
	if (thread.status.value !== 'ready') return 'missing';
	return thread.entry.value ? 'ready' : 'checking';
});
const partner = computed(() => thread.entry.value);
const canSend = computed(() => Boolean(partner.value?.can_send));
const presence = computed(() => (partner.value ? messages.presenceFor(partner.value) : null));
const draft = computed(() => (userId.value ? messages.draft(userId.value) : null));
const pending = computed(() => (userId.value ? messages.outbox(userId.value) : []));
const reconnecting = computed(() => messages.connection() !== 'online');

function setBody(value) {
	messages.setBody(userId.value, value);
}

function submit() {
	messages.send(userId.value);
	composer.value?.focus();
}

// Mark read only after the messages are rendered on a visible page, using the
// largest committed ID shown. The cursor never moves backwards and own sends
// never count as unread, so only an unread incoming message triggers a write.
const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
const onVisibility = () => {
	visible.value = document.visibilityState !== 'hidden';
};
document.addEventListener('visibilitychange', onVisibility);
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility));

let marking = 0;
watch(userId, () => {
	marking = 0;
});
watch(
	[() => lastId(thread.messages.value), visible, view, () => thread.entry.value],
	async () => {
		if (view.value !== 'ready' || !visible.value) return;
		const rendered = lastId(thread.messages.value);
		const unread = thread.messages.value.some(
			(message) =>
				message.sender_id !== thread.viewerId.value && message.id > thread.readThrough.value,
		);
		if (!unread || rendered <= Math.max(thread.readThrough.value, marking)) return;
		marking = rendered;
		const result = await messages.markRead(userId.value, rendered);
		if (result.status !== 'ok') marking = 0;
	},
	{ flush: 'post', immediate: true },
);
</script>

<template>
	<section class="social-view message-view conversation-view" data-screen="conversation" :aria-busy="view === 'checking'">
		<RouterLink class="text-link conversation-view__back" :to="{ name: 'messages' }"><span aria-hidden="true">←</span> All messages</RouterLink>

		<p v-if="view === 'checking'" class="social-status" role="status">Opening the conversation…</p>

		<div v-else-if="view === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t open this conversation right now.</h1>
			<p>Nothing is shown until we can confirm you may read it.</p>
			<button class="button button--secondary" type="button" @click="thread.reload('hard')">Try again</button>
		</div>

		<div v-else-if="view === 'missing'" class="social-state" data-state="missing">
			<p class="eyebrow">Messages</p>
			<h1>This conversation isn’t available.</h1>
			<p>It may not exist, or you may not be able to message this person.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'messages' }">Your messages</RouterLink>
		</div>

		<template v-else>
			<header class="conversation-head">
				<SocialAvatar :name="partner.name" size="md" />
				<div class="conversation-head__copy">
					<p class="eyebrow">Private conversation</p>
					<h1>{{ partner.name }}</h1>
					<p v-if="presence !== null" class="presence" :data-online="presence">
						<span class="presence__dot" aria-hidden="true"></span>
						<span>{{ presence ? 'Online' : 'Offline' }}</span>
					</p>
				</div>
			</header>

			<p v-if="reconnecting" class="message-connection" role="status">Live delivery is reconnecting. Messages you send are still saved, and the conversation refreshes on its own.</p>

			<MessageList
				:messages="thread.messages.value"
				:pending="pending"
				:viewer-id="thread.viewerId.value"
				:label="`Messages with ${partner.name}`"
				:image-label="`Image in your conversation with ${partner.name}`"
				:older="thread.older"
				@load-older="thread.loadOlder()"
				@retry="(id) => messages.retry(userId, id)"
				@discard="(id) => messages.discard(userId, id)"
			/>

			<MessageComposer
				ref="composer"
				:model-value="draft?.body ?? ''"
				:attachment="draft?.attachment ?? null"
				:disabled="!canSend"
				:disabled-reason="`You can’t message ${partner.name} any more. Earlier messages stay readable here.`"
				:label="`Message ${partner.name}`"
				@update:model-value="setBody"
				@submit="submit"
				@attach="(file) => messages.attachImage(userId, file)"
				@remove-attachment="messages.removeAttachment(userId)"
			/>
		</template>
	</section>
</template>
