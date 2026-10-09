<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, ref, watch } from 'vue';
import * as contentApi from '../../api/content.js';
import { sessionKey } from '../auth/session-state.js';
import { socialKey } from '../social/social-state.js';
import { countLabel } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import CommentCard from './CommentCard.vue';
import { contentKey } from './content-state.js';
import PostCard from './PostCard.vue';

const props = defineProps({
	userId: { type: Number, default: null },
	privateHistory: { type: Boolean, default: false },
});
const content = inject(contentKey, { api: contentApi });
const social = inject(socialKey);
const session = inject(sessionKey);
const tab = ref(props.privateHistory ? 'created_posts' : 'posts');
const page = ref(1);
const filter = ref('all');
const tabs = computed(() =>
	props.privateHistory
		? [
				['created_posts', 'Created'],
				['liked_posts', 'Liked'],
				['disliked_posts', 'Disliked'],
				['comments', 'Comments'],
			]
		: [
				['posts', 'Posts'],
				['comments', 'Comments'],
			],
);
watch([tab, filter, () => props.userId], () => {
	page.value = 1;
});
const viewerId = computed(() => session.state.account?.id);
const { status, result, reload } = useSocialResource(
	async () => {
		if (props.privateHistory)
			return content.api.fetchActivity({ page: page.value, status: filter.value });
		return tab.value === 'posts'
			? content.api.fetchProfilePosts(props.userId, { page: page.value })
			: content.api.fetchProfileComments(props.userId, { page: page.value });
	},
	{ social, sources: () => [props.userId, tab.value, page.value, filter.value, viewerId.value] },
);
const section = computed(() =>
	props.privateHistory
		? result.value?.activity?.[tab.value]
		: result.value
			? { items: result.value.posts ?? result.value.comments, pagination: result.value.pagination }
			: null,
);
</script>
<template>
 <section class="activity-panel" :aria-busy="status === 'loading'" data-screen="activity-panel">
  <h2>{{ privateHistory ? 'Your history' : 'Published activity' }}</h2>
  <nav class="feed-filters" aria-label="Activity sections"><ul class="segmented"><li v-for="[key,label] in tabs" :key="key"><button type="button" :aria-pressed="tab === key" @click="tab = key">{{ label }}</button></li></ul></nav>
  <label v-if="privateHistory && tab === 'created_posts'" class="activity-filter">Post status<select v-model="filter"><option value="all">All</option><option value="published">Published</option><option value="draft">Drafts</option></select></label>
  <p v-if="status === 'loading'" role="status" class="social-status">Loading activity…</p>
  <div v-else-if="status === 'unavailable'" class="social-state" role="alert"><h3>Activity could not be loaded.</h3><button class="button button--secondary" type="button" @click="reload('hard')">Try again</button></div>
  <p v-else-if="status === 'not-found' || status === 'rejected'" role="status">This activity isn’t available.</p>
  <template v-else-if="section">
   <p class="social-status" role="status">{{ countLabel(section.pagination.total, tab === 'comments' ? 'comment' : 'post') }}</p>
   <p v-if="!section.items.length" role="status">{{ page > 1 ? 'This page is empty. Return to the first page.' : 'No activity to show here.' }}</p>
   <ol class="post-list" aria-label="Activity"><li v-for="item in section.items" :key="item.id"><CommentCard v-if="tab === 'comments'" :comment="item" /><PostCard v-else :post="item" :viewer-id="viewerId" /></li></ol>
   <nav v-if="section.pagination.total_pages > 1 || page > 1" class="pager" aria-label="Activity pages"><button class="button button--secondary" type="button" :disabled="page <= 1" @click="page -= 1">Previous</button><span>Page {{ page }} of {{ section.pagination.total_pages || 1 }}</span><button class="button button--secondary" type="button" :disabled="page >= section.pagination.total_pages" @click="page += 1">Next</button></nav>
  </template>
 </section>
</template>
