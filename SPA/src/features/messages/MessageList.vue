<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { nextTick, onMounted, ref, watch } from 'vue';

import { timeLabel } from './message-utils.js';
import ProtectedImage from './ProtectedImage.vue';

// Shared by private messages and group rooms. Committed messages come in
// ascending ID order; messages still being sent, or that failed, follow them in
// the order they were written. Nothing here counts or reorders by arrival.
const props = defineProps({
	messages: { type: Array, required: true },
	pending: { type: Array, default: () => [] },
	viewerId: { type: Number, default: null },
	label: { type: String, required: true },
	imageLabel: { type: String, default: 'Image in this conversation' },
	older: { type: Object, default: () => ({ hasMore: false, loading: false, failed: false }) },
});
const emit = defineEmits(['load-older', 'retry', 'discard']);

const scroller = ref(null);
let atBottom = true;
let lastHeight = 0;
let lastFirst = null;

function onScroll() {
	const element = scroller.value;
	if (element) atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

async function settle() {
	await nextTick();
	const element = scroller.value;
	if (!element) return;
	const first = props.messages[0]?.id ?? null;
	if (lastFirst !== null && first !== null && first < lastFirst) {
		// Older history was added above: keep the reader where they were.
		element.scrollTop += element.scrollHeight - lastHeight;
	} else if (atBottom) {
		element.scrollTop = element.scrollHeight;
	}
	lastHeight = element.scrollHeight;
	lastFirst = first;
}

watch(() => [props.messages.length, props.messages[0]?.id, props.pending.length], settle, {
	flush: 'post',
});
onMounted(settle);
</script>

<template>
	<section class="message-thread" :aria-label="label">
		<div class="message-thread__older">
			<button v-if="older.hasMore" class="button button--secondary" type="button" :disabled="older.loading" :aria-busy="older.loading" @click="emit('load-older')">{{ older.loading ? 'Loading earlier messages…' : 'Load earlier messages' }}</button>
			<p v-if="older.failed" class="field-error" role="alert">We couldn’t load earlier messages. Try again.</p>
			<p v-else-if="!older.hasMore && messages.length" class="field-hint">This is the start of the conversation.</p>
		</div>
		<ol ref="scroller" class="message-list" role="log" aria-live="polite" aria-relevant="additions" :aria-label="label" tabindex="0" @scroll.passive="onScroll">
			<li v-if="messages.length === 0 && pending.length === 0" class="message-list__empty">No messages yet. Say hello.</li>
			<li v-for="message in messages" :key="message.id" class="message" :class="message.sender_id === viewerId ? 'message--mine' : 'message--theirs'" :data-message-id="message.id">
				<p class="message__who">{{ message.sender_id === viewerId ? 'You' : message.sender_username }}</p>
				<p v-if="message.body" class="message__body">{{ message.body }}</p>
				<ProtectedImage v-if="message.image_url" :url="message.image_url" :alt="imageLabel" />
				<time class="message__time" :datetime="message.created_at">{{ timeLabel(message.created_at) }}</time>
			</li>
			<li v-for="entry in pending" :key="entry.client_id" class="message message--mine message--pending" :class="{ 'message--failed': entry.status === 'failed' }" :data-client-id="entry.client_id" :data-status="entry.status">
				<p class="message__who">You</p>
				<p v-if="entry.body" class="message__body">{{ entry.body }}</p>
				<ProtectedImage v-if="entry.image_url" :url="entry.image_url" :alt="imageLabel" />
				<p v-if="entry.status === 'sending'" class="message__state" role="status">Sending…</p>
				<template v-else>
					<p class="message__state message__state--failed" role="alert">{{ entry.message }}</p>
					<div class="message__actions">
						<button v-if="entry.retryable" class="button button--secondary" type="button" @click="emit('retry', entry.client_id)">Retry</button>
						<button class="button button--secondary" type="button" @click="emit('discard', entry.client_id)">Discard</button>
					</div>
				</template>
			</li>
		</ol>
	</section>
</template>
