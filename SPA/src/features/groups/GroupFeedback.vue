<script setup>
import { ref } from 'vue';

defineProps({
	feedback: { type: Object, default: null },
});

const region = ref(null);
defineExpose({ focus: () => region.value?.focus() });
</script>

<template>
	<div ref="region" class="group-feedback" tabindex="-1" aria-live="polite">
		<p v-if="feedback" class="group-feedback__text" :class="`group-feedback__text--${feedback.tone}`" :role="feedback.tone === 'error' ? 'alert' : 'status'">{{ feedback.text }}</p>
	</div>
</template>
