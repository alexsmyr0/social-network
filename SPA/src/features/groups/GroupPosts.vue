<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, ref } from 'vue';
import { useRoute } from 'vue-router';

import { contentKey } from '../content/content-state.js';
import { feedQuery, readFeedQuery } from '../content/content-utils.js';
import PostCard from '../content/PostCard.vue';
import PaginationNav from '../social/PaginationNav.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';

// Mounted by GroupPage only while the server-reported role is a member's, so
// the group feed is never requested for anyone else. The feed read carries the
// group, and the server still answers 404 for a nonmember.
const props = defineProps({
	group: { type: Object, required: true },
	viewerId: { type: Number, default: null },
});

const social = inject(socialKey);
const content = inject(contentKey);
const route = useRoute();

const filters = computed(() => readFeedQuery(route.query));
const flash = ref(content.takeFlash('group-posts'));

const { status, result, reload } = useSocialResource(
	() =>
		content.api.fetchFeed({
			groupId: props.group.id,
			feed: filters.value.feed,
			categoryId: filters.value.categoryId,
			page: filters.value.page,
		}),
	{
		social,
		sources: () => [
			props.group.id,
			props.viewerId,
			filters.value.feed,
			filters.value.categoryId,
			filters.value.page,
		],
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
const unknownCategory = computed(
	() =>
		filters.value.categoryId !== null &&
		categories.status.value === 'ready' &&
		activeCategory.value === null,
);
const beyondLastPage = computed(
	() => posts.value.length === 0 && pagination.value?.total > 0 && filters.value.page > 1,
);
const summary = computed(() => {
	if (!pagination.value) return '';
	const total = countLabel(pagination.value.total, 'post');
	const scope = filters.value.feed === 'following' ? ' from people you follow' : '';
	const category = activeCategory.value ? ` in ${activeCategory.value.name}` : '';
	return `${total}${scope}${category}`;
});
const emptyMessage = computed(() => {
	if (filters.value.feed === 'following') {
		return {
			title: 'Nothing here from people you follow.',
			body: 'Posts by members you follow appear here. Switch to Everyone to see every member’s posts.',
		};
	}
	if (filters.value.categoryId) {
		return { title: 'No posts in this category yet.', body: 'Try another category or all posts.' };
	}
	return {
		title: 'No one has posted here yet.',
		body: `Start the conversation in ${props.group.title}.`,
	};
});

function filterLink(changes) {
	return {
		name: 'group-posts',
		params: { id: props.group.id },
		query: feedQuery({ ...filters.value, page: 1, ...changes }),
	};
}
</script>

<template>
	<section class="group-section group-posts" data-screen="group-posts" aria-labelledby="group-posts-heading">
		<header class="group-posts__head">
			<div>
				<h2 id="group-posts-heading">Posts</h2>
				<p class="group-posts__lede">
					Visible to everyone who is currently in {{ group.title }}, whoever they follow. A member’s
					posts stay here if they leave.
				</p>
			</div>
			<p class="feed-view__actions">
				<RouterLink class="button button--primary" :to="{ name: 'group-compose', params: { id: group.id } }">Write a post</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'my-posts', query: { status: 'draft' } }">Your drafts <span aria-hidden="true">↗</span></RouterLink>
			</p>
		</header>

		<p v-if="flash" class="content-flash" role="status">{{ flash }}</p>

		<nav class="feed-filters" aria-label="Group post filters">
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
			<h3>That category isn’t available.</h3>
			<p>It may have been removed, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="filterLink({ categoryId: null })">Show all categories</RouterLink>
		</div>

		<div class="social-view__results" :aria-busy="status === 'loading'">
			<p v-if="status === 'loading'" class="social-status" role="status">Loading posts…</p>

			<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
				<h3>We can’t load this group’s posts right now.</h3>
				<p>Nothing is shown until we can confirm you’re still a member.</p>
				<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
			</div>

			<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" role="status" data-state="closed">
				<h3>These posts aren’t available to you.</h3>
				<p>Group posts are for current members. If you were removed or left, request to join again to read them.</p>
				<RouterLink class="button button--secondary" :to="{ name: 'group', params: { id: group.id } }">About this group</RouterLink>
			</div>

			<template v-else-if="status === 'ready'">
				<p class="social-status" role="status">{{ summary }}</p>

				<div v-if="beyondLastPage" class="social-state" role="status">
					<h3>That page doesn’t exist.</h3>
					<p>The list is shorter than it was. Go back to the first page.</p>
					<RouterLink class="button button--secondary" :to="filterLink({})">First page</RouterLink>
				</div>
				<div v-else-if="posts.length === 0 && !unknownCategory" class="social-state" role="status">
					<h3>{{ emptyMessage.title }}</h3>
					<p>{{ emptyMessage.body }}</p>
				</div>
				<ol v-else-if="posts.length" class="post-list" aria-label="Group posts">
					<li v-for="post in posts" :key="post.id">
						<PostCard :post="post" :viewer-id="viewerId" />
					</li>
				</ol>

				<PaginationNav v-if="pagination" :page="filters.page" :total-pages="pagination.total_pages" label="Group post pages" />
			</template>
		</div>
	</section>
</template>
