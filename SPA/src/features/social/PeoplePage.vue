<script setup>
import { computed, inject, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PaginationNav from './PaginationNav.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PersonCard from './PersonCard.vue';
import { socialKey } from './social-state.js';
import { countLabel, parsePage, readSearchQuery, validateSearch } from './social-utils.js';
import { useSocialResource } from './use-social-resource.js';

const social = inject(socialKey);
const route = useRoute();
const router = useRouter();

const activeQuery = computed(() => readSearchQuery(route.query.q).trim());
const activePage = computed(() => parsePage(route.query.page));
const draft = ref(readSearchQuery(route.query.q));
const searchError = ref('');

watch(
	() => route.query.q,
	(value) => {
		draft.value = readSearchQuery(value);
		searchError.value = '';
	},
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, failure, reload } = useSocialResource(
	() => social.api.searchPeople({ q: activeQuery.value, page: activePage.value }),
	{ social, sources: () => [activeQuery.value, activePage.value] },
);

const people = computed(() => result.value?.people ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => people.value.length === 0 && pagination.value?.total > 0 && activePage.value > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() => {
	if (!pagination.value) return '';
	const total = countLabel(pagination.value.total, 'person', 'people');
	return activeQuery.value ? `${total} matching “${activeQuery.value}”` : total;
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const serverSearchError = computed(() => {
	const code = failure.value?.fields?.q;
	if (code === 'TOO_LONG') return 'Search is too long.';
	if (code) return 'Search can’t contain those characters.';
	return '';
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function submitSearch() {
	const { value, error } = validateSearch(draft.value);
	searchError.value = error;
	if (error) return;
	const query = value ? { q: value } : {};
	void router.push({ path: route.path, query });
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function clearSearch() {
	draft.value = '';
	searchError.value = '';
	void router.push({ path: route.path });
}
</script>

<template>
	<section class="social-view people-view" data-screen="people">
		<header class="social-view__head">
			<p class="eyebrow">People</p>
			<h1>Find your <em>circle.</em></h1>
			<p class="social-view__lede">Search by the name people go by. Private profiles show only a name until they accept you.</p>
		</header>

		<form class="people-search" role="search" novalidate @submit.prevent="submitSearch">
			<label class="people-search__label" for="people-search-input">Search people by name</label>
			<div class="people-search__row">
				<input
					id="people-search-input"
					v-model="draft"
					name="q"
					type="search"
					autocomplete="off"
					placeholder="Try “Alex”"
					:aria-invalid="Boolean(searchError || serverSearchError)"
					:aria-describedby="searchError || serverSearchError ? 'people-search-error' : undefined"
				/>
				<button class="button button--primary" type="submit">Search</button>
				<button v-if="activeQuery" class="button button--secondary" type="button" @click="clearSearch">Clear</button>
			</div>
			<p v-if="searchError || serverSearchError" id="people-search-error" class="field-error" role="alert">{{ searchError || serverSearchError }}</p>
		</form>

		<div class="social-view__results" :aria-busy="status === 'loading'">
			<p v-if="status === 'loading'" class="social-status" role="status">Loading people…</p>

			<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
				<h2>We can’t load people right now.</h2>
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
					<RouterLink class="button button--secondary" :to="{ path: route.path, query: activeQuery ? { q: activeQuery } : {} }">First page</RouterLink>
				</div>
				<div v-else-if="people.length === 0" class="social-state" role="status">
					<h2 v-if="activeQuery">No one matches “{{ activeQuery }}”.</h2>
					<h2 v-else>No one has joined yet.</h2>
					<p v-if="activeQuery">Names are matched as typed, without fuzzy search. Try a shorter piece of the name.</p>
				</div>
				<ul v-else class="person-list" aria-label="People">
					<PersonCard v-for="person in people" :key="person.id" :person="person" />
				</ul>

				<PaginationNav v-if="pagination" :page="activePage" :total-pages="pagination.total_pages" label="People pages" />
			</template>
		</div>
	</section>
</template>
