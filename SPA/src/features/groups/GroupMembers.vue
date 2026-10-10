<script setup>
import { computed, inject, ref, watch } from 'vue';
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
import { dateLabel, ROLE_LABELS } from './group-utils.js';
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
const confirming = ref(null);
watch(
	() => [props.group.id, props.viewerId],
	() => {
		confirming.value = null;
	},
);

// Mounted only for a confirmed member; the server still decides, and a
// removed viewer's next read is a 404 that discards the list.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	() => groups.api.fetchGroupMembers(props.group.id, { page: page.value }),
	{ social, sources: () => [props.group.id, page.value, props.viewerId] },
);

const members = computed(() => result.value?.members ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => members.value.length === 0 && pagination.value?.total > 0 && page.value > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() =>
	pagination.value ? countLabel(pagination.value.total, 'member') : '',
);
// The creator may remove any other member; nobody can remove the creator.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const canRemove = (member) =>
	props.group.viewer.role === 'creator' &&
	member.membership.role === 'member' &&
	member.id !== props.viewerId;
const busy = (member) => groups.isPending(`membership-${member.membership.id}`);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function remove(member) {
	if (busy(member)) return;
	const name = member.display_name;
	const outcome = await groups.remove(member.membership.id);
	confirming.value = null;
	report({
		outcome,
		success: `${name} was removed from ${props.group.title}. Their posts stay; they can return by a new request or invitation.`,
	});
}
</script>

<template>
	<section class="group-section" aria-labelledby="group-members-heading" :aria-busy="status === 'loading'">
		<h2 id="group-members-heading">Members</h2>
		<p v-if="status === 'loading'" class="social-status" role="status">Loading members…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<p>We can’t load the members right now. Nothing is shown until we can confirm access.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<div v-else-if="status !== 'ready'" class="social-state" role="status">
			<p>The member list isn’t available to you.</p>
		</div>
		<template v-else>
			<p class="social-status" role="status">{{ summary }}</p>
			<div v-if="beyondLastPage" class="social-state" role="status">
				<h3>That page doesn’t exist.</h3>
				<RouterLink class="button button--secondary" :to="{ name: 'group-members', params: { id: group.id } }">First page</RouterLink>
			</div>
			<ul v-else class="person-list" aria-label="Group members">
				<li v-for="member in members" :key="member.membership.id" class="person group-member" :data-person-id="member.id" :data-membership-id="member.membership.id" :data-access="member.access">
					<SocialAvatar :name="member.display_name" :src="member.avatar_url ?? null" />
					<div class="person__body">
						<RouterLink class="person__name" :to="{ name: 'profile', params: { id: member.id } }">{{ member.display_name }}</RouterLink>
						<p class="person__note">
							<span class="badge">{{ ROLE_LABELS[member.membership.role] }}</span>
							<span v-if="member.relationship.state === 'self'"> · You</span>
							<span v-else-if="member.access === 'teaser'"> · Private profile · name only</span>
							<span> · Joined {{ dateLabel(member.membership.joined_at) }}</span>
						</p>
					</div>
					<div v-if="canRemove(member)" class="group-member__actions">
						<template v-if="confirming === member.membership.id">
							<p :id="`remove-${member.membership.id}`">Remove {{ member.display_name }}? Their posts stay in the group.</p>
							<button class="button button--danger" type="button" :aria-disabled="busy(member)" :aria-busy="busy(member)" :aria-describedby="`remove-${member.membership.id}`" @click="remove(member)">{{ busy(member) ? 'Removing…' : 'Confirm removal' }}</button>
							<button class="button button--secondary" type="button" :aria-disabled="busy(member)" @click="confirming = null">Keep member</button>
						</template>
						<button v-else class="button button--secondary" type="button" :aria-label="`Remove ${member.display_name} from ${group.title}`" @click="confirming = member.membership.id">Remove</button>
					</div>
				</li>
			</ul>
			<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" label="Member pages" />
		</template>
	</section>
</template>
