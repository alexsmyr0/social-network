<script setup>
import { computed, ref, watch } from 'vue';
// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { AUDIENCE_LABELS, feedQuery, formatPostDate, STATUS_LABELS } from './content-utils.js';

const props = defineProps({
	post: { type: Object, required: true },
	viewerId: { type: Number, default: null },
});

const own = computed(() => props.post.author_id === props.viewerId);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const headingId = computed(() => `post-${props.post.id}-heading`);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const audienceLabel = computed(() => AUDIENCE_LABELS[props.post.audience]);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const statusLabel = computed(() =>
	props.post.status === 'published' ? '' : STATUS_LABELS[props.post.status],
);

// Recipients are the author's own information; other viewers see only the
// audience kind, never who else was chosen.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const recipientNote = computed(() => {
	if (!own.value || props.post.audience !== 'selected') return '';
	const count = props.post.selected_follower_ids?.length ?? 0;
	if (count === 0) return 'No current recipients — only you can see it.';
	return `Shared with ${count} selected ${count === 1 ? 'follower' : 'followers'}.`;
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const editLabel = computed(() => {
	const name = props.post.title ? `“${props.post.title}”` : 'this post';
	return props.post.status === 'draft' ? `Continue draft ${name}` : `Edit ${name}`;
});

// Stored media can be missing or revoked; keep the text and say so instead of
// showing a broken image.
const imageFailed = ref(false);
watch(
	() => props.post.image_url,
	() => {
		imageFailed.value = false;
	},
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function categoryLink(categoryId) {
	return { name: 'feed', query: feedQuery({ feed: 'all', categoryId, page: 1 }) };
}
</script>

<template>
	<article class="post-card" :data-post-id="post.id" :aria-labelledby="headingId">
		<header class="post-card__head">
			<p class="post-card__byline">
				<RouterLink class="post-card__author" :to="{ name: 'profile', params: { id: post.author_id } }">{{ post.author }}</RouterLink>
				<time :datetime="post.created_at">{{ formatPostDate(post.created_at) }}</time>
			</p>
			<p class="post-card__badges">
				<span class="badge badge--audience" :data-audience="post.audience">{{ audienceLabel }}</span>
				<span v-if="statusLabel" class="badge badge--status" :data-status="post.status">{{ statusLabel }}</span>
			</p>
		</header>

		<h2 v-if="post.title" :id="headingId" class="post-card__title">{{ post.title }}</h2>
		<h2 v-else :id="headingId" class="visually-hidden">Post by {{ post.author }}</h2>

		<p v-if="post.body" class="post-card__body">{{ post.body }}</p>

		<figure v-if="post.image_url" class="post-card__media">
			<img v-if="!imageFailed" :src="post.image_url" :alt="`Image shared by ${post.author}`" loading="lazy" @error="imageFailed = true" />
			<figcaption v-else class="post-card__media-missing">This image isn’t available right now.</figcaption>
		</figure>

		<ul v-if="post.categories.length" class="post-card__categories" aria-label="Categories">
			<li v-for="category in post.categories" :key="category.id">
				<RouterLink :to="categoryLink(category.id)">{{ category.name }}</RouterLink>
			</li>
		</ul>

		<footer class="post-card__foot">
			<p class="post-card__counts">
				<span>{{ post.likes }} {{ post.likes === 1 ? 'like' : 'likes' }}</span>
				<span>{{ post.dislikes }} {{ post.dislikes === 1 ? 'dislike' : 'dislikes' }}</span>
			</p>
			<p v-if="recipientNote" class="post-card__note">{{ recipientNote }}</p>
			<RouterLink v-if="own" class="post-card__edit" :to="{ name: 'edit-post', params: { id: post.id } }" :aria-label="editLabel">
				{{ post.status === 'draft' ? 'Continue draft' : 'Edit' }}
			</RouterLink>
		</footer>
	</article>
</template>
