<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import { socialKey } from './social-state.js';

const props = defineProps({
	person: { type: Object, required: true },
});

const social = inject(socialKey);
const relationship = computed(() => props.person.relationship);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const visible = computed(() => relationship.value.state !== 'self');
const busy = computed(() => Boolean(social.state.pendingFollows[props.person.id]));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const message = computed(() => social.state.followMessages[props.person.id] ?? '');

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const stateLabel = computed(() => {
	if (relationship.value.state === 'pending') return 'Request pending';
	if (relationship.value.state === 'accepted') return 'Following';
	return '';
});

const action = computed(() => {
	const { state, follow_id: followId } = relationship.value;
	const { id, display_name: name } = props.person;
	if (state === 'pending') {
		return {
			label: 'Cancel request',
			accessible: `Cancel follow request to ${name}`,
			run: () => social.cancel(id, followId),
			tone: 'secondary',
		};
	}
	if (state === 'accepted') {
		return {
			label: 'Unfollow',
			accessible: `Unfollow ${name}`,
			run: () => social.unfollow(id, followId),
			tone: 'secondary',
		};
	}
	return {
		label: 'Follow',
		accessible: `Follow ${name}`,
		run: () => social.follow(id),
		tone: 'primary',
	};
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const buttonLabel = computed(() => (busy.value ? 'Working…' : action.value.label));

const button = ref(null);
const confirmingUnfollow = ref(false);
// A relationship that changes underneath the question (another tab, a socket
// signal) closes it; the button then shows the new action.
watch(
	() => relationship.value.state,
	(state) => {
		if (state !== 'accepted') confirmingUnfollow.value = false;
	},
);

async function closeConfirm() {
	confirmingUnfollow.value = false;
	await nextTick();
	button.value?.focus();
}

// Unfollowing asks first; following and cancelling a request do not.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function activate() {
	if (busy.value) return;
	if (relationship.value.state === 'accepted') {
		confirmingUnfollow.value = true;
		return;
	}
	void action.value.run();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function confirmUnfollow() {
	if (busy.value || relationship.value.state !== 'accepted') return;
	await action.value.run();
	await closeConfirm();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function keepFollowing() {
	if (!busy.value) void closeConfirm();
}
</script>

<template>
	<div v-if="visible" class="follow-control" :data-relationship="relationship.state">
		<span v-if="stateLabel" class="follow-control__state">{{ stateLabel }}</span>
		<button
			ref="button"
			class="follow-control__button"
			:class="`follow-control__button--${action.tone}`"
			type="button"
			:aria-disabled="busy"
			:aria-busy="busy"
			:aria-label="action.accessible"
			@click="activate"
		>
			{{ buttonLabel }}
		</button>
		<p class="follow-control__message" aria-live="polite">{{ message }}</p>
		<ConfirmDialog
			v-if="confirmingUnfollow"
			:title="`Unfollow ${person.display_name}?`"
			confirm-label="Unfollow"
			cancel-label="Keep following"
			busy-label="Unfollowing…"
			:busy="busy"
			@confirm="confirmUnfollow"
			@cancel="keepFollowing"
		>
			<p>Posts they share only with followers will no longer reach you. If their profile is private, following them again needs a new request.</p>
		</ConfirmDialog>
	</div>
</template>
