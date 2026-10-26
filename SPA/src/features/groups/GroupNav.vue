<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { useRoomSummary } from '../messages/use-room-summary.js';
import { groupSections } from './use-group.js';

const props = defineProps({
	group: { type: Object, required: true },
});

const route = useRoute();
const sections = computed(() => groupSections(props.group.viewer.role));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const current = (name) => (route.name === name ? 'page' : undefined);
// The chat tab carries this group's own unread count: the server's number for
// the viewer's membership, separate from the notification badge.
const groupId = computed(() => props.group.id);
// Only members have a room to count; anyone else asks the server nothing.
const hasChat = computed(() => sections.value.some((section) => section.name === 'group-chat'));
const { unread } = useRoomSummary(groupId, hasChat);
// A tab with unread messages says so in its name; every other tab is its label.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function labelOf(section) {
	if (section.name !== 'group-chat' || !unread.value) return undefined;
	return `${section.label}, ${unread.value} unread ${unread.value === 1 ? 'message' : 'messages'}`;
}
</script>

<template>
	<nav class="groups-tabs group-nav" :aria-label="`${group.title} sections`">
		<RouterLink v-for="section in sections" :key="section.name" :to="{ name: section.name, params: { id: group.id } }" :aria-current="current(section.name)" :aria-label="labelOf(section)">
			<span>{{ section.label }}</span>
			<span v-if="section.name === 'group-chat' && unread" class="message-unread group-nav__unread" aria-hidden="true">{{ unread }}</span>
		</RouterLink>
	</nav>
</template>
