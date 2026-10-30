<script setup>
import { computed, inject, nextTick, ref } from 'vue';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import { socialKey } from './social-state.js';

const props = defineProps({
	profile: { type: Object, required: true },
});

const social = inject(socialKey);
const confirming = ref(false);
const toggle = ref(null);
const isPrivate = computed(() => props.profile.visibility === 'private');
const pending = computed(() => social.state.privacyPending);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const message = computed(() => social.state.privacyMessage);

async function closeConfirm() {
	confirming.value = false;
	await nextTick();
	toggle.value?.focus();
}

// Both directions ask first: going public shows details to everyone and
// accepts pending requests; going private hides them from non-followers.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function choose() {
	if (!pending.value) confirming.value = true;
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function keepAsIs() {
	if (!pending.value) void closeConfirm();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function confirmChange() {
	if (pending.value) return;
	const visibility = isPrivate.value ? 'public' : 'private';
	await social.changePrivacy({ visibility, expectedVersion: props.profile.version });
	if (confirming.value) await closeConfirm();
}
</script>

<template>
	<section class="privacy-control" aria-labelledby="privacy-heading">
		<h2 id="privacy-heading">Profile privacy</h2>
		<p class="privacy-control__current">
			Your profile is <strong>{{ isPrivate ? 'private' : 'public' }}</strong>.
		</p>
		<p v-if="isPrivate" class="privacy-control__hint">
			Only you and people you’ve accepted see your details. Everyone else sees just your name and a follow button.
		</p>
		<p v-else class="privacy-control__hint">
			Anyone signed in can see your details. Making it private keeps current followers; new followers will need your approval.
		</p>

		<button ref="toggle" class="button button--secondary" type="button" :aria-disabled="pending" :aria-busy="pending" @click="choose">
			{{ pending ? 'Saving…' : isPrivate ? 'Make profile public' : 'Make profile private' }}
		</button>

		<ConfirmDialog
			v-if="confirming && isPrivate"
			title="Make your profile public?"
			confirm-label="Make public and accept requests"
			cancel-label="Keep private"
			:busy="pending"
			@confirm="confirmChange"
			@cancel="keepAsIs"
		>
			<p>Every signed-in person will be able to see your details. Any pending follow requests will be accepted automatically.</p>
		</ConfirmDialog>
		<ConfirmDialog
			v-else-if="confirming"
			title="Make your profile private?"
			confirm-label="Make private"
			cancel-label="Keep public"
			:busy="pending"
			@confirm="confirmChange"
			@cancel="keepAsIs"
		>
			<p>Only you and your current followers will see your details. New followers will need your approval.</p>
		</ConfirmDialog>

		<p class="privacy-control__message" aria-live="polite">{{ message }}</p>
	</section>
</template>
