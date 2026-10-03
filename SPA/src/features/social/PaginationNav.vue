<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const props = defineProps({
	page: { type: Number, required: true },
	totalPages: { type: Number, required: true },
	label: { type: String, default: 'Pagination' },
});

const route = useRoute();

function target(page) {
	const query = { ...route.query };
	if (page <= 1) delete query.page;
	else query.page = String(page);
	return { path: route.path, query };
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const previous = computed(() => (props.page > 1 ? target(props.page - 1) : null));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const next = computed(() => (props.page < props.totalPages ? target(props.page + 1) : null));
</script>

<template>
	<nav v-if="totalPages > 1" class="pager" :aria-label="label">
		<RouterLink v-if="previous" class="pager__link" :to="previous" rel="prev">Previous</RouterLink>
		<span v-else class="pager__link pager__link--off" aria-disabled="true">Previous</span>
		<p class="pager__position">Page {{ Math.min(page, totalPages) }} of {{ totalPages }}</p>
		<RouterLink v-if="next" class="pager__link" :to="next" rel="next">Next</RouterLink>
		<span v-else class="pager__link pager__link--off" aria-disabled="true">Next</span>
	</nav>
</template>
