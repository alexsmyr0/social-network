<script setup>
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import AccessPage from './AccessPage.vue';
</script>

<template>
	<AccessPage
		eyebrow="Welcome back"
		title="Pick up where your people left off."
		description="Sign-in and persistent-session behavior will be implemented against the approved account contract in SN-A05."
		ticket="SN-A05"
		alternate-label="New here? Create an account"
		alternate-to="/register"
		screen="login"
	/>
</template>
