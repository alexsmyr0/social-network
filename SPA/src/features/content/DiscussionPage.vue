<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { sessionKey } from '../auth/session-state.js';
import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { parsePage, parseUserId } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import CommentCard from './CommentCard.vue';
import CommentForm from './CommentForm.vue';
import { contentKey } from './content-state.js';
import { readFeedQuery } from './content-utils.js';
import PostCard from './PostCard.vue';
import ReactionControl from './ReactionControl.vue';

const route = useRoute();
const content = inject(contentKey);
const social = inject(socialKey);
const session = inject(sessionKey);
const reply = ref(null);
const page = computed(() => parsePage(route.query.page));
const filters = computed(() => readFeedQuery(route.query));
const viewerId = computed(() => session.state.account?.id);
const { status, result, reload } = useSocialResource(
	async () => {
		reply.value = null;
		let focused = null;
		let id = parseUserId(route.params.id);
		if (!id) return { status: 'not-found' };
		if (route.name === 'comment') {
			const resolved = await content.api.fetchComment(id);
			if (resolved.status !== 'ok') return resolved;
			focused = resolved.comment;
			id = focused.post_id;
		}
		const postResult = await content.api.fetchPost(id);
		if (postResult.status !== 'ok') return postResult;
		const thread = await content.api.fetchComments(id, { page: page.value });
		if (thread.status !== 'ok') return thread;
		const nav =
			postResult.post.status === 'published'
				? await content.api.fetchNavigation(id, filters.value)
				: null;
		if (nav?.status === 'unauthenticated') return nav;
		return {
			status: 'ok',
			post: postResult.post,
			comments: thread.comments,
			pagination: thread.pagination,
			focused,
			navigation: nav?.status === 'ok' ? nav.navigation : null,
			navUnavailable: nav?.status === 'unavailable',
		};
	},
	{ social, sources: () => [route.name, route.params.id, route.fullPath, viewerId.value] },
);
const post = computed(() => result.value?.post);
const comments = computed(() => result.value?.comments ?? []);
const focused = computed(() => result.value?.focused);
const navigation = computed(() => result.value?.navigation);
function neighbour(id) {
	const query = {};
	if (filters.value.feed === 'following') query.feed = 'following';
	if (filters.value.categoryId) query.category = String(filters.value.categoryId);
	return { name: 'post', params: { id }, query };
}
watch(
	() => result.value?.focused?.id,
	async (id) => {
		if (!id) return;
		await nextTick();
		const target = document.getElementById(`comment-${id}`);
		target?.focus();
		target?.scrollIntoView?.({ block: 'nearest' });
	},
);
async function startReply(comment) {
	reply.value = comment.id;
	await nextTick();
	document.getElementById('comment-body-new')?.focus();
}
async function saved() {
	reply.value = null;
	await reload('quiet');
	await nextTick();
	document.getElementById('discussion-heading')?.focus();
}
</script>
<template>
 <section class="social-view discussion-view" data-screen="discussion" :aria-busy="status === 'loading'">
  <header class="social-view__head"><p class="eyebrow">Discussion</p><h1 id="discussion-heading" tabindex="-1">A place to <em>talk.</em></h1><RouterLink class="text-link" :to="{name:'feed'}">Back to feed</RouterLink></header>
  <p v-if="status === 'loading'" role="status" class="social-status">Loading discussion…</p>
  <div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" role="status"><h2>This discussion isn’t available.</h2><p>It may have been deleted, or you may no longer have access.</p></div>
  <div v-else-if="status === 'unavailable'" class="social-state" role="alert"><h2>We can’t load this discussion right now.</h2><button class="button button--secondary" type="button" @click="reload('hard')">Try again</button></div>
  <template v-else-if="post">
   <PostCard :post="post" :viewer-id="viewerId" />
   <ReactionControl kind="posts" :item="post" />
   <nav v-if="navigation" class="discussion-actions" aria-label="Nearby posts"><RouterLink v-if="navigation.prev_id" class="button button--secondary" :to="neighbour(navigation.prev_id)">Previous post</RouterLink><RouterLink v-if="navigation.next_id" class="button button--secondary" :to="neighbour(navigation.next_id)">Next post</RouterLink></nav>
   <p v-if="result.navUnavailable" role="status">Nearby posts could not be loaded.</p>
   <h2>Comments · {{ result.pagination.total }}</h2>
   <div v-if="focused && !comments.some(item => item.id === focused.id)" class="focused-comment"><h3>Linked comment</h3><CommentCard :comment="focused" interactive @reply="startReply" /></div>
   <p v-if="comments.length === 0" class="social-status" role="status">{{ page > 1 ? 'There are no comments on this page. Return to the first page.' : 'No comments yet. Start the conversation.' }}</p>
   <RouterLink v-if="comments.length === 0 && page > 1" class="button button--secondary" :to="{path:route.path,query:{...route.query,page:undefined}}">First page</RouterLink>
   <ol class="comment-list" aria-label="Discussion comments"><li v-for="comment in comments" :key="comment.id"><CommentCard :comment="comment" interactive @reply="startReply" /></li></ol>
   <PaginationNav :page="page" :total-pages="result.pagination.total_pages" label="Comment pages" />
   <CommentForm :key="`${post.id}-${reply}`" :post-id="post.id" :parent-id="reply" @saved="saved" @cancel="reply = null" />
  </template>
 </section>
</template>
