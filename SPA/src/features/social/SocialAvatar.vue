<script setup>
import { ref, watch } from 'vue';

// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { initialsOf } from './social-utils.js';

const props = defineProps({
	name: { type: String, required: true },
	src: { type: String, default: null },
	size: { type: String, default: 'md' },
});

// An avatar can disappear after a permission change; fall back to initials
// instead of showing a broken image.
const failed = ref(false);
watch(
	() => props.src,
	() => {
		failed.value = false;
	},
);
</script>

<template>
	<span class="avatar" :class="`avatar--${size}`" aria-hidden="true">
		<img v-if="src && !failed" :src="src" alt="" loading="lazy" @error="failed = true" />
		<span v-else class="avatar__initials">{{ initialsOf(name) }}</span>
	</span>
</template>
