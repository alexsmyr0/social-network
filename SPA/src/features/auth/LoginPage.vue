<script setup>
import { computed, inject, nextTick, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { safeReturnPath } from './return-path.js';
import { sessionKey } from './session-state.js';

const session = inject(sessionKey);
const route = useRoute();
const router = useRouter();
const form = reactive({ email: '', password: '' });
const errors = reactive({});
const formError = ref('');
const pending = ref(false);
const alert = ref(null);
const destination = computed(() => safeReturnPath(route.query.redirect));

function validate() {
	for (const field of Object.keys(errors)) delete errors[field];
	formError.value = '';
	if (!form.email.trim()) errors.email = 'Enter your email address.';
	else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(form.email.trim())) {
		errors.email = 'Enter a valid email address.';
	}
	if (!form.password) errors.password = 'Enter your password.';
	return Object.keys(errors).length === 0;
}

function focusFirstError() {
	const first = Object.keys(errors)[0];
	document.querySelector(`[name="${first}"]`)?.focus();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function submit() {
	if (pending.value) return;
	if (!validate()) {
		focusFirstError();
		return;
	}
	pending.value = true;
	try {
		const result = await session.signIn({ email: form.email, password: form.password });
		if (result.status === 'authenticated') {
			form.password = '';
			await router.replace(destination.value);
			return;
		}
		formError.value =
			result.status === 'invalid-credentials'
				? 'That email and password combination wasn’t recognized.'
				: 'The account service isn’t responding. Your details are still here; try again.';
		await nextTick();
		alert.value?.focus();
	} finally {
		pending.value = false;
	}
}
</script>

<template>
	<section class="access-view login-view" data-screen="login">
		<div class="access-view__story">
			<p class="eyebrow">Welcome back</p>
			<h1>Come back to the conversation.</h1>
			<p>Your place stays private while we confirm who’s at the door.</p>
			<RouterLink class="text-link text-link--light" to="/register">
				New here? Create an account <span aria-hidden="true">↗</span>
			</RouterLink>
		</div>

		<div class="access-view__panel">
			<form class="login-form" novalidate @submit.prevent="submit">
				<p class="access-view__step">Member access</p>
				<h2>Sign in to your place.</h2>
				<p class="login-form__intro">Use the email attached to your account. Your session stays in a secure browser cookie—never in local storage.</p>

				<div v-if="formError" ref="alert" class="form-alert" role="alert" tabindex="-1">
					<strong>We couldn’t sign you in.</strong>
					<span>{{ formError }}</span>
				</div>

				<div class="form-field" :class="{ 'form-field--error': errors.email }">
					<label for="login-email">Email</label>
					<input id="login-email" v-model="form.email" name="email" type="email" autocomplete="email" :aria-invalid="Boolean(errors.email)" :aria-describedby="errors.email ? 'login-email-error' : undefined" />
					<p v-if="errors.email" id="login-email-error" class="field-error">{{ errors.email }}</p>
				</div>

				<div class="form-field" :class="{ 'form-field--error': errors.password }">
					<label for="login-password">Password</label>
					<input id="login-password" v-model="form.password" name="password" type="password" autocomplete="current-password" :aria-invalid="Boolean(errors.password)" :aria-describedby="errors.password ? 'login-password-error login-password-hint' : 'login-password-hint'" />
					<p id="login-password-hint" class="field-hint">Never saved by Commonplace in this browser.</p>
					<p v-if="errors.password" id="login-password-error" class="field-error">{{ errors.password }}</p>
				</div>

				<button class="button button--primary login-form__submit" type="submit" :disabled="pending" :aria-busy="pending">
					{{ pending ? 'Opening your place…' : 'Sign in' }}
				</button>
			</form>
		</div>
	</section>
</template>
