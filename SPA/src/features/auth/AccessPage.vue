<script setup>
defineProps({
	eyebrow: { type: String, required: true },
	title: { type: String, required: true },
	description: { type: String, required: true },
	ticket: { type: String, required: true },
	alternateLabel: { type: String, required: true },
	alternateTo: { type: String, required: true },
	screen: { type: String, required: true },
});
</script>

<template>
	<section class="access-view" :data-screen="screen">
		<div class="access-view__story">
			<p class="eyebrow">{{ eyebrow }}</p>
			<h1>{{ title }}</h1>
			<p>{{ description }}</p>
			<RouterLink class="text-link text-link--light" :to="alternateTo">
				{{ alternateLabel }}
				<span aria-hidden="true">↗</span>
			</RouterLink>
		</div>

		<div class="access-view__panel">
			<p class="access-view__step">Phase 1 · {{ ticket }}</p>
			<h2>Account controls are next.</h2>
			<p>
				This route is ready, but the final form and session behavior belong to a separate
				ticket. Nothing entered here would be saved yet, so we are not showing a fake form.
			</p>
			<div class="access-view__notice" role="status">
				<span aria-hidden="true">◎</span>
				<span>Route active · implementation pending</span>
			</div>
			<RouterLink class="button button--secondary" to="/">Return home</RouterLink>
		</div>
	</section>
</template>
