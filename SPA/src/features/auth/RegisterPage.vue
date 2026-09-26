<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue';

import { RegistrationError, registerAccount } from '../../api/registration.js';
import { fetchCurrentAccount, loginAccount } from '../../api/session.js';

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
// A client-side rejection of the latest avatar choice. Kept apart from
// `errors` so validate() cannot clear it and let the form submit anyway.
const avatarProblem = ref('');
// Registration with an unknown outcome is resolved in the contract's order:
// checking (/users/me) → login-available → signing-in → retry-available.
// `unknown` means recovery itself could not reach the service; it only ever
// restarts at /users/me. `recovered` ends with the returned account.
const recovery = ref('idle');
const recoveredBy = ref('');
const recoveryPanel = ref(null);
// In-memory copy of the credentials whose registration outcome is unknown;
// never persisted or logged, dropped once recovery settles.
let submittedCredentials = null;
const registrationAllowed = computed(() => ['idle', 'retry-available'].includes(recovery.value));
// While recovery is unresolved the email/password on screen must stay the
// submitted ones, because recovery signs in with exactly those.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const credentialsLocked = computed(() => !registrationAllowed.value);
// Evaluated on use so a page left open past UTC midnight accepts the new date.
const todayUtc = () => new Date().toISOString().slice(0, 10);
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

function isValidDate(value) {
	const parsed = new Date(`${value}T00:00:00Z`);
	return (
		/^\d{4}-\d{2}-\d{2}$/u.test(value) &&
		!Number.isNaN(parsed.valueOf()) &&
		parsed.toISOString().slice(0, 10) === value &&
		value >= '0001-01-01' &&
		value <= todayUtc()
	);
}

// The contract counts Unicode code points after trimming, which the HTML
// maxlength (UTF-16 units, untrimmed) cannot express.
function validateOptionalLengths() {
	for (const [field, limit] of [
		['nickname', 30],
		['aboutMe', 1000],
	]) {
		if ([...form[field].trim()].length > limit) errors[field] = messages.TOO_LONG;
	}
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
	if (form.dateOfBirth && !isValidDate(form.dateOfBirth)) {
		errors.dateOfBirth = messages.INVALID_DATE;
	}
	validateOptionalLengths();
	if (avatarProblem.value) errors.avatar = avatarProblem.value;
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
	avatarProblem.value = '';
	delete errors.avatar;
	if (avatarInput.value) avatarInput.value.value = '';
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function chooseAvatar(event) {
	const [file] = event.target.files;
	if (!file) return;
	// Any new choice replaces the previous one, valid or not, so an earlier
	// file can never be uploaded after a rejected replacement.
	revokePreview();
	form.avatar = null;
	delete errors.avatar;
	avatarProblem.value = '';
	if (!avatarTypes.has(file.type) || file.size > 5 * 1024 * 1024) {
		avatarProblem.value =
			file.size > 5 * 1024 * 1024 ? messages.PAYLOAD_TOO_LARGE : messages.INVALID_AVATAR;
		errors.avatar = avatarProblem.value;
		event.target.value = '';
		return;
	}
	form.avatar = file;
	avatarPreview.value = URL.createObjectURL(file);
}

function applyServerError(error) {
	for (const [name, code] of Object.entries(error.fields)) {
		const field = serverNames[name];
		if (field) errors[field] = messages[code] || 'Check this field and try again.';
	}
	if (error.code === 'EMAIL_TAKEN') errors.email = messages.EMAIL_TAKEN;
	// Without an image the size/format codes describe the request, not the
	// avatar control, so they stay in the form-level alert only.
	if (form.avatar && ['INVALID_AVATAR', 'PAYLOAD_TOO_LARGE'].includes(error.code)) {
		errors.avatar = messages[error.code];
	}
	formError.value = error.message;
	// A server-rejected image must not ride along on the next attempt: drop it
	// and hold the error until the user clears it or picks another image.
	if (errors.avatar && form.avatar) {
		revokePreview();
		form.avatar = null;
		avatarProblem.value = errors.avatar;
		if (avatarInput.value) avatarInput.value.value = '';
	}
}

// Every network action shares one pending flag, so no click can start a
// second register, /users/me or login request while another is in flight.
async function runExclusive(task) {
	if (pending.value) return;
	pending.value = true;
	try {
		await task();
	} finally {
		pending.value = false;
	}
}

async function focusRecoveryPanel() {
	await nextTick();
	recoveryPanel.value?.focus();
}

function recover(recoveredAccount, source) {
	submittedCredentials = null;
	form.password = '';
	recoveredBy.value = source;
	recovery.value = 'recovered';
	account.value = recoveredAccount;
}

async function confirmRegistration() {
	recovery.value = 'checking';
	const result = await fetchCurrentAccount();
	if (result.status === 'authenticated') {
		recover(result.account, 'session');
		return;
	}
	recovery.value = result.status === 'unauthenticated' ? 'login-available' : 'unknown';
	focusRecoveryPanel();
}

async function register() {
	recovery.value = 'idle';
	submittedCredentials = null;
	try {
		account.value = await registerAccount(form);
		form.password = '';
	} catch (error) {
		if (error instanceof RegistrationError && error.ambiguous) {
			submittedCredentials = { email: form.email, password: form.password };
			await confirmRegistration();
			return;
		}
		applyServerError(
			error instanceof RegistrationError
				? error
				: new RegistrationError({
						code: 'SERVICE_UNAVAILABLE',
						message: 'Something interrupted registration. Your details are still here.',
					}),
		);
		focusFirstError();
	}
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function submit() {
	if (pending.value) return;
	if (!registrationAllowed.value) {
		focusRecoveryPanel();
		return;
	}
	if (!validate()) {
		focusFirstError();
		return;
	}
	await runExclusive(register);
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function checkAgain() {
	return runExclusive(async () => {
		if (recovery.value === 'unknown') await confirmRegistration();
	});
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function signInWithSubmittedDetails() {
	return runExclusive(async () => {
		if (recovery.value !== 'login-available') return;
		recovery.value = 'signing-in';
		const result = await loginAccount(submittedCredentials);
		if (result.status === 'authenticated') {
			recover(result.account, 'login');
			return;
		}
		if (result.status === 'invalid-credentials') {
			submittedCredentials = null;
			recovery.value = 'retry-available';
		} else {
			recovery.value = 'unknown';
		}
		focusRecoveryPanel();
	});
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const submitLabel = computed(() => {
	if (pending.value && registrationAllowed.value) return 'Creating your place…';
	return recovery.value === 'retry-available' ? 'Retry creating my account' : 'Create my account';
});

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
			<div v-if="account" class="registration-success" role="status" :data-recovered-by="recoveredBy || undefined">
				<p class="eyebrow">{{ recoveredBy ? 'Account confirmed' : 'You’re in' }}</p>
				<h2>Welcome, {{ account.display_name }}.</h2>
				<p v-if="recoveredBy === 'session'">The connection dropped, but your account was created and you’re signed in. Nothing else to do.</p>
				<p v-else-if="recoveredBy === 'login'">We found the account you just created and signed you in with those details.</p>
				<p v-else>Your account is ready. Your corner of Commonplace is waiting.</p>
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

				<div v-if="recovery !== 'idle'" ref="recoveryPanel" class="form-alert recovery-panel" role="status" tabindex="-1" :data-recovery-state="recovery" :aria-busy="recovery === 'checking' || recovery === 'signing-in'">
					<template v-if="recovery === 'checking'">
						<strong>Checking whether your account was created…</strong>
						<span>The connection dropped before we heard back. We’re asking the service before doing anything else.</span>
					</template>
					<template v-else-if="recovery === 'login-available'">
						<strong>We couldn’t confirm your account yet.</strong>
						<span>It may have been created before the connection dropped. Sign in as {{ form.email.trim() }} with the password you entered to find out. Your email and password are locked and creating another account is paused until then.</span>
						<button class="button button--primary recovery-panel__action" type="button" :disabled="pending" @click="signInWithSubmittedDetails">Sign in with these details</button>
					</template>
					<template v-else-if="recovery === 'signing-in'">
						<strong>Signing in with the details you entered…</strong>
						<span>If your account exists, you’ll be taken straight in.</span>
					</template>
					<template v-else-if="recovery === 'unknown'">
						<strong>We still can’t tell whether your account exists.</strong>
						<span>The service isn’t answering right now. Your details are still here, with email and password locked until we know; check again once the connection returns.</span>
						<button class="button button--primary recovery-panel__action" type="button" :disabled="pending" @click="checkAgain">Check again</button>
					</template>
					<template v-else-if="recovery === 'retry-available'">
						<strong>Your account wasn’t created.</strong>
						<span>Those details didn’t sign in, so it’s safe to try creating the account again. You can edit any field first.</span>
					</template>
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
							<input :id="`register-${field.name}`" v-model="form[field.name]" :name="field.name" :type="field.type || 'text'" :autocomplete="field.autocomplete" :aria-describedby="errors[field.name] ? `${field.name}-error` : undefined" :aria-invalid="Boolean(errors[field.name])" :readonly="credentialsLocked && ['email', 'password'].includes(field.name)" />
							<p v-if="field.name === 'password'" class="field-hint">{{ passwordHint }} · Never saved in this browser</p>
							<p v-if="errors[field.name]" :id="`${field.name}-error`" class="field-error">{{ errors[field.name] }}</p>
						</div>
						<div class="form-field form-field--wide" :class="{ 'form-field--error': errors.dateOfBirth }">
							<label for="register-date">Date of birth <span aria-hidden="true">*</span></label>
							<input id="register-date" v-model="form.dateOfBirth" name="dateOfBirth" type="date" autocomplete="bday" min="0001-01-01" :max="todayUtc()" :aria-describedby="errors.dateOfBirth ? 'dateOfBirth-error' : undefined" :aria-invalid="Boolean(errors.dateOfBirth)" />
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
							<input id="register-avatar" ref="avatarInput" class="visually-hidden file-input" name="avatar" type="file" accept="image/jpeg,image/png,image/gif" :aria-describedby="errors.avatar ? 'avatar-hint avatar-error' : 'avatar-hint'" :aria-invalid="Boolean(errors.avatar)" @change="chooseAvatar" />
							<label class="file-button" for="register-avatar">{{ form.avatar ? 'Choose another image' : 'Choose an avatar' }}</label>
							<p id="avatar-hint" class="field-hint">JPEG, PNG or GIF · up to 5 MiB</p>
							<button v-if="form.avatar || avatarProblem" class="text-button" type="button" @click="removeAvatar">{{ form.avatar ? 'Remove selected image' : 'Clear image selection' }}</button>
							<p v-if="errors.avatar" id="avatar-error" class="field-error" role="alert">{{ errors.avatar }}</p>
						</div>
					</div>
					<div class="form-grid">
						<div class="form-field" :class="{ 'form-field--error': errors.nickname }">
							<label for="register-nickname">Nickname</label>
							<input id="register-nickname" v-model="form.nickname" name="nickname" :aria-describedby="errors.nickname ? 'nickname-hint nickname-error' : 'nickname-hint'" :aria-invalid="Boolean(errors.nickname)" />
							<p id="nickname-hint" class="field-hint">A familiar name, up to 30 characters</p>
							<p v-if="errors.nickname" id="nickname-error" class="field-error">{{ errors.nickname }}</p>
						</div>
						<div class="form-field" :class="{ 'form-field--error': errors.aboutMe }">
							<label for="register-about">About me</label>
							<textarea id="register-about" v-model="form.aboutMe" name="aboutMe" rows="4" :aria-describedby="errors.aboutMe ? 'aboutMe-hint aboutMe-error' : 'aboutMe-hint'" :aria-invalid="Boolean(errors.aboutMe)"></textarea>
							<p id="aboutMe-hint" class="field-hint">Plain text, up to 1,000 characters</p>
							<p v-if="errors.aboutMe" id="aboutMe-error" class="field-error">{{ errors.aboutMe }}</p>
						</div>
					</div>
				</fieldset>

				<div class="registration-form__actions">
					<p>By joining, you’re making room for genuine connection.</p>
					<button class="button button--primary" type="submit" :disabled="pending || !registrationAllowed" :aria-busy="pending">
						{{ submitLabel }}
					</button>
				</div>
			</form>
		</div>
	</section>
</template>
