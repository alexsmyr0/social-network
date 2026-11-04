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
		<div class="access-view__panel">
			<form class="login-form" novalidate @submit.prevent="submit">
				<h2>Sign in</h2>
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
					<input id="login-password" v-model="form.password" name="password" type="password" autocomplete="current-password" :aria-invalid="Boolean(errors.password)" :aria-describedby="errors.password ? 'login-password-error' : undefined" />
					<p v-if="errors.password" id="login-password-error" class="field-error">{{ errors.password }}</p>
				</div>

				<button class="button button--primary login-form__submit" type="submit" :disabled="pending" :aria-busy="pending">
					{{ pending ? 'Opening your place…' : 'Sign in' }}
				</button>
				<p class="form-switch">
					New here? <RouterLink class="text-link" to="/register">Create an account</RouterLink>
				</p>
			</form>
		</div>
	</section>
</template>
