<script setup>
import { onBeforeUnmount, onMounted, ref, useId } from 'vue';

// A modal confirmation for a change the person should not make by accident.
// The parent renders it only while asking; Escape and the cancel button both
// emit `cancel`, and neither choice is taken while `busy`.
const props = defineProps({
	title: { type: String, required: true },
	confirmLabel: { type: String, required: true },
	cancelLabel: { type: String, default: 'Cancel' },
	busy: { type: Boolean, default: false },
	busyLabel: { type: String, default: 'Saving…' },
});
const emit = defineEmits(['confirm', 'cancel']);

const dialog = ref(null);
const cancelButton = ref(null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const titleId = useId();

onMounted(() => {
	const element = dialog.value;
	// jsdom has no showModal; an open attribute keeps the content reachable there.
	if (typeof element.showModal === 'function') element.showModal();
	else element.setAttribute('open', '');
	// The safe choice takes focus, so a stray Enter keeps things as they are.
	cancelButton.value?.focus();
});

onBeforeUnmount(() => {
	if (dialog.value?.open && typeof dialog.value.close === 'function') dialog.value.close();
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function confirm() {
	if (!props.busy) emit('confirm');
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function cancel(event) {
	event?.preventDefault();
	if (!props.busy) emit('cancel');
}
</script>

<template>
	<dialog ref="dialog" class="confirm-dialog" :aria-labelledby="titleId" @cancel="cancel">
		<h2 :id="titleId" class="confirm-dialog__title">{{ title }}</h2>
		<div class="confirm-dialog__body"><slot /></div>
		<div class="confirm-dialog__actions">
			<button class="button button--primary" type="button" :aria-disabled="busy" :aria-busy="busy" @click="confirm">
				{{ busy ? busyLabel : confirmLabel }}
			</button>
			<button ref="cancelButton" class="button button--secondary" type="button" :aria-disabled="busy" @click="cancel">
				{{ cancelLabel }}
			</button>
		</div>
	</dialog>
</template>
