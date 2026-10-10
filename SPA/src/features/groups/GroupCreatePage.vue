<script setup>
import { computed, inject, nextTick, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { GROUP_DESCRIPTION_MAX, GROUP_TITLE_MAX } from '../../api/groups.js';
import { sessionKey } from '../auth/session-state.js';
import { codePoints, normalizeText } from '../content/content-utils.js';
import { groupsKey } from './group-state.js';
import { groupFieldMessage, groupFieldProblem } from './group-utils.js';

const session = inject(sessionKey);
const groups = inject(groupsKey);
const router = useRouter();

const fields = reactive({ title: '', description: '' });
const errors = reactive({ title: '', description: '' });
const formMessage = ref('');
const uncertain = ref(false);
const summary = ref(null);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const pending = computed(() => groups.isPending('create'));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const titleCount = computed(() => codePoints(fields.title));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const descriptionCount = computed(() => codePoints(fields.description));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const limits = { title: GROUP_TITLE_MAX, description: GROUP_DESCRIPTION_MAX };

// A different account must never inherit an unsent group draft.
watch(
	() => session.state.account?.id ?? null,
	() => {
		fields.title = fields.description = '';
		errors.title = errors.description = '';
		formMessage.value = '';
		uncertain.value = false;
	},
);

function validate() {
	errors.title = groupFieldMessage('title', groupFieldProblem('title', fields.title));
	errors.description = groupFieldMessage(
		'description',
		groupFieldProblem('description', fields.description),
	);
	return !errors.title && !errors.description;
}

async function focusFirstProblem() {
	await nextTick();
	if (errors.title) document.getElementById('group-title')?.focus();
	else if (errors.description) document.getElementById('group-description')?.focus();
	else summary.value?.focus();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function submit() {
	if (groups.isPending('create')) return;
	formMessage.value = '';
	uncertain.value = false;
	if (!validate()) {
		await focusFirstProblem();
		return;
	}
	const accountId = session.state.account?.id;
	const outcome = await groups.createGroup({
		title: normalizeText(fields.title),
		description: normalizeText(fields.description),
	});
	if (accountId !== session.state.account?.id) return;
	if (outcome.status === 'ok') {
		groups.setFlash('group', `${outcome.group.title} is ready. Invite the people who belong here.`);
		await router.push({ name: 'group', params: { id: outcome.group.id } });
		return;
	}
	if (['superseded', 'unauthenticated', 'busy'].includes(outcome.status)) return;
	if (outcome.status === 'rejected' && outcome.code === 'VALIDATION_ERROR') {
		errors.title = groupFieldMessage('title', outcome.fields?.title);
		errors.description = groupFieldMessage('description', outcome.fields?.description);
	} else if (outcome.status === 'unavailable') {
		// Creation is not idempotent: never resend. The viewer checks their
		// own groups, where a committed creation already appears.
		uncertain.value = true;
		formMessage.value =
			'We couldn’t confirm whether the group was created, so nothing was resent. Check Your groups before trying again.';
	} else {
		formMessage.value = 'That group couldn’t be created. Check the details and try again.';
	}
	await focusFirstProblem();
}
</script>

<template>
	<section class="social-view group-create-view" data-screen="group-new">
		<header class="social-view__head">
			<p class="eyebrow">New group</p>
			<h1>Start a <em>group.</em></h1>
			<p class="social-view__lede">Everyone can find the name and description. Members, invitations and posts stay inside the group. You’ll be its creator and first member.</p>
		</header>

		<form class="group-form" novalidate @submit.prevent="submit">
			<div ref="summary" tabindex="-1" class="group-form__summary" aria-live="polite">
				<p v-if="formMessage" class="field-error" role="alert">{{ formMessage }}</p>
				<RouterLink v-if="uncertain" class="text-link" :to="{ name: 'groups', query: { membership: 'member' } }">Check Your groups <span aria-hidden="true">↗</span></RouterLink>
			</div>

			<div class="group-form__field">
				<label for="group-title">Name</label>
				<input id="group-title" v-model="fields.title" name="title" type="text" autocomplete="off" :aria-invalid="Boolean(errors.title)" :aria-describedby="errors.title ? 'group-title-error group-title-count' : 'group-title-count'" />
				<p id="group-title-count" class="group-form__count">{{ titleCount }} / {{ limits.title }}</p>
				<p v-if="errors.title" id="group-title-error" class="field-error">{{ errors.title }}</p>
			</div>

			<div class="group-form__field">
				<label for="group-description">Description</label>
				<textarea id="group-description" v-model="fields.description" name="description" rows="5" :aria-invalid="Boolean(errors.description)" :aria-describedby="errors.description ? 'group-description-error group-description-count' : 'group-description-count'"></textarea>
				<p id="group-description-count" class="group-form__count">{{ descriptionCount }} / {{ limits.description.toLocaleString('en-GB') }}</p>
				<p v-if="errors.description" id="group-description-error" class="field-error">{{ errors.description }}</p>
			</div>

			<div class="group-form__actions">
				<button class="button button--primary" type="submit" :aria-disabled="pending" :aria-busy="pending">{{ pending ? 'Creating…' : 'Create group' }}</button>
				<RouterLink class="button button--secondary" :to="{ name: 'groups' }">Cancel</RouterLink>
			</div>
		</form>
	</section>
</template>
