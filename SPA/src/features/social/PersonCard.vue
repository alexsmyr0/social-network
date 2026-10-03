<script setup>
import { computed } from 'vue';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import FollowControl from './FollowControl.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from './SocialAvatar.vue';

const props = defineProps({
	person: { type: Object, required: true },
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const isSelf = computed(() => props.person.relationship.state === 'self');
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const limited = computed(() => props.person.access === 'teaser');
</script>

<template>
	<li class="person" :data-person-id="person.id" :data-access="person.access">
		<SocialAvatar :name="person.display_name" :src="person.avatar_url ?? null" />
		<div class="person__body">
			<RouterLink class="person__name" :to="{ name: 'profile', params: { id: person.id } }">
				{{ person.display_name }}
			</RouterLink>
			<p v-if="isSelf" class="person__note">This is you</p>
			<p v-else-if="limited" class="person__note">Private profile · name only</p>
		</div>
		<FollowControl :person="person" />
	</li>
</template>
