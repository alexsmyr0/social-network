<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
import { computed, inject } from 'vue';

import { messagesKey } from './message-state.js';

// The always-visible message indicator. It is deliberately not the
// notification badge: a different control, shape and colour, its own count
// from its own endpoint, and a label that never says "notification".
const messages = inject(messagesKey, null);
const count = computed(() => messages?.state.unreadCount ?? null);
const label = computed(() =>
	count.value === null
		? 'Messages, unread count unavailable'
		: `Messages, ${count.value} unread ${count.value === 1 ? 'message' : 'messages'}`,
);
</script>

<template>
	<RouterLink v-if="messages" class="message-badge-link" :to="{ name: 'messages' }" :aria-label="label" data-testid="message-indicator">
		<span aria-hidden="true">Messages</span>
		<span class="message-badge" :class="{ 'message-badge--zero': count === 0, 'message-badge--unknown': count === null }" aria-hidden="true">{{ count === null ? '—' : count }}</span>
	</RouterLink>
</template>
