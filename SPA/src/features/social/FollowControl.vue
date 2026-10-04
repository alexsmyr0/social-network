<script setup>
import { computed, inject } from 'vue';

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

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function activate() {
	if (busy.value) return;
	void action.value.run();
}
</script>

<template>
	<div v-if="visible" class="follow-control" :data-relationship="relationship.state">
		<span v-if="stateLabel" class="follow-control__state">{{ stateLabel }}</span>
		<button
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
	</div>
</template>
