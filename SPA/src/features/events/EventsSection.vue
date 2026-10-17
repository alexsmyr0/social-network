<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject } from 'vue';
import { useRoute } from 'vue-router';

import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel, parsePage } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import EventCard from './EventCard.vue';
import { eventsKey } from './event-state.js';

const props = defineProps({
	group: { type: Object, required: true },
	viewerId: { type: Number, default: null },
});

const social = inject(socialKey);
const events = inject(eventsKey);
const route = useRoute();
const page = computed(() => parsePage(route.query.page));
// Stable primitive: a group refetch replaces the group object, not its ID.
const groupId = computed(() => props.group.id);

// Mounted only for a confirmed member; the server still decides, and a viewer
// who has lost membership gets a 404 that discards the list.
const { status, result, reload } = useSocialResource(
	() => events.api.fetchEvents(groupId.value, { page: page.value }),
	{ social, sources: () => [groupId.value, page.value, props.viewerId] },
);

const items = computed(() => result.value?.events ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
const beyondLastPage = computed(
	() => items.value.length === 0 && pagination.value?.total > 0 && page.value > 1,
);
const summary = computed(() =>
	pagination.value ? countLabel(pagination.value.total, 'event') : '',
);
</script>

<template>
	<section class="group-section events-section" aria-labelledby="group-events-heading" :aria-busy="status === 'loading'">
		<div class="events-section__head">
			<h2 id="group-events-heading">Events</h2>
			<RouterLink class="button button--primary" :to="{ name: 'group-event-new', params: { id: group.id } }">Schedule an event</RouterLink>
		</div>
		<p v-if="status === 'loading'" class="social-status" role="status">Loading events…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<p>We can’t load the events right now. Nothing is shown until we can confirm your membership.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<div v-else-if="status !== 'ready'" class="social-state" role="status" data-state="restricted">
			<p>The events aren’t available to you.</p>
		</div>
		<template v-else>
			<p class="social-status" role="status">{{ summary }}</p>
			<div v-if="beyondLastPage" class="social-state" role="status">
				<h3>That page doesn’t exist.</h3>
				<RouterLink class="button button--secondary" :to="{ name: 'group-events', params: { id: group.id } }">First page</RouterLink>
			</div>
			<div v-else-if="items.length === 0" class="social-state" role="status" data-state="empty">
				<h3>No events yet.</h3>
				<p>Anyone in {{ group.title }} can schedule one. Members are notified when it’s created.</p>
			</div>
			<ul v-else class="event-list" aria-label="Group events">
				<EventCard v-for="event in items" :key="event.id" :event="event" />
			</ul>
			<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" label="Event pages" />
		</template>
	</section>
</template>
