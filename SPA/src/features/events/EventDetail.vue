<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject } from 'vue';

import { socialKey } from '../social/social-state.js';
import { useSocialResource } from '../social/use-social-resource.js';
import EventResponseControl from './EventResponseControl.vue';
import EventResponses from './EventResponses.vue';
import { eventsKey } from './event-state.js';
import { countsLabel, eventTimeLabel, isPastEvent } from './event-utils.js';

const props = defineProps({
	group: { type: Object, required: true },
	eventId: { type: Number, required: true },
	viewerId: { type: Number, default: null },
});

const social = inject(socialKey);
const events = inject(eventsKey);
// A group refetch replaces the group object but not its ID; sources must stay
// primitive-stable or every refresh would discard the event and remount the
// answer buttons under the member's hands.
const groupId = computed(() => props.group.id);

// Mounted only for a confirmed member. The event must belong to this group's
// route; any other answer is a 404 that discards the event, so a removed
// member's open page never keeps showing it. `retain` keeps the shown event
// only while a signal-driven refetch is in flight (the server also signals the
// responder), so answering does not unmount the buttons under the member's
// hands; a failed or denied read, a route or an account change discards it.
const { status, result, reload } = useSocialResource(
	() =>
		events.reconcileCreation(groupId.value, () =>
			events.api.fetchEvent(groupId.value, props.eventId),
		),
	{ social, sources: () => [groupId.value, props.eventId, props.viewerId], retain: true },
);

const event = computed(() => result.value?.event ?? null);
const when = computed(() => (event.value ? eventTimeLabel(event.value.starts_at) : ''));
const past = computed(() => (event.value ? isPastEvent(event.value.starts_at) : false));
const counts = computed(() => (event.value ? countsLabel(event.value.counts) : ''));
</script>

<template>
	<div :aria-busy="status === 'loading'">
		<p v-if="status === 'loading'" class="social-status" role="status">Loading event…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t load this event right now.</h1>
			<p>Nothing was changed, and nothing is shown until we can confirm your membership.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<div v-else-if="status !== 'ready' || !event" class="social-state" data-state="missing">
			<p class="eyebrow">Event</p>
			<h1>This event isn’t available.</h1>
			<p>It may not exist in this group, or you may no longer belong to it.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'group-events', params: { id: group.id } }">Back to events</RouterLink>
		</div>
		<article v-else class="event-detail" :data-event-id="event.id" :data-past="past">
			<header class="social-view__head event-detail__head">
				<p class="eyebrow">Event · {{ group.title }}<span v-if="past"> · Past</span></p>
				<h1>{{ event.title }}</h1>
				<p class="event-detail__when"><time :datetime="event.starts_at">{{ when }}</time></p>
				<p class="event-detail__meta">Scheduled by {{ event.creator.display_name }} · {{ counts }}</p>
			</header>
			<p class="event-detail__description">{{ event.description }}</p>
			<EventResponseControl :group="group" :event="event" />
			<EventResponses :group="group" :event-id="event.id" :viewer-id="viewerId" />
		</article>
	</div>
</template>
