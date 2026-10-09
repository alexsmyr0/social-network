<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, ref, watch } from 'vue';
import { sessionKey } from '../auth/session-state.js';
import CommentForm from './CommentForm.vue';
import { contentKey } from './content-state.js';
import { formatPostDate } from './content-utils.js';
import ReactionControl from './ReactionControl.vue';

const props = defineProps({
	comment: { type: Object, required: true },
	interactive: { type: Boolean, default: false },
});
const emit = defineEmits(['reply']);
const session = inject(sessionKey);
const content = inject(contentKey);
const own = computed(() => props.comment.user_id === session.state.account?.id);
const editing = ref(false);
const confirm = ref(false);
const error = ref('');
const imageFailed = ref(false);
watch(
	() => props.comment.image_url,
	() => {
		imageFailed.value = false;
	},
);
const busy = computed(() => content.isPending(`comment-${props.comment.id}`));
async function remove() {
	const result = await content.deleteComment(props.comment.id, props.comment.version);
	if (['superseded', 'unauthenticated', 'busy'].includes(result.status)) return;
	confirm.value = false;
	error.value =
		result.status === 'ok'
			? ''
			: result.status === 'stale'
				? 'This comment changed. Review the refreshed comment before deleting.'
				: 'Deletion could not be confirmed. Check the discussion before trying again.';
}
</script>
<template>
 <article :id="`comment-${comment.id}`" class="comment-card" :data-comment-id="comment.id" tabindex="-1">
  <header class="post-card__byline"><RouterLink :to="{name:'profile',params:{id:comment.user_id}}">{{ comment.username }}</RouterLink><time :datetime="comment.created_at">{{ formatPostDate(comment.created_at) }}</time></header>
  <p v-if="comment.parent_comment_id" class="comment-parent"><RouterLink :to="{name:'comment',params:{id:comment.parent_comment_id}}">Reply to comment #{{ comment.parent_comment_id }}</RouterLink></p>
  <CommentForm v-if="editing && interactive && own" :post-id="comment.post_id" :comment="comment" @saved="editing = false" @cancel="editing = false" />
  <template v-else>
   <p class="post-card__body">{{ comment.body }}</p>
   <figure v-if="comment.image_url" class="post-card__media"><img v-if="!imageFailed" :src="comment.image_url" :alt="`Image shared by ${comment.username}`" loading="lazy" @error="imageFailed = true" /><figcaption v-else>This image isn’t available right now.</figcaption></figure>
   <RouterLink v-if="!interactive" class="text-link" :to="{name:'comment',params:{id:comment.id}}">{{ comment.post?.title || 'Open discussion' }}</RouterLink>
   <template v-if="interactive">
    <ReactionControl kind="comments" :item="comment" />
    <div class="discussion-actions">
     <button type="button" class="button button--secondary" @click="emit('reply',comment)">Reply</button>
     <button v-if="own" type="button" class="button button--secondary" :disabled="busy" @click="editing = true">Edit comment</button>
     <button v-if="own" type="button" class="button button--secondary" :disabled="busy" @click="confirm = true">Delete comment</button>
    </div>
    <div v-if="confirm && own" role="alert"><p>Delete this comment and all its replies?</p><button class="button button--primary" type="button" :disabled="busy" @click="remove">Confirm deletion</button><button class="button button--secondary" type="button" :disabled="busy" @click="confirm = false">Keep comment</button></div>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
   </template>
  </template>
 </article>
</template>
