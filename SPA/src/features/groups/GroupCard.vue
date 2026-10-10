<script setup>
import { computed } from 'vue';

import { countLabel } from '../social/social-utils.js';
import { ROLE_LABELS } from './group-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import MembershipActions from './MembershipActions.vue';

const props = defineProps({
	group: { type: Object, required: true },
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const badge = computed(() => {
	const { role, invitations, join_request: request } = props.group.viewer;
	if (ROLE_LABELS[role]) return ROLE_LABELS[role];
	if (invitations.length) return 'Invited';
	return request ? 'Requested' : '';
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const members = computed(() =>
	props.group.member_count === undefined ? '' : countLabel(props.group.member_count, 'member'),
);
</script>

<template>
	<li class="group-card" :data-group-id="group.id" :data-role="group.viewer.role">
		<div class="group-card__body">
			<p class="group-card__meta">
				<span>Created by {{ group.creator.display_name }}</span>
				<span v-if="members"> · {{ members }}</span>
				<span v-if="badge" class="badge group-card__badge">{{ badge }}</span>
			</p>
			<h2 class="group-card__title">
				<RouterLink :to="{ name: 'group', params: { id: group.id } }">{{ group.title }}</RouterLink>
			</h2>
			<p class="group-card__description">{{ group.description }}</p>
		</div>
		<MembershipActions :group="group" />
	</li>
</template>
