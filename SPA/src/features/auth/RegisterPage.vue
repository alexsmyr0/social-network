<script setup>
import { computed, onBeforeUnmount, reactive, ref } from 'vue';

import { RegistrationError, registerAccount } from '../../api/registration.js';

const avatarTypes = new Set(['image/jpeg', 'image/png', 'image/gif']);
const form = reactive({
	email: '',
	password: '',
	firstName: '',
	lastName: '',
	dateOfBirth: '',
	nickname: '',
	aboutMe: '',
	avatar: null,
});
const errors = reactive({});
const formError = ref('');
const pending = ref(false);
const account = ref(null);
const avatarPreview = ref('');
const avatarInput = ref(null);
const today = new Date().toISOString().slice(0, 10);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const passwordHint = computed(() => `${[...form.password].length}/8 minimum characters`);

const messages = {
	REQUIRED: 'This field is required.',
	INVALID_EMAIL: 'Enter a valid email address.',
	INVALID_PASSWORD: 'Use at least 8 characters and no more than 72 bytes.',
	INVALID_DATE: 'Enter a real date that is not in the future.',
	TOO_LONG: 'This entry is too long.',
	INVALID_TEXT: 'Remove unsupported characters.',
	EMAIL_TAKEN: 'That email already belongs to an account. Try signing in instead.',
	INVALID_AVATAR: 'Choose a valid JPEG, PNG or GIF image.',
	PAYLOAD_TOO_LARGE: 'That image is too large. Choose one under 5 MiB.',
};
const serverNames = {
	email: 'email',
	password: 'password',
	first_name: 'firstName',
	last_name: 'lastName',
	date_of_birth: 'dateOfBirth',
	nickname: 'nickname',
	about_me: 'aboutMe',
	avatar: 'avatar',
};

function clearErrors() {
	for (const field of Object.keys(errors)) delete errors[field];
	formError.value = '';
}

function validate() {
	clearErrors();
	for (const field of ['email', 'password', 'firstName', 'lastName', 'dateOfBirth']) {
		if (field === 'password' ? !form[field] : !form[field].trim()) {
			errors[field] = messages.REQUIRED;
		}
	}
	if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(form.email.trim())) {
		errors.email = messages.INVALID_EMAIL;
	}
	const passwordBytes = new TextEncoder().encode(form.password).length;
	if (form.password && ([...form.password].length < 8 || passwordBytes > 72)) {
		errors.password = messages.INVALID_PASSWORD;
	}
	if (form.dateOfBirth) {
		const parsed = new Date(`${form.dateOfBirth}T00:00:00Z`);
		const valid =
			/^\d{4}-\d{2}-\d{2}$/u.test(form.dateOfBirth) &&
			!Number.isNaN(parsed.valueOf()) &&
			parsed.toISOString().slice(0, 10) === form.dateOfBirth &&
			form.dateOfBirth >= '0001-01-01' &&
			form.dateOfBirth <= today;
		if (!valid) errors.dateOfBirth = messages.INVALID_DATE;
	}
	return Object.keys(errors).length === 0;
}

function focusFirstError() {
	const first = Object.keys(errors)[0];
	document.querySelector(`[name="${first}"]`)?.focus();
}

function revokePreview() {
	if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
	avatarPreview.value = '';
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function removeAvatar() {
	revokePreview();
	form.avatar = null;
	delete errors.avatar;
	if (avatarInput.value) avatarInput.value.value = '';
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function chooseAvatar(event) {
	const [file] = event.target.files;
	if (!file) return;
	delete errors.avatar;
	if (!avatarTypes.has(file.type) || file.size > 5 * 1024 * 1024) {
		errors.avatar =
			file.size > 5 * 1024 * 1024 ? messages.PAYLOAD_TOO_LARGE : messages.INVALID_AVATAR;
		event.target.value = '';
		return;
	}
	revokePreview();
	form.avatar = file;
	avatarPreview.value = URL.createObjectURL(file);
}

function applyServerError(error) {
	for (const [name, code] of Object.entries(error.fields)) {
		const field = serverNames[name];
		if (field) errors[field] = messages[code] || 'Check this field and try again.';
	}
	if (
		messages[error.code] &&
		['EMAIL_TAKEN', 'INVALID_AVATAR', 'PAYLOAD_TOO_LARGE'].includes(error.code)
	) {
		errors[error.code === 'EMAIL_TAKEN' ? 'email' : 'avatar'] = messages[error.code];
	}
	formError.value = error.message;
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function submit() {
	if (pending.value || !validate()) {
		focusFirstError();
		return;
	}
	pending.value = true;
	try {
		account.value = await registerAccount(form);
	} catch (error) {
		applyServerError(
			error instanceof RegistrationError
				? error
				: new RegistrationError({
						code: 'SERVICE_UNAVAILABLE',
						message: 'Something interrupted registration. Your details are still here.',
					}),
		);
		focusFirstError();
	} finally {
		pending.value = false;
	}
}

onBeforeUnmount(revokePreview);
</script>

<template>
	<section class="registration-view" data-screen="register">
		<aside class="registration-view__story">
			<div>
				<p class="eyebrow">Make your place</p>
				<h1>Bring your whole self. Share only what feels right.</h1>
				<p>Start with the essentials, then add as much—or as little—personality as you like.</p>
			</div>
			<ol class="registration-path" aria-label="Account creation steps">
				<li class="registration-path__active"><span>01</span> Essentials</li>
				<li><span>02</span> Your details</li>
				<li><span>03</span> Enter the circle</li>
			</ol>
			<RouterLink class="text-link text-link--light" to="/login">
				Already belong? Sign in <span aria-hidden="true">↗</span>
			</RouterLink>
		</aside>

		<div class="registration-view__form-wrap">
			<div v-if="account" class="registration-success" role="status">
				<p class="eyebrow">You’re in</p>
				<h2>Welcome, {{ account.display_name }}.</h2>
				<p>Your account is ready. Your corner of Commonplace is waiting.</p>
				<RouterLink class="button button--primary" to="/">Continue home</RouterLink>
			</div>

			<form v-else class="registration-form" novalidate @submit.prevent="submit">
				<header class="registration-form__header">
					<div>
						<p class="access-view__step">Create an account</p>
						<h2>Start with the essentials.</h2>
					</div>
					<p><span aria-hidden="true">*</span> Required</p>
				</header>

				<div v-if="formError" class="form-alert" role="alert">
					<strong>We couldn’t finish that.</strong><span>{{ formError }}</span>
				</div>

				<fieldset>
					<legend>Account details</legend>
					<div class="form-grid">
						<div v-for="field in [
							{ name: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
							{ name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password' },
							{ name: 'firstName', label: 'First name', autocomplete: 'given-name' },
							{ name: 'lastName', label: 'Last name', autocomplete: 'family-name' },
						]" :key="field.name" class="form-field" :class="{ 'form-field--error': errors[field.name] }">
							<label :for="`register-${field.name}`">{{ field.label }} <span aria-hidden="true">*</span></label>
							<input :id="`register-${field.name}`" v-model="form[field.name]" :name="field.name" :type="field.type || 'text'" :autocomplete="field.autocomplete" :aria-describedby="errors[field.name] ? `${field.name}-error` : undefined" :aria-invalid="Boolean(errors[field.name])" />
							<p v-if="field.name === 'password'" class="field-hint">{{ passwordHint }} · Never saved in this browser</p>
							<p v-if="errors[field.name]" :id="`${field.name}-error`" class="field-error">{{ errors[field.name] }}</p>
						</div>
						<div class="form-field form-field--wide" :class="{ 'form-field--error': errors.dateOfBirth }">
							<label for="register-date">Date of birth <span aria-hidden="true">*</span></label>
							<input id="register-date" v-model="form.dateOfBirth" name="dateOfBirth" type="date" autocomplete="bday" min="0001-01-01" :max="today" :aria-describedby="errors.dateOfBirth ? 'dateOfBirth-error' : undefined" :aria-invalid="Boolean(errors.dateOfBirth)" />
							<p v-if="errors.dateOfBirth" id="dateOfBirth-error" class="field-error">{{ errors.dateOfBirth }}</p>
						</div>
					</div>
				</fieldset>

				<fieldset class="optional-fields">
					<legend>Your profile <span>Optional</span></legend>
					<p class="fieldset-copy">Add some personality now, or leave every field blank.</p>
					<div class="avatar-field" :class="{ 'form-field--error': errors.avatar }">
						<div class="avatar-preview" aria-hidden="true">
							<img v-if="avatarPreview" :src="avatarPreview" alt="" />
							<span v-else>+</span>
						</div>
						<div>
							<label class="file-button" for="register-avatar">{{ form.avatar ? 'Choose another image' : 'Choose an avatar' }}</label>
							<input id="register-avatar" ref="avatarInput" class="visually-hidden" name="avatar" type="file" accept="image/jpeg,image/png,image/gif" :aria-invalid="Boolean(errors.avatar)" @change="chooseAvatar" />
							<p class="field-hint">JPEG, PNG or GIF · up to 5 MiB</p>
							<button v-if="form.avatar" class="text-button" type="button" @click="removeAvatar">Remove selected image</button>
							<p v-if="errors.avatar" class="field-error">{{ errors.avatar }}</p>
						</div>
					</div>
					<div class="form-grid">
						<div class="form-field">
							<label for="register-nickname">Nickname</label>
							<input id="register-nickname" v-model="form.nickname" name="nickname" maxlength="30" />
							<p class="field-hint">A familiar name, up to 30 characters</p>
						</div>
						<div class="form-field">
							<label for="register-about">About me</label>
							<textarea id="register-about" v-model="form.aboutMe" name="aboutMe" rows="4" maxlength="1000"></textarea>
							<p class="field-hint">Plain text, up to 1,000 characters</p>
						</div>
					</div>
				</fieldset>

				<div class="registration-form__actions">
					<p>By joining, you’re making room for genuine connection.</p>
					<button class="button button--primary" type="submit" :disabled="pending" :aria-busy="pending">
						{{ pending ? 'Creating your place…' : 'Create my account' }}
					</button>
				</div>
			</form>
		</div>
	</section>
</template>
