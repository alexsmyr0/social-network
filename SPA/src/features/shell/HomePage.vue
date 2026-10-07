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

		<aside class="signal-board" aria-label="Product foundation">
			<div class="signal-board__number" aria-hidden="true">01</div>
			<p class="signal-board__kicker">Private session active</p>
			<h2>You’re safely inside.</h2>
			<p>
				This account view is only rendered after the server confirms your session.
			</p>
			<ul class="signal-list">
				<li><span aria-hidden="true">✓</span> Cookie-backed access</li>
				<li><span aria-hidden="true">✓</span> Protected route boundary</li>
				<li><span aria-hidden="true">✓</span> Sign out from every screen</li>
			</ul>
		</aside>

		<div class="feature-line" aria-label="Planned social network areas">
			<p>Coming into focus</p>
			<ul>
				<li>Discussions</li>
				<li>Groups</li>
				<li>Conversations</li>
			</ul>
		</div>
	</section>
</template>
