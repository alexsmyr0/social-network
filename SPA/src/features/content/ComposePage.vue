<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
import { socialKey } from '../social/social-state.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { contentKey } from './content-state.js';
// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { formatPostDate } from './content-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PostComposer from './PostComposer.vue';
import {
	applyFailure,
	createFields,
	createPostForm,
	resetForm,
	validateForm,
} from './post-form.js';
import { useComposerResources } from './use-composer-resources.js';

const session = inject(sessionKey);
const social = inject(socialKey);
const content = inject(contentKey);
const router = useRouter();

const form = createPostForm();
const alertBox = ref(null);
// "unknown" marks a create whose response was lost: it may have been saved.
const alertKind = ref('');
const resources = useComposerResources({ social, content, session });
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { categories, followers, eligibleIds, visibility } = resources;
const latestDraft = useSocialResource(() => content.api.fetchLatestDraft(), { social });
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const draft = computed(() => latestDraft.result.value?.draft ?? null);
const busy = computed(() => content.isPending('new'));

// Another account must never inherit this author's unsent text.
watch(
	() => session.state.account?.id ?? null,
	() => {
		resetForm(form);
		alertKind.value = '';
	},
);

async function showAlert(message, kind = 'error') {
	form.alert = message;
	alertKind.value = kind;
	await nextTick();
	alertBox.value?.focus();
}

async function handle(result, onSuccess) {
	if (['busy', 'superseded', 'unauthenticated'].includes(result.status)) return;
	if (result.status === 'ok') {
		await onSuccess(result);
		return;
	}
	if (result.status === 'unavailable') {
		await showAlert(
			'We couldn’t confirm whether this was saved, so nothing was retried. Check your posts and drafts before trying again.',
			'unknown',
		);
		return;
	}
	if (result.status === 'not-found') {
		await showAlert('Something in this post is no longer available. Review it and try again.');
		return;
	}
	applyFailure(form, result);
	if (form.errors.selected_follower_ids) void followers.value.reload('quiet');
	await showAlert(form.alert);
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function publish() {
	if (busy.value) return;
	if (!validateForm(form, { publishing: true, eligibleIds: eligibleIds.value })) {
		await showAlert('Some details need attention before publishing.');
		return;
	}
	const result = await content.createPost(createFields(form));
	await handle(result, async () => {
		resetForm(form);
		content.setFlash('feed', 'Your post is published.');
		await router.push({ name: 'feed' });
	});
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function saveDraft() {
	if (busy.value) return;
	if (!validateForm(form, { publishing: false, eligibleIds: eligibleIds.value })) {
		await showAlert('Some details need attention before saving.');
		return;
	}
	const result = await content.createDraft(createFields(form));
	await handle(result, async ({ draft: saved }) => {
		resetForm(form);
		content.setFlash('edit-post', 'Draft saved. Keep editing, or publish when it’s ready.');
		await router.replace({ name: 'edit-post', params: { id: saved.id } });
	});
}
</script>

<template>
	<section class="social-view compose-view" data-screen="compose">
		<header class="social-view__head">
			<p class="eyebrow">New post</p>
			<h1>Share something <em>worth keeping.</em></h1>
			<p class="social-view__lede">Add text, an image or both. Posts are Public unless you choose a smaller audience.</p>
		</header>

		<aside v-if="draft" class="draft-banner" data-latest-draft>
			<p>
				You have a saved draft{{ draft.title ? ` “${draft.title}”` : '' }}, last changed
				<time :datetime="draft.updated_at">{{ formatPostDate(draft.updated_at) }}</time>.
			</p>
			<p class="draft-banner__actions">
				<RouterLink class="button button--secondary" :to="{ name: 'edit-post', params: { id: draft.id } }">Continue that draft</RouterLink>
				<RouterLink class="text-link" :to="{ name: 'my-posts', query: { status: 'draft' } }">All drafts</RouterLink>
			</p>
		</aside>

		<form class="post-form" novalidate :aria-busy="busy" @submit.prevent="publish">
			<div
				v-if="form.alert"
				ref="alertBox"
				class="form-alert"
				:class="{ 'recovery-panel': alertKind === 'unknown' }"
				:data-recovery-state="alertKind === 'unknown' ? 'unknown' : undefined"
				role="alert"
				tabindex="-1"
			>
				<span>{{ form.alert }}</span>
				<RouterLink v-if="alertKind === 'unknown'" class="text-link" :to="{ name: 'my-posts' }">Check your posts</RouterLink>
			</div>

			<PostComposer
				:form="form"
				:categories="categories"
				:followers="followers"
				:eligible-ids="eligibleIds"
				:visibility="visibility"
				:disabled="busy"
				id-prefix="compose"
			/>

			<div class="post-form__actions">
				<button class="button button--primary" type="submit" :aria-disabled="busy">
					{{ busy ? 'Working…' : 'Publish' }}
				</button>
				<button class="button button--secondary" type="button" :aria-disabled="busy" @click="saveDraft">Save as draft</button>
				<RouterLink class="text-link" :to="{ name: 'feed' }">Cancel</RouterLink>
			</div>
		</form>
	</section>
</template>
