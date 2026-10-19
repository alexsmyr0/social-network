<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: bindings used in Vue templates
import { nextTick, onUnmounted, ref } from 'vue';

import { EMOJI } from './message-utils.js';

defineProps({
	disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['pick']);

const panelId = `emoji-panel-${Math.random().toString(36).slice(2, 10)}`;
const open = ref(false);
const toggle = ref(null);
const panel = ref(null);
const root = ref(null);

async function show() {
	open.value = !open.value;
	if (open.value) {
		await nextTick();
		panel.value?.querySelector('button')?.focus();
	}
}

async function close({ refocus }) {
	open.value = false;
	if (refocus) {
		await nextTick();
		toggle.value?.focus();
	}
}

function onKeydown(event) {
	if (event.key === 'Escape' && open.value) {
		event.preventDefault();
		event.stopPropagation();
		void close({ refocus: true });
	}
}

function onOutside(event) {
	if (open.value && !root.value?.contains(event.target)) open.value = false;
}

document.addEventListener('pointerdown', onOutside);
onUnmounted(() => document.removeEventListener('pointerdown', onOutside));
</script>

<template>
	<div ref="root" class="emoji-picker" @keydown="onKeydown">
		<button ref="toggle" class="button button--secondary emoji-picker__toggle" type="button" :disabled="disabled" :aria-expanded="open" :aria-controls="panelId" @click="show">
			<span aria-hidden="true">🙂</span>
			<span>Emoji</span>
		</button>
		<div v-if="open" :id="panelId" ref="panel" class="emoji-picker__panel" role="group" aria-label="Choose an emoji">
			<button v-for="[glyph, name] in EMOJI" :key="name" class="emoji-picker__item" type="button" :aria-label="name" :title="name" @click="emit('pick', glyph)">
				<span aria-hidden="true">{{ glyph }}</span>
			</button>
		</div>
	</div>
</template>
