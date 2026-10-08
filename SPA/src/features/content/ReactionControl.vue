<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, ref, watch } from 'vue';
import { sessionKey } from '../auth/session-state.js';
import { contentKey } from './content-state.js';

const props = defineProps({
	kind: { type: String, required: true },
	item: { type: Object, required: true },
});
const content = inject(contentKey);
const session = inject(sessionKey);
const message = ref('');
const busy = computed(() => content.isPending(`${props.kind}-${props.item.id}`));
watch(
	() => session.state.account?.id,
	() => {
		message.value = '';
	},
);
async function react(reaction) {
	const result = await content.react(props.kind, props.item.id, reaction);
	if (['superseded', 'unauthenticated', 'busy'].includes(result.status)) return;
	message.value =
		result.status === 'ok'
			? ''
			: result.status === 'not-found'
				? 'This discussion is no longer available.'
				: 'The reaction could not be confirmed. Check the refreshed counts before trying again.';
}
</script>
<template>
 <div class="discussion-reactions" :aria-busy="busy">
  <button type="button" :disabled="busy" :aria-pressed="item.my_reaction === 1" @click="react('like')">Like · {{ item.likes }}</button>
  <button type="button" :disabled="busy" :aria-pressed="item.my_reaction === -1" @click="react('dislike')">Dislike · {{ item.dislikes }}</button>
  <p v-if="message" role="alert">{{ message }}</p>
 </div>
</template>
