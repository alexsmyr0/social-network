<script setup>
import { computed, inject } from 'vue';
import { useRoute } from 'vue-router';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PaginationNav from './PaginationNav.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PersonCard from './PersonCard.vue';
import { socialKey } from './social-state.js';
import { countLabel, parsePage, parseUserId } from './social-utils.js';
import { useSocialResource } from './use-social-resource.js';

const props = defineProps({
	kind: { type: String, required: true, validator: (v) => v === 'followers' || v === 'following' },
});

const social = inject(socialKey);
const route = useRoute();
const userId = computed(() => parseUserId(route.params.id));
const page = computed(() => parsePage(route.query.page));

// The list endpoints enforce the same access as the full profile. Reading the
// profile first names the page and, for a name-only teaser, avoids requesting
// a list the viewer may not see.
async function load() {
	if (!userId.value) return { status: 'not-found' };
	const profile = await social.api.fetchProfile(userId.value);
	if (profile.status !== 'ok') return profile;
	if (profile.profile.access !== 'full') return { status: 'not-found' };
	const fetchList =
		props.kind === 'followers' ? social.api.fetchFollowers : social.api.fetchFollowing;
	const list = await fetchList(userId.value, { page: page.value });
	if (list.status !== 'ok') return list;
	return { status: 'ok', owner: profile.profile, people: list.people, pagination: list.pagination };
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(load, {
	social,
	sources: () => [userId.value, page.value, props.kind],
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const title = computed(() => (props.kind === 'followers' ? 'Followers' : 'Following'));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const owner = computed(() => result.value?.owner ?? null);
const people = computed(() => result.value?.people ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => people.value.length === 0 && pagination.value?.total > 0 && page.value > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() =>
	pagination.value ? countLabel(pagination.value.total, 'person', 'people') : '',
);
</script>

<template>
	<section class="social-view follow-list-view" :data-screen="kind" :aria-busy="status === 'loading'">
		<p v-if="status === 'loading'" class="social-status" role="status">Loading {{ title.toLowerCase() }}…</p>

		<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" data-state="missing">
			<p class="eyebrow">{{ title }}</p>
			<h1>This list isn’t available.</h1>
			<p>You may not have access to it, or the profile may no longer exist.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'people' }">Browse people</RouterLink>
		</div>

		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t load this list right now.</h1>
			<p>Nothing was changed, and nothing is shown until we can confirm access.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>

		<template v-else-if="owner">
			<header class="social-view__head">
				<p class="eyebrow">{{ title }}</p>
				<h1>{{ kind === 'followers' ? 'People following' : 'People followed by' }} <em>{{ owner.display_name }}</em></h1>
				<RouterLink class="text-link" :to="{ name: 'profile', params: { id: owner.id } }">Back to profile <span aria-hidden="true">↗</span></RouterLink>
			</header>

			<p class="social-status" role="status">{{ summary }}</p>

			<div v-if="beyondLastPage" class="social-state" role="status">
				<h2>That page doesn’t exist.</h2>
				<RouterLink class="button button--secondary" :to="{ path: route.path }">First page</RouterLink>
			</div>
			<div v-else-if="people.length === 0" class="social-state" role="status">
				<h2>{{ kind === 'followers' ? 'No followers yet.' : 'Not following anyone yet.' }}</h2>
			</div>
			<ul v-else class="person-list" :aria-label="title">
				<PersonCard v-for="person in people" :key="person.id" :person="person" />
			</ul>

			<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" :label="`${title} pages`" />
		</template>
	</section>
</template>
