<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
import { computed, inject, ref, watch } from 'vue';

import { sessionKey } from '../auth/session-state.js';
import { useGroupReporter } from '../groups/use-group-feedback.js';
import { eventsKey } from './event-state.js';
import { CHOICE_LABELS } from './event-utils.js';

const props = defineProps({
	group: { type: Object, required: true },
	event: { type: Object, required: true },
});

const session = inject(sessionKey);
const events = inject(eventsKey);
const report = useGroupReporter();
const message = ref('');
const tone = ref('error');

const current = computed(() => props.event.viewer_response?.choice ?? null);
const pending = computed(() => events.isPending(`respond-${props.event.id}`));
const choices = Object.entries(CHOICE_LABELS);

watch([() => props.event.id, () => session.state.account?.id ?? null], () => {
	message.value = '';
});

async function choose(choice) {
	if (pending.value || choice === current.value) return;
	message.value = '';
	const outcome = await events.respond(props.group.id, props.event.id, {
		membershipId: props.group.viewer.membership_id,
		choice,
		// The version the viewer saw (0 when they had no answer). A newer answer,
		// even the same choice, makes the write stale rather than overwriting it.
		expectedVersion: props.event.viewer_response?.version ?? 0,
	});
	if (['superseded', 'unauthenticated', 'busy'].includes(outcome.status)) return;
	if (outcome.status === 'stale-membership' || outcome.status === 'not-found') {
		// The event view is discarded with the membership; report on the page.
		await report({ outcome, success: '' });
		return;
	}
	tone.value = outcome.status === 'ok' ? 'success' : 'error';
	message.value =
		outcome.status === 'ok' ? `Your answer is saved: ${CHOICE_LABELS[choice]}.` : outcome.message;
}
</script>

<template>
	<div class="event-response" data-testid="event-response">
		<div role="group" :aria-label="`Your answer for ${event.title}`" class="event-response__choices">
			<button v-for="[value, label] in choices" :key="value" class="button event-choice" :class="current === value ? 'button--primary' : 'button--secondary'" type="button" :aria-label="`${label}, ${event.counts[value]} so far`" :aria-pressed="current === value" :aria-disabled="pending" :aria-busy="pending && current !== value" :data-choice="value" @click="choose(value)">
				<span>{{ label }}</span>
				<span class="event-choice__count">{{ event.counts[value] }}</span>
			</button>
		</div>
		<p v-if="!current" class="event-response__hint">You haven’t answered yet.</p>
		<p class="event-response__status" aria-live="polite" :class="`event-response__status--${tone}`" role="status">{{ message }}</p>
	</div>
</template>
