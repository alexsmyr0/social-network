<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { groupSections } from './use-group.js';

const props = defineProps({
	group: { type: Object, required: true },
});

const route = useRoute();
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const sections = computed(() => groupSections(props.group.viewer.role));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const current = (name) => (route.name === name ? 'page' : undefined);
</script>

<template>
	<nav class="groups-tabs group-nav" :aria-label="`${group.title} sections`">
		<RouterLink v-for="section in sections" :key="section.name" :to="{ name: section.name, params: { id: group.id } }" :aria-current="current(section.name)">{{ section.label }}</RouterLink>
	</nav>
</template>
