<script setup>
import { computed, inject, ref, watch } from 'vue';

import { sessionKey } from '../auth/session-state.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from '../social/SocialAvatar.vue';
import { socialKey } from '../social/social-state.js';
import { validateSearch } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { groupsKey } from './group-state.js';

const props = defineProps({
	group: { type: Object, required: true },
});

const session = inject(sessionKey);
const social = inject(socialKey);
const groups = inject(groupsKey);
const viewerId = computed(() => session.state.account?.id ?? null);
const draft = ref('');
const query = ref('');
const page = ref(1);
const searchError = ref('');
// Per-person results stay beside the person, because inviting does not
// change membership and so keeps this list mounted.
const results = ref({});

watch(
	() => [props.group.id, viewerId.value],
	() => {
		draft.value = query.value = searchError.value = '';
		page.value = 1;
		results.value = {};
	},
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	() => social.api.searchPeople({ q: query.value, page: page.value, perPage: 10 }),
	{ social, sources: () => [query.value, page.value, viewerId.value], retain: true },
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const people = computed(() => (result.value?.people ?? []).filter((p) => p.id !== viewerId.value));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const pagination = computed(() => result.value?.pagination ?? null);
const busy = (person) => groups.isPending(`invite-${props.group.id}-${person.id}`);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function search() {
	const { value, error } = validateSearch(draft.value);
	searchError.value = error;
	if (error) return;
	query.value = value;
	page.value = 1;
}

const INVITE_MESSAGES = {
	'already-member': (name) => `${name} is already a member.`,
	'not-found': (name) =>
		`${name} can’t be invited right now. Their account may be unavailable, or your membership may have changed.`,
};

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function invite(person) {
	if (busy(person)) return;
	const name = person.display_name;
	const outcome = await groups.invite(props.group.id, person.id);
	if (['superseded', 'unauthenticated', 'busy'].includes(outcome.status)) return;
	const message =
		outcome.status === 'ok'
			? `Invitation pending for ${name}. They can accept or refuse it.`
			: (INVITE_MESSAGES[outcome.status]?.(name) ?? outcome.message);
	results.value = {
		...results.value,
		[person.id]: { tone: outcome.status === 'ok' ? 'success' : 'error', message },
	};
}
</script>

<template>
	<section class="group-section group-invite" aria-labelledby="group-invite-heading">
		<h2 id="group-invite-heading">Invite people</h2>
		<p>Any member can invite someone. An invitation alone grants no access; they join only when they accept.</p>
		<form class="people-search" role="search" novalidate @submit.prevent="search">
			<label class="people-search__label" for="group-invite-search">Find people to invite</label>
			<div class="people-search__row">
				<input id="group-invite-search" v-model="draft" type="search" autocomplete="off" placeholder="Search by name" :aria-invalid="Boolean(searchError)" :aria-describedby="searchError ? 'group-invite-error' : undefined" />
				<button class="button button--primary" type="submit">Search</button>
			</div>
			<p v-if="searchError" id="group-invite-error" class="field-error" role="alert">{{ searchError }}</p>
		</form>
		<p v-if="status === 'loading'" class="social-status" role="status">Loading people…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<p>We can’t search people right now.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<template v-else-if="status === 'ready'">
			<p v-if="people.length === 0" class="social-status" role="status">No one to invite matches that search.</p>
			<ul v-else class="person-list" aria-label="People to invite">
				<li v-for="person in people" :key="person.id" class="person" :data-person-id="person.id">
					<SocialAvatar :name="person.display_name" :src="person.avatar_url ?? null" size="sm" />
					<div class="person__body">
						<span class="person__name">{{ person.display_name }}</span>
						<p v-if="results[person.id]" class="person__note" :class="results[person.id].tone === 'error' ? 'field-error' : ''" :role="results[person.id].tone === 'error' ? 'alert' : 'status'">{{ results[person.id].message }}</p>
					</div>
					<button class="button button--secondary" type="button" :aria-disabled="busy(person)" :aria-busy="busy(person)" :aria-label="`Invite ${person.display_name} to ${group.title}`" @click="invite(person)">{{ busy(person) ? 'Inviting…' : 'Invite' }}</button>
				</li>
			</ul>
			<nav v-if="pagination && pagination.total_pages > 1" class="pager" aria-label="People to invite pages">
				<button class="button button--secondary" type="button" :disabled="page <= 1" @click="page -= 1">Previous</button>
				<span>Page {{ page }} of {{ pagination.total_pages }}</span>
				<button class="button button--secondary" type="button" :disabled="page >= pagination.total_pages" @click="page += 1">Next</button>
			</nav>
		</template>
	</section>
</template>
