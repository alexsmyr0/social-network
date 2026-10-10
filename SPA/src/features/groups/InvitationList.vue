<script setup>
import { computed, inject, ref, watch } from 'vue';

import { sessionKey } from '../auth/session-state.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from '../social/SocialAvatar.vue';
import { socialKey } from '../social/social-state.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { groupsKey } from './group-state.js';
import { useGroupReporter } from './use-group-feedback.js';

const report = useGroupReporter();

const session = inject(sessionKey);
const social = inject(socialKey);
const groups = inject(groupsKey);
const page = ref(1);
const viewerId = computed(() => session.state.account?.id ?? null);
watch(viewerId, () => {
	page.value = 1;
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	() => groups.api.fetchMyInvitations({ page: page.value }),
	{ social, sources: () => [page.value, viewerId.value] },
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const invitations = computed(() => result.value?.invitations ?? []);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const pagination = computed(() => result.value?.pagination ?? null);
// A list that shrank under the current page moves back instead of stranding
// the viewer on an empty page.
watch(result, (value) => {
	if (value && value.invitations.length === 0 && page.value > 1) page.value -= 1;
});
const busy = (invitation) => groups.isPending(`invitation-${invitation.id}`);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function decide(invitation, decision) {
	if (busy(invitation)) return;
	const title = invitation.group.title;
	report({
		outcome: await groups.decideInvitation(invitation.id, decision),
		success: decision === 'accept' ? `You joined ${title}.` : `Invitation to ${title} refused.`,
	});
}
</script>

<template>
	<section v-if="status === 'unavailable' || invitations.length" class="invitation-list" aria-labelledby="invitation-list-heading">
		<h2 id="invitation-list-heading">Invitations for you</h2>
		<div v-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<p>We can’t load your invitations right now.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try invitations again</button>
		</div>
		<template v-else>
			<ul aria-label="Pending group invitations">
				<li v-for="invitation in invitations" :key="invitation.id" class="invitation" :data-invitation-id="invitation.id">
					<SocialAvatar :name="invitation.inviter.display_name" :src="invitation.inviter.avatar_url ?? null" size="sm" />
					<div class="invitation__body">
						<p><strong>{{ invitation.inviter.display_name }}</strong> invited you to <RouterLink :to="{ name: 'group', params: { id: invitation.group.id } }">{{ invitation.group.title }}</RouterLink></p>
						<p class="invitation__description">{{ invitation.group.description }}</p>
					</div>
					<div class="membership-actions__buttons">
						<button class="button button--primary" type="button" :aria-disabled="busy(invitation)" :aria-label="`Accept invitation to ${invitation.group.title} from ${invitation.inviter.display_name}`" @click="decide(invitation, 'accept')">Accept</button>
						<button class="button button--secondary" type="button" :aria-disabled="busy(invitation)" :aria-label="`Refuse invitation to ${invitation.group.title} from ${invitation.inviter.display_name}`" @click="decide(invitation, 'refuse')">Refuse</button>
					</div>
				</li>
			</ul>
			<nav v-if="pagination && pagination.total_pages > 1" class="pager" aria-label="Invitation pages">
				<button class="button button--secondary" type="button" :disabled="page <= 1" @click="page -= 1">Previous</button>
				<span>Page {{ page }} of {{ pagination.total_pages }}</span>
				<button class="button button--secondary" type="button" :disabled="page >= pagination.total_pages" @click="page += 1">Next</button>
			</nav>
		</template>
	</section>
</template>
