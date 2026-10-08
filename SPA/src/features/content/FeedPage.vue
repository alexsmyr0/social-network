<script setup>
import { computed, inject, ref } from 'vue';
import { useRoute } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { contentKey } from './content-state.js';
import { feedQuery, readFeedQuery } from './content-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PostCard from './PostCard.vue';

const session = inject(sessionKey);
const social = inject(socialKey);
const content = inject(contentKey);
const route = useRoute();

const filters = computed(() => readFeedQuery(route.query));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const viewerId = computed(() => session.state.account?.id ?? null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const flash = ref(content.takeFlash('feed'));

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	() =>
		content.api.fetchFeed({
			feed: filters.value.feed,
			categoryId: filters.value.categoryId,
			page: filters.value.page,
		}),
	{
		social,
		sources: () => [filters.value.feed, filters.value.categoryId, filters.value.page],
	},
);
const categories = useSocialResource(() => content.api.fetchCategories(), {
	social,
	retain: true,
});

const posts = computed(() => result.value?.posts ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
const categoryList = computed(() => categories.result.value?.categories ?? []);
const activeCategory = computed(
	() => categoryList.value.find((category) => category.id === filters.value.categoryId) ?? null,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const unknownCategory = computed(
	() =>
		filters.value.categoryId !== null &&
		categories.status.value === 'ready' &&
		activeCategory.value === null,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const beyondLastPage = computed(
	() => posts.value.length === 0 && pagination.value?.total > 0 && filters.value.page > 1,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const summary = computed(() => {
	if (!pagination.value) return '';
	const total = countLabel(pagination.value.total, 'post');
	const scope = filters.value.feed === 'following' ? ' from people you follow' : '';
	const category = activeCategory.value ? ` in ${activeCategory.value.name}` : '';
	return `${total}${scope}${category}`;
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const emptyMessage = computed(() => {
	if (filters.value.feed === 'following') {
		return {
			title: 'Nothing from people you follow yet.',
			body: 'Posts you’re allowed to see from the people you follow appear here. Your own posts stay in the Everyone view.',
		};
	}
	if (filters.value.categoryId) {
		return { title: 'No posts in this category yet.', body: 'Try another category or all posts.' };
	}
	return {
		title: 'No posts to show yet.',
		body: 'Be the first to share something with your circle.',
	};
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function filterLink(changes) {
	return { name: 'feed', query: feedQuery({ ...filters.value, page: 1, ...changes }) };
}
</script>

<template>
	<section class="social-view feed-view" data-screen="feed">
		<header class="social-view__head feed-view__head">
			<div>
				<p class="eyebrow">Feed</p>
				<h1>What your circle is <em>sharing.</em></h1>
				<p class="social-view__lede">
					Newest first. You only see posts their authors allowed you to see — public posts,
					followers-only posts from people you follow, and posts shared with you.
				</p>
			</div>
			<p class="feed-view__actions">
				<RouterLink class="button button--primary" :to="{ name: 'compose' }">Write a post</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'my-posts' }">Your posts and drafts <span aria-hidden="true">↗</span></RouterLink>
			</p>
		</header>

		<p v-if="flash" class="content-flash" role="status">{{ flash }}</p>

		<nav class="feed-filters" aria-label="Feed filters">
			<ul class="segmented" aria-label="Whose posts">
				<li>
					<RouterLink :to="filterLink({ feed: 'all' })" :aria-current="filters.feed === 'all' ? 'page' : undefined">Everyone</RouterLink>
				</li>
				<li>
					<RouterLink :to="filterLink({ feed: 'following' })" :aria-current="filters.feed === 'following' ? 'page' : undefined">Following</RouterLink>
				</li>
			</ul>
			<ul v-if="categoryList.length" class="category-filter" aria-label="Categories">
				<li>
					<RouterLink :to="filterLink({ categoryId: null })" :aria-current="filters.categoryId === null ? 'page' : undefined">All categories</RouterLink>
				</li>
				<li v-for="category in categoryList" :key="category.id">
					<RouterLink :to="filterLink({ categoryId: category.id })" :aria-current="filters.categoryId === category.id ? 'page' : undefined">{{ category.name }}</RouterLink>
				</li>
			</ul>
		</nav>

		<div v-if="unknownCategory" class="social-state" role="status" data-state="unknown-category">
			<h2>That category isn’t available.</h2>
			<p>It may have been removed, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="filterLink({ categoryId: null })">Show all categories</RouterLink>
		</div>

		<div class="social-view__results" :aria-busy="status === 'loading'">
			<p v-if="status === 'loading'" class="social-status" role="status">Loading posts…</p>

			<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
				<h2>We can’t load posts right now.</h2>
				<p>Nothing is shown until we can confirm what you’re allowed to see.</p>
				<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
			</div>

			<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" role="status">
				<h2>These filters can’t be shown.</h2>
				<p>Reset them to see the latest posts.</p>
				<RouterLink class="button button--secondary" :to="{ name: 'feed' }">Reset filters</RouterLink>
			</div>

			<template v-else-if="status === 'ready'">
				<p class="social-status" role="status">{{ summary }}</p>

				<div v-if="beyondLastPage" class="social-state" role="status">
					<h2>That page doesn’t exist.</h2>
					<p>The feed is shorter than it was. Go back to the first page.</p>
					<RouterLink class="button button--secondary" :to="filterLink({})">First page</RouterLink>
				</div>
				<div v-else-if="posts.length === 0 && !unknownCategory" class="social-state" role="status">
					<h2>{{ emptyMessage.title }}</h2>
					<p>{{ emptyMessage.body }}</p>
				</div>
				<ol v-else-if="posts.length" class="post-list" aria-label="Posts">
					<li v-for="post in posts" :key="post.id">
						<PostCard :post="post" :viewer-id="viewerId" />
					</li>
				</ol>

				<PaginationNav v-if="pagination" :page="filters.page" :total-pages="pagination.total_pages" label="Feed pages" />
			</template>
		</div>
	</section>
</template>
