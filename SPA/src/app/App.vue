<script setup>
import { computed, inject, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { checkBackendHealth } from '../api/health.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import HealthStatus from '../components/HealthStatus.vue';
import { sessionKey } from '../features/auth/session-state.js';

const session = inject(sessionKey);
const route = useRoute();
const router = useRouter();
const sessionNotice = ref(null);
const protectsContent = computed(() => Boolean(route.meta.requiresAuth));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const canShowRoute = computed(
	() => !protectsContent.value || session.state.status === 'authenticated',
);

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

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function signOut() {
	const result = await session.signOut();
	if (result.status === 'logged-out') {
		await router.replace({ name: 'login' });
		return;
	}
	await nextTick();
	sessionNotice.value?.focus();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function retrySession() {
	await session.restore({ force: true });
	if (session.state.status === 'unauthenticated') {
		await router.replace({ name: 'login', query: { redirect: route.fullPath } });
	}
}
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
				<template v-if="session.state.status === 'authenticated'">
					<RouterLink to="/">Home</RouterLink>
					<span class="site-nav__identity">{{ session.state.account.display_name }}</span>
					<button class="site-nav__logout" type="button" :disabled="session.state.logoutPending" @click="signOut">
						{{ session.state.logoutPending ? 'Signing out…' : 'Sign out' }}
					</button>
				</template>
				<template v-else>
					<RouterLink to="/login">Sign in</RouterLink>
					<RouterLink class="site-nav__accent" to="/register">Join</RouterLink>
				</template>
			</nav>
		</header>

		<main id="main-content" tabindex="-1">
			<div v-if="session.state.logoutError" ref="sessionNotice" class="session-banner" role="alert" tabindex="-1">
				<span>{{ session.state.logoutError }}</span>
				<button type="button" :disabled="session.state.logoutPending" @click="signOut">Try sign out again</button>
			</div>
			<RouterView v-if="canShowRoute" />
			<section v-else class="session-gate" :aria-busy="session.state.status === 'checking'">
				<p class="eyebrow">Session check</p>
				<template v-if="session.state.status === 'checking'">
					<h1>Opening your place…</h1>
					<p>We’re confirming this browser’s session before showing anything personal.</p>
				</template>
				<template v-else>
					<h1>Your place is still private.</h1>
					<p>We can’t reach the account service, so we haven’t assumed you’re signed out or exposed protected content.</p>
					<button class="button button--primary" type="button" @click="retrySession">Try session again</button>
				</template>
			</section>
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
