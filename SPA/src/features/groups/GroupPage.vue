<script setup>
import { computed, inject, ref, watch } from 'vue';

import { sessionKey } from '../auth/session-state.js';
import { countLabel } from '../social/social-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupFeedback from './GroupFeedback.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupInvitePanel from './GroupInvitePanel.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupMembers from './GroupMembers.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupNav from './GroupNav.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import GroupRequests from './GroupRequests.vue';
import { groupsKey } from './group-state.js';
// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { dateLabel } from './group-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import MembershipActions from './MembershipActions.vue';
import { useGroup } from './use-group.js';
import { useGroupFeedback } from './use-group-feedback.js';

const props = defineProps({
	section: {
		type: String,
		default: 'about',
		validator: (value) => ['about', 'members', 'requests'].includes(value),
	},
});

const session = inject(sessionKey);
const groups = inject(groupsKey);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, reload, group, groupId, viewerId, role, isMember, isCreator } = useGroup();
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { feedback, region: feedbackRegion, report, clear } = useGroupFeedback(session);
const flash = ref(groups.takeFlash('group'));
const confirmingLeave = ref(false);

watch([groupId, viewerId], () => {
	clear();
	flash.value = '';
	confirmingLeave.value = false;
});
watch(role, () => {
	confirmingLeave.value = false;
});

// A section the current role may not open shows why, without requesting
// the members-only or creator-only list.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const sectionAllowed = computed(() => {
	if (props.section === 'members') return isMember.value;
	if (props.section === 'requests') return isCreator.value;
	return true;
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const members = computed(() =>
	group.value?.member_count === undefined ? '' : countLabel(group.value.member_count, 'member'),
);
const leavePending = computed(() =>
	group.value ? groups.isPending(`membership-${group.value.viewer.membership_id}`) : false,
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function leave() {
	if (leavePending.value || role.value !== 'member') return;
	const title = group.value.title;
	const outcome = await groups.leave(group.value.viewer.membership_id);
	confirmingLeave.value = false;
	await report({
		outcome,
		success: `You left ${title}. Your posts stay with the group; you can ask to join again any time.`,
	});
}
</script>

<template>
	<section class="social-view group-view" data-screen="group" :data-section="section" :aria-busy="status === 'loading'">
		<p v-if="flash" class="group-feedback__text group-feedback__text--success" role="status">{{ flash }}</p>
		<GroupFeedback ref="feedbackRegion" :feedback="feedback" />

		<p v-if="status === 'loading'" class="social-status" role="status">Loading group…</p>

		<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" data-state="missing">
			<p class="eyebrow">Group</p>
			<h1>This group isn’t available.</h1>
			<p>It may not exist, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'groups' }">Browse groups</RouterLink>
		</div>

		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t load this group right now.</h1>
			<p>Nothing was changed, and nothing members-only is shown until we can confirm your membership.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>

		<template v-else-if="group">
			<header class="social-view__head group-view__head">
				<p class="eyebrow">Group · created {{ dateLabel(group.created_at) }} by {{ group.creator.display_name }}</p>
				<h1>{{ group.title }}</h1>
				<p class="group-view__meta">
					<span v-if="members">{{ members }}</span>
					<span v-else>Members only see who belongs</span>
				</p>
				<RouterLink class="text-link" :to="{ name: 'groups' }">All groups <span aria-hidden="true">↗</span></RouterLink>
			</header>

			<GroupNav :group="group" />

			<template v-if="section === 'about'">
				<section class="group-section group-about" aria-labelledby="group-about-heading">
					<h2 id="group-about-heading">About</h2>
					<p class="group-about__description">{{ group.description }}</p>
					<MembershipActions :group="group" />
					<p v-if="!isMember" class="group-about__private">Members, invitations and posts stay inside the group until you join.</p>
					<div v-if="role === 'member'" class="group-leave">
						<template v-if="confirmingLeave">
							<p id="group-leave-warning">Leave {{ group.title }}? You’ll lose access to its members and posts. Your posts stay; any invitations you sent are cancelled.</p>
							<button class="button button--danger" type="button" :aria-disabled="leavePending" :aria-busy="leavePending" aria-describedby="group-leave-warning" @click="leave">{{ leavePending ? 'Leaving…' : 'Confirm leaving' }}</button>
							<button class="button button--secondary" type="button" :aria-disabled="leavePending" @click="confirmingLeave = false">Stay in group</button>
						</template>
						<button v-else class="button button--secondary" type="button" @click="confirmingLeave = true">Leave group</button>
					</div>
					<p v-else-if="role === 'creator'" class="group-about__private">As the creator you stay a member while the group exists.</p>
				</section>
				<GroupInvitePanel v-if="isMember" :group="group" />
			</template>

			<div v-else-if="!sectionAllowed" class="social-state" role="status" data-state="restricted">
				<h2>{{ section === 'members' ? 'Only members can see who belongs.' : 'Only the creator reviews join requests.' }}</h2>
				<p>{{ isMember ? 'Ordinary members can invite people from the About page.' : 'Join by invitation or request to see members and posts.' }}</p>
				<RouterLink class="button button--secondary" :to="{ name: 'group', params: { id: group.id } }">About this group</RouterLink>
			</div>
			<GroupMembers v-else-if="section === 'members'" :group="group" :viewer-id="viewerId" />
			<GroupRequests v-else :group="group" :viewer-id="viewerId" />
		</template>
	</section>
</template>
