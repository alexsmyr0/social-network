<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, nextTick, ref } from 'vue';

import EmojiPicker from './EmojiPicker.vue';
import {
	bodyLength,
	bodyMessage,
	bodyProblem,
	IMAGE_TYPES,
	MESSAGE_MAX,
	normalizeBody,
} from './message-utils.js';
import ProtectedImage from './ProtectedImage.vue';

// Shared by private messages (SN-A19) and group rooms (SN-A20): the text box,
// emoji picker and send control. Images are an opt-in (`allowImage`). The
// parent owns the draft, so it survives leaving and reopening the
// conversation and is cleared with the account.
const props = defineProps({
	modelValue: { type: String, default: '' },
	attachment: { type: Object, default: null },
	allowImage: { type: Boolean, default: true },
	disabled: { type: Boolean, default: false },
	disabledReason: { type: String, default: '' },
	label: { type: String, default: 'Message' },
});
const emit = defineEmits(['update:modelValue', 'submit', 'attach', 'remove-attachment']);

const field = ref(null);
const fileInput = ref(null);
const accept = IMAGE_TYPES.join(',');

const length = computed(() => bodyLength(props.modelValue));
const problem = computed(() => bodyProblem(props.modelValue));
const hasImage = computed(() => props.attachment?.status === 'ready');
const uploading = computed(() => props.attachment?.status === 'uploading');
const empty = computed(() => normalizeBody(props.modelValue) === '' && !hasImage.value);
const canSubmit = computed(
	() => !props.disabled && !problem.value && !uploading.value && !empty.value,
);
const problemText = computed(() => bodyMessage(problem.value));

function submit() {
	if (canSubmit.value) emit('submit');
}

function onEnter(event) {
	// Enter sends, Shift+Enter adds a line. Never while an input method is composing.
	if (event.isComposing) return;
	event.preventDefault();
	submit();
}

async function insert(glyph) {
	const element = field.value;
	const value = props.modelValue;
	const start = element?.selectionStart ?? value.length;
	const end = element?.selectionEnd ?? value.length;
	emit('update:modelValue', `${value.slice(0, start)}${glyph}${value.slice(end)}`);
	await nextTick();
	if (!element) return;
	element.focus();
	const caret = start + glyph.length;
	element.setSelectionRange(caret, caret);
}

function onFile(event) {
	const [file] = event.target.files ?? [];
	if (file) emit('attach', file);
	if (fileInput.value) fileInput.value.value = '';
}

defineExpose({ focus: () => field.value?.focus() });
</script>

<template>
	<form class="message-composer" novalidate @submit.prevent="submit">
		<p v-if="disabled && disabledReason" class="message-composer__reason" role="status">{{ disabledReason }}</p>
		<label class="message-composer__label" for="message-body">{{ label }}</label>
		<textarea
			id="message-body"
			ref="field"
			class="message-composer__field"
			rows="3"
			:value="modelValue"
			:disabled="disabled"
			:aria-invalid="Boolean(problem)"
			aria-describedby="message-body-count message-body-error"
			autocomplete="off"
			@input="emit('update:modelValue', $event.target.value)"
			@keydown.enter.exact="onEnter"
		></textarea>
		<div class="message-composer__meta">
			<span id="message-body-count" class="message-composer__count" :class="{ 'message-composer__count--over': length > MESSAGE_MAX }">{{ length.toLocaleString('en-GB') }} / {{ MESSAGE_MAX.toLocaleString('en-GB') }}</span>
			<span class="field-hint">Enter sends · Shift+Enter adds a line</span>
		</div>
		<p id="message-body-error" class="field-error" :role="problem ? 'alert' : undefined">{{ problemText }}</p>

		<div v-if="allowImage" class="message-composer__image">
			<figure v-if="hasImage" class="message-composer__preview">
				<ProtectedImage :url="attachment.url" alt="The image you are about to send" />
				<figcaption>{{ attachment.name }}</figcaption>
			</figure>
			<p v-else-if="uploading" class="message-composer__notice" role="status">Uploading {{ attachment.name }}…</p>
			<p v-if="attachment?.status === 'error'" class="field-error" role="alert">{{ attachment.message }}</p>
			<div class="message-composer__image-actions">
				<input ref="fileInput" class="visually-hidden file-input" id="message-image" type="file" :accept="accept" :disabled="disabled || uploading" aria-describedby="message-image-hint" @change="onFile" />
				<label class="file-button" for="message-image">{{ hasImage ? 'Replace image' : 'Add an image' }}</label>
				<button v-if="attachment && !uploading" class="text-button" type="button" @click="emit('remove-attachment')">Remove image</button>
			</div>
			<p id="message-image-hint" class="field-hint">JPEG, PNG or GIF · up to 10 MiB</p>
		</div>

		<div class="message-composer__actions">
			<EmojiPicker :disabled="disabled" @pick="insert" />
			<button class="button button--primary message-composer__send" type="submit" :disabled="!canSubmit">Send</button>
		</div>
	</form>
</template>
