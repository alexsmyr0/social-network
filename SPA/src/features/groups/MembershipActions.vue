<script setup>
import { computed, inject } from 'vue';

import { groupsKey } from './group-state.js';
import { useGroupReporter } from './use-group-feedback.js';

const props = defineProps({
	group: { type: Object, required: true },
});
// Membership writes discard and refetch the views that contain this control,
// so the page that owns a stable live region reports the outcome.
const report = useGroupReporter();

const groups = inject(groupsKey);

const viewer = computed(() => props.group.viewer);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const invitations = computed(() => viewer.value.invitations);
const joinPending = computed(() => groups.isPending(`join-${props.group.id}`));
const invitationBusy = computed(() =>
	viewer.value.invitations.some((item) => groups.isPending(`invitation-${item.id}`)),
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function requestToJoin() {
	if (joinPending.value) return;
	const title = props.group.title;
	report({
		outcome: await groups.requestToJoin(props.group.id),
		success: `Request sent. The creator of ${title} will decide.`,
	});
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function decide(invitation, decision) {
	if (invitationBusy.value) return;
	const title = props.group.title;
	report({
		outcome: await groups.decideInvitation(invitation.id, decision),
		success: decision === 'accept' ? `You joined ${title}.` : `Invitation to ${title} refused.`,
	});
}
</script>

<template>
	<div class="membership-actions" :data-role="viewer.role">
		<p v-if="viewer.role === 'creator'" class="membership-actions__state">You created this group</p>
		<p v-else-if="viewer.role === 'member'" class="membership-actions__state">You’re a member</p>
		<template v-else>
			<ul v-if="invitations.length" class="membership-invitations" :aria-label="`Invitations to ${group.title}`">
				<li v-for="invitation in invitations" :key="invitation.id" :data-invitation-id="invitation.id">
					<p><strong>{{ invitation.inviter.display_name }}</strong> invited you</p>
					<div class="membership-actions__buttons">
						<button class="button button--primary" type="button" :aria-disabled="invitationBusy" :aria-label="`Accept invitation to ${group.title} from ${invitation.inviter.display_name}`" @click="decide(invitation, 'accept')">Accept</button>
						<button class="button button--secondary" type="button" :aria-disabled="invitationBusy" :aria-label="`Refuse invitation to ${group.title} from ${invitation.inviter.display_name}`" @click="decide(invitation, 'refuse')">Refuse</button>
					</div>
				</li>
			</ul>
			<p v-if="viewer.join_request" class="membership-actions__state">Join request pending · waiting for the creator</p>
			<button v-else class="button button--primary" type="button" :aria-disabled="joinPending" :aria-busy="joinPending" :aria-label="`Request to join ${group.title}`" @click="requestToJoin">{{ joinPending ? 'Sending…' : 'Request to join' }}</button>
		</template>
	</div>
</template>
