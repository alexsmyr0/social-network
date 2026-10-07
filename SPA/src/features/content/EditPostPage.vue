<script setup>
import { computed, inject, nextTick, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
import { socialKey } from '../social/social-state.js';
import { parseUserId } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { contentKey } from './content-state.js';
// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { AUDIENCE_LABELS, formatPostDate, STATUS_LABELS } from './content-utils.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PostComposer from './PostComposer.vue';
import {
	applyFailure,
	changeFields,
	createPostForm,
	rebaseForm,
	resetForm,
	seedForm,
	validateForm,
} from './post-form.js';
import { useComposerResources } from './use-composer-resources.js';

const session = inject(sessionKey);
const social = inject(socialKey);
const content = inject(contentKey);
const route = useRoute();
const router = useRouter();

const postId = computed(() => parseUserId(route.params.id));
const form = createPostForm();
// `base` is the server snapshot the form's edits apply to, and supplies the
// expected version. `latest` is the newest copy seen since, so a change made
// elsewhere can be pointed out before saving into a conflict.
const base = shallowRef(null);
const latest = shallowRef(null);
const phase = ref('loading');
const notice = ref(content.takeFlash('edit-post'));
const alertKind = ref('');
const alertBox = ref(null);
const confirmingDelete = ref(false);

const resources = useComposerResources({ social, content, session });
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { categories, followers, eligibleIds, visibility } = resources;
const loader = useSocialResource(
	async () => (postId.value ? content.api.fetchPost(postId.value) : { status: 'not-found' }),
	{ social, sources: () => postId.value, retain: true },
);

const accountId = () => session.state.account?.id ?? null;
// Only the author's own copy carries `selected_follower_ids`; anything else
// is someone else's post, which never gains owner controls.
const ownedBy = (post) =>
	post.author_id === accountId() && Array.isArray(post.selected_follower_ids);

function startOver() {
	base.value = null;
	latest.value = null;
	confirmingDelete.value = false;
	alertKind.value = '';
	resetForm(form);
	phase.value = 'loading';
}

watch(postId, startOver);
watch(accountId, () => {
	startOver();
	void loader.reload('hard');
});

watch(
	[loader.status, loader.result],
	([status, result]) => {
		if (status === 'ready') {
			const post = result.post;
			if (post.id !== postId.value) return;
			if (!ownedBy(post)) {
				base.value = null;
				phase.value = 'foreign';
				return;
			}
			latest.value = post;
			if (!base.value) {
				base.value = post;
				seedForm(form, post);
				phase.value = 'ready';
			}
			return;
		}
		if (base.value) {
			if (status === 'not-found') phase.value = 'gone';
			return;
		}
		if (status === 'not-found' || status === 'rejected') phase.value = 'missing';
		else if (status === 'unavailable') phase.value = 'unavailable';
		else phase.value = 'loading';
	},
	{ immediate: true },
);

const status = computed(() => base.value?.status ?? null);
const busy = computed(() => (postId.value ? content.isPending(postId.value) : false));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const changedElsewhere = computed(
	() =>
		phase.value === 'ready' &&
		latest.value &&
		base.value &&
		latest.value.version !== base.value.version,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const heading = computed(() => (status.value === 'draft' ? 'Edit draft' : 'Edit post'));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const statusNote = computed(() => {
	if (status.value === 'draft') return 'Only you can see this draft until you publish it.';
	if (status.value === 'archived') {
		return 'This post is archived. Only you can see it until you publish it again.';
	}
	return 'Changes appear to its audience as soon as you save.';
});

async function showAlert(message, kind = 'error') {
	form.alert = message;
	alertKind.value = kind;
	await nextTick();
	alertBox.value?.focus();
}

function accept(post, message) {
	base.value = post;
	latest.value = post;
	seedForm(form, post);
	alertKind.value = '';
	notice.value = message;
}

// Loads the newest copy. With `keepEdits` the author's unsaved changes are
// rebased onto it (after a conflict); otherwise the form is replaced.
async function refetch({ keepEdits }) {
	const fresh = await content.api.fetchPost(postId.value);
	if (fresh.status === 'unauthenticated') {
		await social.handleUnauthenticated();
		return 'unauthenticated';
	}
	if (fresh.status === 'not-found') {
		phase.value = 'gone';
		return 'gone';
	}
	if (fresh.status !== 'ok') return 'unavailable';
	if (!ownedBy(fresh.post)) {
		base.value = null;
		phase.value = 'foreign';
		return 'foreign';
	}
	if (keepEdits) {
		rebaseForm(form, base.value, fresh.post);
		base.value = fresh.post;
		latest.value = fresh.post;
	} else {
		accept(fresh.post, '');
	}
	return 'ok';
}

async function recoverConflict(action) {
	const outcome = await refetch({ keepEdits: true });
	if (outcome === 'ok') {
		await showAlert(
			`This post changed somewhere else. We loaded the latest version and kept your unsaved edits; people removed from its recipients meanwhile stay removed. Review it, then ${action} again.`,
			'stale',
		);
	} else if (outcome === 'unavailable') {
		await showAlert(
			'This post changed somewhere else, and we couldn’t load the latest version. Try again.',
		);
	}
}

async function handleFailure(result, action) {
	if (['busy', 'superseded', 'unauthenticated'].includes(result.status)) return;
	if (result.status === 'stale' || result.status === 'not-found') {
		// A 404 can also mean the post left the state this action needs (for
		// example a draft published elsewhere); re-read before declaring it gone.
		await recoverConflict(action);
		return;
	}
	if (result.status === 'unavailable') {
		await showAlert(
			'We couldn’t confirm that change, so nothing was retried. Your edits are still here — load the saved version to check what happened, or try again.',
			'unknown',
		);
		return;
	}
	applyFailure(form, result);
	if (form.errors.selected_follower_ids) void followers.value.reload('quiet');
	await showAlert(form.alert);
}

const SUCCESS = {
	save: 'Changes saved.',
	publish: 'Published. It’s now visible to its audience.',
	unpublish: 'Moved to drafts. Only you can see it now.',
	'save-draft': 'Draft saved.',
};

// The fields this action would send, or null when there is nothing valid to
// send (the form already explains why).
async function pendingChanges(action) {
	const publishing = action === 'publish';
	const requireContent = publishing || (action === 'save' && status.value !== 'draft');
	if (!validateForm(form, { publishing, requireContent, eligibleIds: eligibleIds.value })) {
		await showAlert('Some details need attention before saving.');
		return null;
	}
	const changes = changeFields(form, base.value);
	if (action === 'publish') changes.status = 'published';
	if (action === 'unpublish') changes.status = 'draft';
	if (Object.keys(changes).length === 0) {
		form.alert = '';
		notice.value = 'There are no changes to save.';
		return null;
	}
	return { ...changes, expectedVersion: base.value.version };
}

async function saveDraft(id, fields) {
	const result = await content.updateDraft(id, fields);
	if (result.status !== 'ok') {
		await handleFailure(result, 'save');
		return;
	}
	// The draft update returns no body; read it back for the new version.
	const outcome = await refetch({ keepEdits: false });
	if (outcome === 'ok') notice.value = SUCCESS['save-draft'];
	else if (outcome === 'unavailable') {
		await showAlert(
			'Draft saved, but we couldn’t reload it. Load the saved version before editing again.',
			'unknown',
		);
	}
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function submit(action) {
	if (busy.value || phase.value !== 'ready') return;
	notice.value = '';
	confirmingDelete.value = false;
	const fields = await pendingChanges(action);
	if (!fields) return;
	const id = postId.value;
	if (action === 'save-draft') {
		await saveDraft(id, fields);
		return;
	}
	const result = await content.updatePost(id, fields);
	if (result.status === 'ok') accept(result.post, SUCCESS[action]);
	else await handleFailure(result, action === 'publish' ? 'publish' : 'save');
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function loadSaved() {
	const outcome = await refetch({ keepEdits: false });
	if (outcome === 'unavailable')
		await showAlert('We still can’t load this post. Try again shortly.', 'unknown');
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function remove() {
	if (busy.value || phase.value !== 'ready') return;
	const draft = status.value === 'draft';
	const id = postId.value;
	const version = base.value.version;
	const result = draft
		? await content.deleteDraft(id, version)
		: await content.deletePost(id, version);
	confirmingDelete.value = false;
	if (result.status === 'ok') {
		content.setFlash('my-posts', draft ? 'Draft deleted.' : 'Post deleted.');
		await router.push({ name: 'my-posts' });
		return;
	}
	await handleFailure(result, 'delete it');
}
</script>

<template>
	<section class="social-view edit-view" data-screen="edit-post" :aria-busy="phase === 'loading'">
		<p v-if="phase === 'loading'" class="social-status" role="status">Loading post…</p>

		<div v-else-if="phase === 'missing'" class="social-state" data-state="missing">
			<p class="eyebrow">Edit post</p>
			<h1>This post isn’t available to edit.</h1>
			<p>It may have been deleted, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'my-posts' }">Your posts</RouterLink>
		</div>

		<div v-else-if="phase === 'foreign'" class="social-state" data-state="foreign">
			<p class="eyebrow">Edit post</p>
			<h1>You can only edit your own posts.</h1>
			<p>This post belongs to someone else.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'feed' }">Back to the feed</RouterLink>
		</div>

		<div v-else-if="phase === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t load this post right now.</h1>
			<p>Nothing was changed. Your connection or the service may be briefly unavailable.</p>
			<button class="button button--secondary" type="button" @click="loader.reload('hard')">Try again</button>
		</div>

		<template v-else>
			<header class="social-view__head edit-view__head">
				<p class="eyebrow">{{ phase === 'gone' ? 'Edit post' : heading }}</p>
				<h1>{{ phase === 'gone' ? 'This post no longer exists.' : heading }}</h1>
				<p v-if="base" class="edit-view__meta">
					<span class="badge badge--status" :data-status="base.status">{{ STATUS_LABELS[base.status] }}</span>
					<span class="badge badge--audience" :data-audience="base.audience">{{ AUDIENCE_LABELS[base.audience] }}</span>
					<span>Created <time :datetime="base.created_at">{{ formatPostDate(base.created_at) }}</time></span>
				</p>
				<p v-if="phase !== 'gone'" class="social-view__lede">{{ statusNote }}</p>
			</header>

			<div v-if="phase === 'gone'" class="social-state social-state--error" role="alert" data-state="gone">
				<h2>It was deleted somewhere else.</h2>
				<p>Your unsaved text is still shown below so you can copy it. Nothing more can be saved to this post.</p>
				<RouterLink class="button button--secondary" :to="{ name: 'my-posts' }">Your posts</RouterLink>
			</div>

			<p v-if="notice" class="content-flash" role="status">{{ notice }}</p>

			<div v-if="changedElsewhere" class="form-alert recovery-panel" data-changed-elsewhere>
				<span>This post changed somewhere else since you opened it. Saving will ask you to review the newest version first.</span>
				<button class="text-button" type="button" @click="loadSaved">Load the latest version (discards your unsaved edits)</button>
			</div>

			<form class="post-form" novalidate :aria-busy="busy" @submit.prevent="submit(status === 'draft' ? 'save-draft' : 'save')">
				<div
					v-if="form.alert"
					ref="alertBox"
					class="form-alert"
					:class="{ 'recovery-panel': alertKind === 'unknown' || alertKind === 'stale' }"
					:data-recovery-state="alertKind || undefined"
					role="alert"
					tabindex="-1"
				>
					<span>{{ form.alert }}</span>
					<button v-if="alertKind === 'unknown'" class="text-button" type="button" @click="loadSaved">Load the saved version</button>
				</div>

				<fieldset class="post-form__fields" :disabled="phase === 'gone'">
					<legend class="visually-hidden">Post content</legend>
					<PostComposer
						:form="form"
						:categories="categories"
						:followers="followers"
						:eligible-ids="eligibleIds"
						:visibility="visibility"
						:disabled="busy || phase === 'gone'"
						id-prefix="edit"
					/>
				</fieldset>

				<div v-if="phase === 'ready'" class="post-form__actions">
					<template v-if="status === 'draft'">
						<button class="button button--primary" type="button" :aria-disabled="busy" @click="submit('publish')">Publish</button>
						<button class="button button--secondary" type="submit" :aria-disabled="busy">Save draft</button>
					</template>
					<template v-else-if="status === 'archived'">
						<button class="button button--primary" type="submit" :aria-disabled="busy">Save changes</button>
						<button class="button button--secondary" type="button" :aria-disabled="busy" @click="submit('publish')">Publish again</button>
						<button class="button button--secondary" type="button" :aria-disabled="busy" @click="submit('unpublish')">Move to drafts</button>
					</template>
					<template v-else>
						<button class="button button--primary" type="submit" :aria-disabled="busy">Save changes</button>
						<button class="button button--secondary" type="button" :aria-disabled="busy" @click="submit('unpublish')">Move to drafts</button>
					</template>
					<button class="text-button post-form__danger" type="button" :aria-disabled="busy" :aria-expanded="confirmingDelete" aria-controls="delete-confirm" @click="confirmingDelete = !confirmingDelete">
						{{ status === 'draft' ? 'Delete draft' : 'Delete post' }}
					</button>
					<p v-if="busy" class="post-form__busy" role="status">Working…</p>
				</div>

				<div v-if="phase === 'ready' && confirmingDelete" id="delete-confirm" class="delete-confirm" role="group" aria-labelledby="delete-confirm-title">
					<h2 id="delete-confirm-title">{{ status === 'draft' ? 'Delete this draft?' : 'Delete this post?' }}</h2>
					<p>This can’t be undone. Its comments, reactions and image are removed too.</p>
					<p class="delete-confirm__actions">
						<button class="button button--primary" type="button" :aria-disabled="busy" @click="remove">Delete permanently</button>
						<button class="button button--secondary" type="button" @click="confirmingDelete = false">Keep it</button>
					</p>
				</div>
			</form>
		</template>
	</section>
</template>
