<script setup>
import { computed, inject, ref } from 'vue';
import { useRoute } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel, parsePage } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { contentKey } from './content-state.js';
import { readStatusQuery } from './content-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PostCard from './PostCard.vue';

const session = inject(sessionKey);
const social = inject(socialKey);
const content = inject(contentKey);
const route = useRoute();

const filter = computed(() => readStatusQuery(route.query.status));
const page = computed(() => parsePage(route.query.page));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const viewerId = computed(() => session.state.account?.id ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const flash = ref(content.takeFlash('my-posts'));

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	() => content.api.fetchMyPosts({ status: filter.value, page: page.value }),
	{ social, sources: () => [filter.value, page.value] },
);

const posts = computed(() => result.value?.posts ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const tabs = [
	{ value: 'all', label: 'All' },
	{ value: 'published', label: 'Published' },
	{ value: 'draft', label: 'Drafts' },
];
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => posts.value.length === 0 && pagination.value?.total > 0 && page.value > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() => {
	if (!pagination.value) return '';
	if (filter.value === 'draft') return countLabel(pagination.value.total, 'draft');
	return countLabel(
		pagination.value.total,
		filter.value === 'published' ? 'published post' : 'post',
	);
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const emptyTitle = computed(() =>
	filter.value === 'draft' ? 'No drafts saved.' : 'You haven’t posted yet.',
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function tabLink(value) {
	return { name: 'my-posts', query: value === 'all' ? {} : { status: value } };
}
</script>

<template>
	<section class="social-view my-posts-view" data-screen="my-posts">
		<header class="social-view__head feed-view__head">
			<div>
				<p class="eyebrow">Your posts</p>
				<h1>Everything you’ve <em>written.</em></h1>
				<p class="social-view__lede">Drafts and archived posts are visible only to you. Open one to edit, publish or delete it.</p>
			</div>
			<p class="feed-view__actions">
				<RouterLink class="button button--primary" :to="{ name: 'compose' }">Write a post</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'feed' }">Back to the feed <span aria-hidden="true">↗</span></RouterLink>
			</p>
		</header>

		<p v-if="flash" class="content-flash" role="status">{{ flash }}</p>

		<nav class="feed-filters" aria-label="Post status">
			<ul class="segmented">
				<li v-for="tab in tabs" :key="tab.value">
					<RouterLink :to="tabLink(tab.value)" :aria-current="filter === tab.value ? 'page' : undefined">{{ tab.label }}</RouterLink>
				</li>
			</ul>
		</nav>

		<div class="social-view__results" :aria-busy="status === 'loading'">
			<p v-if="status === 'loading'" class="social-status" role="status">Loading your posts…</p>

			<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
				<h2>We can’t load your posts right now.</h2>
				<p>Nothing was changed. Try again in a moment.</p>
				<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
			</div>

			<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" role="status">
				<h2>That view can’t be shown.</h2>
				<RouterLink class="button button--secondary" :to="{ name: 'my-posts' }">Show all posts</RouterLink>
			</div>

			<template v-else-if="status === 'ready'">
				<p class="social-status" role="status">{{ summary }}</p>
				<div v-if="beyondLastPage" class="social-state" role="status">
					<h2>That page doesn’t exist.</h2>
					<p>The list is shorter than it was.</p>
					<RouterLink class="button button--secondary" :to="tabLink(filter)">First page</RouterLink>
				</div>
				<div v-else-if="posts.length === 0" class="social-state" role="status">
					<h2>{{ emptyTitle }}</h2>
					<p>Start with a few words or an image.</p>
				</div>
				<ol v-else class="post-list" aria-label="Your posts">
					<li v-for="post in posts" :key="post.id">
						<PostCard :post="post" :viewer-id="viewerId" />
					</li>
				</ol>
				<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" label="Your post pages" />
			</template>
		</div>
	</section>
</template>
