<script setup>
import { inject } from 'vue';

import { sessionKey } from '../auth/session-state.js';

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const session = inject(sessionKey);
</script>

<template>
	<section class="home-view" data-screen="home">
		<div class="home-view__hero">
			<p class="eyebrow">Welcome home, {{ session.state.account.display_name }}</p>
			<h1>Your circle is ready to <em>come alive.</em></h1>
			<p class="home-view__lede">
				Your private session is restored. Profiles, groups and conversations will settle into
				this protected space as the next phases arrive.
			</p>
			<p class="home-view__actions">
				<RouterLink class="button button--primary" :to="{ name: 'feed' }">Open your feed</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'compose' }">
					Write a post <span aria-hidden="true">↗</span>
				</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'people' }">
					Find people <span aria-hidden="true">↗</span>
				</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'profile', params: { id: session.state.account.id } }">
					Your profile <span aria-hidden="true">↗</span>
				</RouterLink>
			</p>
		</div>
	</section>
</template>
