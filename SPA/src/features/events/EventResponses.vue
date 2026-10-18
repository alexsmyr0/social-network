<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject } from 'vue';
import { useRoute } from 'vue-router';

import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { parsePage } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { eventsKey } from './event-state.js';
import { CHOICE_LABELS } from './event-utils.js';

const props = defineProps({
	group: { type: Object, required: true },
	eventId: { type: Number, required: true },
	viewerId: { type: Number, default: null },
});

const social = inject(socialKey);
const events = inject(eventsKey);
const route = useRoute();
const page = computed(() => parsePage(route.query.page));
// Stable primitive: a group refetch replaces the group object, not its ID.
const groupId = computed(() => props.group.id);

// Names and answers only: shared membership never discloses a private
// profile, an avatar or anyone's membership history.
const { status, result, reload } = useSocialResource(
	() => events.api.fetchEventResponses(groupId.value, props.eventId, { page: page.value }),
	{
		social,
		sources: () => [groupId.value, props.eventId, page.value, props.viewerId],
		retain: true,
	},
);

const responses = computed(() => result.value?.responses ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
</script>

<template>
	<section class="event-responses" aria-labelledby="event-responses-heading" :aria-busy="status === 'loading'">
		<h2 id="event-responses-heading">Who’s answered</h2>
		<p v-if="status === 'loading'" class="social-status" role="status">Loading answers…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<p>We can’t load the answers right now.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<div v-else-if="status !== 'ready'" class="social-state" role="status">
			<p>The answers aren’t available to you.</p>
		</div>
		<template v-else>
			<p v-if="responses.length === 0" class="social-status" role="status">{{ page > 1 && pagination?.total > 0 ? 'That page doesn’t exist.' : 'No one has answered yet.' }}</p>
			<ul v-else class="event-responses__list" aria-label="Event answers">
				<li v-for="response in responses" :key="response.user.id" class="event-responses__item" :data-user-id="response.user.id" :data-choice="response.choice">
					<RouterLink :to="{ name: 'profile', params: { id: response.user.id } }">{{ response.user.display_name }}</RouterLink>
					<span class="badge" :class="`event-badge--${response.choice}`">{{ CHOICE_LABELS[response.choice] }}</span>
				</li>
			</ul>
			<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" label="Answer pages" />
		</template>
	</section>
</template>
