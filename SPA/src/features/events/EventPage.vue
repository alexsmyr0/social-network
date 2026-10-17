<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
import GroupFeedback from '../groups/GroupFeedback.vue';
import { groupsKey } from '../groups/group-state.js';
import { useGroup } from '../groups/use-group.js';
import { useGroupFeedback } from '../groups/use-group-feedback.js';
import { parseUserId } from '../social/social-utils.js';
import EventDetail from './EventDetail.vue';

const session = inject(sessionKey);
const groups = inject(groupsKey);
const route = useRoute();
// `retain` keeps the last confirmed group while a signal-driven refetch runs, so
// answering (which the server also signals back to the responder) does not
// unmount the answer buttons and drop the member's focus. A failed read, a
// missing group or a changed account still discards it at once.
const { status, reload, group, groupId, viewerId, isMember } = useGroup({ retain: true });
const { feedback, region: feedbackRegion, clear } = useGroupFeedback(session);
const eventId = computed(() => parseUserId(route.params.eventId));
const flash = ref(groups.takeFlash('event'));

watch([groupId, eventId, viewerId], () => {
	clear();
	flash.value = '';
});

// The event is requested only after the server confirms current membership;
// everyone else sees why, without any event content.
const view = computed(() => {
	if (status.value === 'loading') return 'checking';
	if (status.value === 'unavailable') return 'unavailable';
	if (status.value !== 'ready' || !group.value) return 'missing';
	return isMember.value ? 'event' : 'restricted';
});
</script>

<template>
	<section class="social-view event-view" data-screen="event" :aria-busy="view === 'checking'">
		<p v-if="flash" class="group-feedback__text group-feedback__text--success" role="status">{{ flash }}</p>
		<GroupFeedback ref="feedbackRegion" :feedback="feedback" />

		<p v-if="view === 'checking'" class="social-status" role="status">Checking your membership…</p>

		<div v-else-if="view === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t confirm your membership right now.</h1>
			<p>Nothing is shown until we can confirm you belong to this group.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>

		<div v-else-if="view === 'missing'" class="social-state" data-state="missing">
			<p class="eyebrow">Event</p>
			<h1>This group isn’t available.</h1>
			<p>It may not exist, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'groups' }">Browse groups</RouterLink>
		</div>

		<div v-else-if="view === 'restricted'" class="social-state" role="status" data-state="restricted">
			<p class="eyebrow">Event · {{ group.title }}</p>
			<h1>Only members can see group events.</h1>
			<p>Join {{ group.title }} to see its events and answers.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'group', params: { id: group.id } }">About this group</RouterLink>
		</div>

		<template v-else>
			<RouterLink class="text-link event-view__back" :to="{ name: 'group-events', params: { id: group.id } }"><span aria-hidden="true">←</span> All events in {{ group.title }}</RouterLink>
			<EventDetail :group="group" :event-id="eventId" :viewer-id="viewerId" />
		</template>
	</section>
</template>
