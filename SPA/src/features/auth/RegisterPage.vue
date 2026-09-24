<script setup>
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import AccessPage from './AccessPage.vue';
</script>

<template>
	<AccessPage
		eyebrow="Make your place"
		title="A profile built around a real person."
		description="The complete registration experience—including optional avatar, nickname and about-me fields—will arrive in SN-A04."
		ticket="SN-A04"
		alternate-label="Already belong? Sign in"
		alternate-to="/login"
		screen="register"
	/>
</template>
