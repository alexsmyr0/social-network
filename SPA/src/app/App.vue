<script setup>
import { onMounted, ref } from 'vue';

import { checkBackendHealth } from '../api/health.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import HealthStatus from '../components/HealthStatus.vue';

const health = ref({
	state: 'loading',
	message: 'Checking backend connection…',
});

async function refreshHealth() {
	health.value = {
		state: 'loading',
		message: 'Checking backend connection…',
	};

	const result = await checkBackendHealth();
	health.value = result.ok
		? { state: 'online', message: result.message }
		: { state: 'error', message: result.message };
}

onMounted(refreshHealth);
</script>

<template>
	<a class="skip-link" href="#main-content">Skip to main content</a>

	<div class="site-frame">
		<header class="site-header">
			<RouterLink class="wordmark" to="/" aria-label="Commonplace home">
				<span class="wordmark__symbol" aria-hidden="true">
					<span></span><span></span><span></span>
				</span>
				<span>Commonplace</span>
			</RouterLink>

			<nav class="site-nav" aria-label="Primary navigation">
				<RouterLink to="/">Home</RouterLink>
				<RouterLink to="/login">Sign in</RouterLink>
				<RouterLink class="site-nav__accent" to="/register">Join</RouterLink>
			</nav>
		</header>

		<main id="main-content" tabindex="-1">
			<RouterView />
		</main>

		<footer class="site-footer">
			<p>Built for smaller circles and stronger connections.</p>
			<HealthStatus
				:state="health.state"
				:message="health.message"
				@retry="refreshHealth"
			/>
		</footer>
	</div>
</template>
