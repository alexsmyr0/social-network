<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import { sessionKey } from '../auth/session-state.js';
import { contentKey } from './content-state.js';
import { fieldMessage, imageProblem, normalizeText, textProblem } from './content-utils.js';

const props = defineProps({
	postId: { type: Number, required: true },
	comment: { type: Object, default: null },
	parentId: { type: Number, default: null },
});
const emit = defineEmits(['saved', 'cancel']);
const content = inject(contentKey);
const session = inject(sessionKey);
const text = ref(props.comment?.body ?? '');
const version = ref(props.comment?.version);
const savedImage = ref(props.comment?.image_url ?? null);
const image = ref(null);
const removed = ref(false);
const preview = ref('');
const error = ref('');
const stale = ref(false);
const input = ref(null);
const storedImage = computed(() => (removed.value ? null : savedImage.value));
const busy = computed(() =>
	content.isPending(props.comment ? `comment-${props.comment.id}` : `thread-${props.postId}`),
);
function release() {
	if (preview.value) URL.revokeObjectURL(preview.value);
	preview.value = '';
}
onUnmounted(release);
watch(
	() => session.state.account?.id,
	() => {
		text.value = '';
		image.value = null;
		release();
		error.value = '';
	},
);
function choose(event) {
	const file = event.target.files?.[0];
	if (!file) return;
	const problem = imageProblem(file);
	if (problem) {
		error.value = problem;
		event.target.value = '';
		return;
	}
	release();
	image.value = file;
	preview.value = URL.createObjectURL(file);
	removed.value = false;
	error.value = '';
}
function remove() {
	release();
	image.value = null;
	removed.value = true;
	if (input.value) input.value.value = '';
}
async function latest() {
	const accountId = session.state.account?.id;
	const result = await content.api.fetchComment(props.comment.id);
	if (accountId !== session.state.account?.id) return;
	if (result.status === 'ok') {
		text.value = result.comment.body;
		version.value = result.comment.version;
		savedImage.value = result.comment.image_url;
		remove();
		removed.value = false;
		stale.value = false;
		error.value = '';
	} else {
		error.value = 'This comment could not be reloaded.';
	}
}
function writeError(result) {
	if (result.status === 'rejected')
		return (
			Object.entries(result.fields ?? {})
				.map(([field, code]) => fieldMessage(field, code))
				.join(' ') || 'The comment could not be saved.'
		);
	const messages = {
		stale: 'This comment changed. Load the latest version before editing again.',
		'not-found': 'The comment or discussion is no longer available.',
		'invalid-image': 'Choose a valid JPEG, PNG or GIF.',
		'too-large': 'The image is too large.',
	};
	return (
		messages[result.status] ??
		'The change could not be confirmed. Check the discussion before submitting again.'
	);
}
function validate(body) {
	const problem = textProblem('body', body);
	if (problem) return fieldMessage('body', problem);
	return !body && !image.value && !storedImage.value ? 'Write a comment or add an image.' : '';
}
async function save() {
	if (busy.value || stale.value) return;
	const body = normalizeText(text.value);
	error.value = validate(body);
	if (error.value) return;
	const fields = {
		body,
		...(image.value ? { image: image.value } : {}),
		...(props.comment && removed.value ? { removeImage: true } : {}),
	};
	const result = props.comment
		? await content.updateComment(props.comment.id, { ...fields, expectedVersion: version.value })
		: await content.createComment(props.postId, { ...fields, parentCommentId: props.parentId });
	if (['superseded', 'unauthenticated', 'busy'].includes(result.status)) return;
	if (result.status === 'ok') {
		text.value = '';
		remove();
		removed.value = false;
		error.value = '';
		emit('saved', result.comment);
		return;
	}
	stale.value = result.status === 'stale';
	if (['invalid-image', 'too-large'].includes(result.status)) {
		release();
		image.value = null;
		if (input.value) input.value.value = '';
	}
	error.value = writeError(result);
}
</script>
<template>
 <form class="comment-form" :aria-busy="busy" @submit.prevent="save">
  <label :for="`comment-body-${comment?.id ?? 'new'}`">{{ comment ? 'Edit comment' : parentId ? `Reply to comment ${parentId}` : 'Your comment' }}</label>
  <textarea :id="`comment-body-${comment?.id ?? 'new'}`" v-model="text" rows="4" :disabled="busy" :aria-describedby="error ? `comment-error-${comment?.id ?? 'new'}` : undefined"></textarea>
  <label>JPEG, PNG or GIF (up to 5 MiB)<input ref="input" type="file" accept="image/jpeg,image/png,image/gif" :disabled="busy" @change="choose" /></label>
  <figure v-if="preview || storedImage" class="post-card__media"><img :src="preview || storedImage" alt="Comment attachment preview" /></figure>
  <button v-if="preview || storedImage" type="button" :disabled="busy" @click="remove">Remove image</button>
  <p v-if="error" :id="`comment-error-${comment?.id ?? 'new'}`" class="field-error" role="alert">{{ error }}</p>
  <button v-if="stale" type="button" class="button button--secondary" @click="latest">Load latest comment</button>
  <div class="discussion-actions">
   <button class="button button--primary" type="submit" :disabled="busy || stale">{{ busy ? 'Saving…' : comment ? 'Save comment' : 'Send comment' }}</button>
   <button v-if="comment || parentId" class="button button--secondary" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
  </div>
 </form>
</template>
