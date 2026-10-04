<script setup>
import { computed, inject, nextTick, ref } from 'vue';

import { socialKey } from './social-state.js';

const props = defineProps({
	profile: { type: Object, required: true },
});

const social = inject(socialKey);
const confirming = ref(false);
const toggle = ref(null);
const confirmGroup = ref(null);
const isPrivate = computed(() => props.profile.visibility === 'private');
const pending = computed(() => social.state.privacyPending);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const message = computed(() => social.state.privacyMessage);

async function closeConfirm() {
	confirming.value = false;
	await nextTick();
	toggle.value?.focus();
}

async function submit(visibility) {
	await social.changePrivacy({ visibility, expectedVersion: props.profile.version });
	if (confirming.value) await closeConfirm();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function choose() {
	if (pending.value) return;
	if (isPrivate.value) {
		confirming.value = true;
		void nextTick().then(() => confirmGroup.value?.focus());
		return;
	}
	void submit('private');
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function keepPrivate() {
	if (!pending.value) void closeConfirm();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function confirmPublic() {
	if (pending.value) return;
	void submit('public');
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

		<div v-if="confirming" ref="confirmGroup" class="privacy-control__confirm" role="group" aria-labelledby="privacy-confirm-title" tabindex="-1">
			<h3 id="privacy-confirm-title">Make your profile public?</h3>
			<p>Every signed-in person will be able to see your details. Any pending follow requests will be accepted automatically.</p>
			<div class="privacy-control__actions">
				<button class="button button--primary" type="button" :aria-disabled="pending" :aria-busy="pending" @click="confirmPublic">
					{{ pending ? 'Saving…' : 'Make public and accept requests' }}
				</button>
				<button class="button button--secondary" type="button" :aria-disabled="pending" @click="keepPrivate">Keep private</button>
			</div>
		</div>
		<button v-else ref="toggle" class="button button--secondary" type="button" :aria-disabled="pending" :aria-busy="pending" @click="choose">
			{{ pending ? 'Saving…' : isPrivate ? 'Make profile public' : 'Make profile private' }}
		</button>

		<p class="privacy-control__message" aria-live="polite">{{ message }}</p>
	</section>
</template>
