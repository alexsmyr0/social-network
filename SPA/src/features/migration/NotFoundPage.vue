<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const retiredPrefixes = [
	'/posts/',
	'/post/',
	'/view-post/',
	'/create-post',
	'/edit-post/',
	'/activity',
	'/profile/',
];
// biome-ignore lint/correctness/noUnusedVariables: exposed through the Vue template
const isRetiredRoute = computed(() =>
	retiredPrefixes.some((prefix) => route.path === prefix || route.path.startsWith(prefix)),
);
</script>

<template>
	<section class="missing-view" data-screen="route-unavailable">
		<p class="missing-view__code" aria-hidden="true">{{ isRetiredRoute ? 'MOVED' : '404' }}</p>
		<div>
			<p class="eyebrow">{{ isRetiredRoute ? 'Migration in progress' : 'No route here' }}</p>
			<h1>
				{{ isRetiredRoute ? 'This forum route is resting.' : 'This path is off the map.' }}
			</h1>
			<p>
				{{
					isRetiredRoute
						? 'It will return only when its social-network feature is ready and access-tested.'
						: 'The address may be incomplete, or the page has not been created.'
				}}
			</p>
			<code>{{ route.fullPath }}</code>
			<RouterLink class="button button--primary" to="/">Back to the front door</RouterLink>
		</div>
	</section>
</template>
