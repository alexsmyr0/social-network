<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
import { computed } from 'vue';

import { CHOICE_LABELS, countsLabel, eventTimeLabel, isPastEvent } from './event-utils.js';

const props = defineProps({
	event: { type: Object, required: true },
});

const when = computed(() => eventTimeLabel(props.event.starts_at));
const past = computed(() => isPastEvent(props.event.starts_at));
const counts = computed(() => countsLabel(props.event.counts));
const answer = computed(() =>
	props.event.viewer_response
		? `You: ${CHOICE_LABELS[props.event.viewer_response.choice]}`
		: 'No answer yet',
);
</script>

<template>
	<li class="event-card" :data-event-id="event.id" :data-past="past">
		<div class="event-card__body">
			<p class="event-card__meta">
				<time :datetime="event.starts_at">{{ when }}</time>
				<span v-if="past" class="badge event-card__badge">Past</span>
			</p>
			<h3 class="event-card__title">
				<RouterLink :to="{ name: 'group-event', params: { id: event.group_id, eventId: event.id } }">{{ event.title }}</RouterLink>
			</h3>
			<p class="event-card__description">{{ event.description }}</p>
			<p class="event-card__creator">Scheduled by {{ event.creator.display_name }}</p>
		</div>
		<div class="event-card__side">
			<p class="event-card__counts">{{ counts }}</p>
			<p class="event-card__answer" :data-answered="Boolean(event.viewer_response)">{{ answer }}</p>
		</div>
	</li>
</template>
