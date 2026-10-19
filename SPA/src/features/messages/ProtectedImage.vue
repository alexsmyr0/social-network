<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
import { inject, onUnmounted, ref, watch } from 'vue';

import { messagesKey } from './message-state.js';

const props = defineProps({
	url: { type: String, required: true },
	alt: { type: String, required: true },
});

const messages = inject(messagesKey);
const src = ref(null);
const state = ref('loading');
let held = null;
let token = 0;

function drop() {
	if (held) messages.images.release(held);
	held = null;
	src.value = null;
}

async function show(url) {
	drop();
	state.value = 'loading';
	const mine = ++token;
	const result = await messages.images.acquire(url);
	if (mine !== token) {
		if (result.status === 'ok') messages.images.release(url);
		return;
	}
	if (result.status === 'ok') {
		held = url;
		src.value = result.src;
		state.value = 'ready';
	} else {
		state.value = 'failed';
	}
}

watch(() => props.url, show, { immediate: true });
onUnmounted(() => {
	token += 1;
	drop();
});
</script>

<template>
	<img v-if="state === 'ready'" class="message-image" :src="src" :alt="alt" @error="state = 'failed'" />
	<span v-else-if="state === 'loading'" class="message-image message-image--pending" role="status">Loading image…</span>
	<span v-else class="message-image message-image--failed" role="status">Image unavailable</span>
</template>
