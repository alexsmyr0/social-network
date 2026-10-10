<script setup>
import { computed, inject } from 'vue';
import { useRoute } from 'vue-router';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PaginationNav from '../social/PaginationNav.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from '../social/SocialAvatar.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel, parsePage } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { groupsKey } from './group-state.js';
// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { dateLabel } from './group-utils.js';
import { useGroupReporter } from './use-group-feedback.js';

const props = defineProps({
	group: { type: Object, required: true },
	viewerId: { type: Number, default: null },
});
const report = useGroupReporter();

const social = inject(socialKey);
const groups = inject(groupsKey);
const route = useRoute();
const page = computed(() => parsePage(route.query.page));

// Mounted only for the creator. Ordinary members never get decision controls.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	() => groups.api.fetchJoinRequests(props.group.id, { page: page.value }),
	{ social, sources: () => [props.group.id, page.value, props.viewerId] },
);

const requests = computed(() => result.value?.requests ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => requests.value.length === 0 && pagination.value?.total > 0 && page.value > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() =>
	pagination.value ? countLabel(pagination.value.total, 'pending request') : '',
);
const busy = (request) => groups.isPending(`request-${request.id}`);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function decide(request, decision) {
	if (busy(request)) return;
	const name = request.requester.display_name;
	report({
		outcome: await groups.decideJoinRequest(request.id, decision),
		success:
			decision === 'accept'
				? `${name} joined ${props.group.title}.`
				: `${name}’s request was refused. They can ask again later.`,
	});
}
</script>

<template>
	<section class="group-section" aria-labelledby="group-requests-heading" :aria-busy="status === 'loading'">
		<h2 id="group-requests-heading">Join requests</h2>
		<p v-if="status === 'loading'" class="social-status" role="status">Loading join requests…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<p>We can’t load join requests right now.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<div v-else-if="status !== 'ready'" class="social-state" role="status">
			<p>Join requests aren’t available to you.</p>
		</div>
		<template v-else>
			<p class="social-status" role="status">{{ summary }}</p>
			<div v-if="beyondLastPage" class="social-state" role="status">
				<h3>That page doesn’t exist.</h3>
				<RouterLink class="button button--secondary" :to="{ name: 'group-requests', params: { id: group.id } }">First page</RouterLink>
			</div>
			<div v-else-if="requests.length === 0" class="social-state" role="status">
				<h3>No one is waiting.</h3>
				<p>New requests to join appear here and in your notifications.</p>
			</div>
			<ul v-else class="person-list" aria-label="Pending join requests">
				<li v-for="request in requests" :key="request.id" class="person" :data-request-id="request.id">
					<SocialAvatar :name="request.requester.display_name" :src="request.requester.avatar_url ?? null" />
					<div class="person__body">
						<RouterLink class="person__name" :to="{ name: 'profile', params: { id: request.requester.id } }">{{ request.requester.display_name }}</RouterLink>
						<p class="person__note">Asked {{ dateLabel(request.created_at) }}</p>
					</div>
					<div class="membership-actions__buttons">
						<button class="button button--primary" type="button" :aria-disabled="busy(request)" :aria-label="`Accept join request from ${request.requester.display_name}`" @click="decide(request, 'accept')">Accept</button>
						<button class="button button--secondary" type="button" :aria-disabled="busy(request)" :aria-label="`Refuse join request from ${request.requester.display_name}`" @click="decide(request, 'refuse')">Refuse</button>
					</div>
				</li>
			</ul>
			<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" label="Join request pages" />
		</template>
	</section>
</template>
