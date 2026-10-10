<script setup>
import { computed, inject, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel, validateSearch } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupCard from './GroupCard.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupFeedback from './GroupFeedback.vue';
import { groupsKey } from './group-state.js';
import { groupsQuery, readGroupsQuery } from './group-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import InvitationList from './InvitationList.vue';
import { useGroupFeedback } from './use-group-feedback.js';

const session = inject(sessionKey);
const social = inject(socialKey);
const groups = inject(groupsKey);
const route = useRoute();
const router = useRouter();

const filters = computed(() => readGroupsQuery(route.query));
const viewerId = computed(() => session.state.account?.id ?? null);
const draft = ref(filters.value.q);
const searchError = ref('');
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { feedback, region: feedbackRegion } = useGroupFeedback(session);

watch(
	() => filters.value.q,
	(value) => {
		draft.value = value;
		searchError.value = '';
	},
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, failure, reload } = useSocialResource(
	() =>
		groups.api.fetchGroups({
			q: filters.value.q,
			membership: filters.value.membership,
			page: filters.value.page,
		}),
	{
		social,
		sources: () => [filters.value.q, filters.value.membership, filters.value.page, viewerId.value],
	},
);

const list = computed(() => result.value?.groups ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => list.value.length === 0 && pagination.value?.total > 0 && filters.value.page > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() => {
	if (!pagination.value) return '';
	const total = countLabel(pagination.value.total, 'group');
	const scope = filters.value.membership === 'member' ? ' you belong to' : '';
	return filters.value.q ? `${total}${scope} matching “${filters.value.q}”` : `${total}${scope}`;
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const serverSearchError = computed(() => {
	const code = failure.value?.fields?.q;
	if (code === 'TOO_LONG') return 'Search is too long.';
	if (code) return 'Search can’t contain those characters.';
	return '';
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const tabs = computed(() => [
	{ label: 'All groups', membership: 'all' },
	{ label: 'Your groups', membership: 'member' },
]);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const tabTarget = (membership) => ({
	name: 'groups',
	query: groupsQuery({ q: filters.value.q, membership, page: 1 }),
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function submitSearch() {
	const { value, error } = validateSearch(draft.value);
	searchError.value = error;
	if (error) return;
	const query = groupsQuery({ q: value, membership: filters.value.membership, page: 1 });
	void router.push({ name: 'groups', query });
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function clearSearch() {
	draft.value = '';
	searchError.value = '';
	void router.push({
		name: 'groups',
		query: groupsQuery({ membership: filters.value.membership, page: 1 }),
	});
}
</script>

<template>
	<section class="social-view groups-view" data-screen="groups">
		<header class="social-view__head groups-view__head">
			<div>
				<p class="eyebrow">Groups</p>
				<h1>Gather around <em>something.</em></h1>
				<p class="social-view__lede">Browse every group. Members-only lists and posts open once you join by invitation or request.</p>
			</div>
			<RouterLink class="button button--primary" :to="{ name: 'group-new' }">Start a group</RouterLink>
		</header>

		<GroupFeedback ref="feedbackRegion" :feedback="feedback" />

		<InvitationList />

		<nav class="groups-tabs" aria-label="Group lists">
			<RouterLink v-for="tab in tabs" :key="tab.membership" :to="tabTarget(tab.membership)" :aria-current="filters.membership === tab.membership ? 'page' : undefined">{{ tab.label }}</RouterLink>
		</nav>

		<form class="people-search" role="search" novalidate @submit.prevent="submitSearch">
			<label class="people-search__label" for="group-search-input">Search groups by name</label>
			<div class="people-search__row">
				<input
					id="group-search-input"
					v-model="draft"
					name="q"
					type="search"
					autocomplete="off"
					placeholder="Try “Chess”"
					:aria-invalid="Boolean(searchError || serverSearchError)"
					:aria-describedby="searchError || serverSearchError ? 'group-search-error' : undefined"
				/>
				<button class="button button--primary" type="submit">Search</button>
				<button v-if="filters.q" class="button button--secondary" type="button" @click="clearSearch">Clear</button>
			</div>
			<p v-if="searchError || serverSearchError" id="group-search-error" class="field-error" role="alert">{{ searchError || serverSearchError }}</p>
		</form>

		<div class="social-view__results" :aria-busy="status === 'loading'">
			<p v-if="status === 'loading'" class="social-status" role="status">Loading groups…</p>

			<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
				<h2>We can’t load groups right now.</h2>
				<p>Nothing was changed. Your connection or the service may be briefly unavailable.</p>
				<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
			</div>

			<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" role="status">
				<h2>That search can’t be shown.</h2>
				<p>Adjust the search and try again.</p>
			</div>

			<template v-else-if="status === 'ready'">
				<p class="social-status" role="status">{{ summary }}</p>

				<div v-if="beyondLastPage" class="social-state" role="status">
					<h2>That page doesn’t exist.</h2>
					<p>The list is shorter than it was. Go back to the first page.</p>
					<RouterLink class="button button--secondary" :to="{ name: 'groups', query: groupsQuery({ q: filters.q, membership: filters.membership, page: 1 }) }">First page</RouterLink>
				</div>
				<div v-else-if="list.length === 0" class="social-state" role="status">
					<h2 v-if="filters.q">No group matches “{{ filters.q }}”.</h2>
					<h2 v-else-if="filters.membership === 'member'">You haven’t joined a group yet.</h2>
					<h2 v-else>No groups yet.</h2>
					<p>Start one and invite the people who should be there.</p>
				</div>
				<ul v-else class="group-list" aria-label="Groups">
					<GroupCard v-for="group in list" :key="group.id" :group="group" />
				</ul>

				<PaginationNav v-if="pagination" :page="filters.page" :total-pages="pagination.total_pages" label="Group pages" />
			</template>
		</div>
	</section>
</template>
