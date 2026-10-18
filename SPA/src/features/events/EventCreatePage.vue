<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { EVENT_DESCRIPTION_MAX, EVENT_TITLE_MAX } from '../../api/events.js';
import { sessionKey } from '../auth/session-state.js';
import { codePoints, normalizeText } from '../content/content-utils.js';
import { groupsKey } from '../groups/group-state.js';
import { useGroup } from '../groups/use-group.js';
import { eventsKey } from './event-state.js';
import { eventFieldMessage, eventFieldProblem, startsAtProblem } from './event-utils.js';

const session = inject(sessionKey);
const groups = inject(groupsKey);
const events = inject(eventsKey);
const router = useRouter();
const route = useRoute();
let navigation = 0;
watch(
	() => route.fullPath,
	() => {
		navigation += 1;
	},
	{ flush: 'sync' },
);
onUnmounted(() => {
	navigation += 1;
});

// The form is open only for a viewer the server has confirmed as a current
// member. A re-read (signal, reconnect, focus) must not wipe what the member is
// writing, so the last confirmed membership stays while a refetch runs or
// briefly fails; the form closes the moment a response says they are no longer
// a member (the server also refuses the write). A group or account change
// starts over.
const { status, reload, group, groupId, viewerId, isMember } = useGroup({ retain: true });
const confirmed = ref(null);

watch([groupId, viewerId], () => {
	confirmed.value = null;
});
watch(
	[status, group, isMember],
	() => {
		if (status.value === 'ready')
			confirmed.value = group.value && isMember.value ? group.value : null;
		else if (status.value === 'not-found' || status.value === 'rejected') confirmed.value = null;
	},
	{ immediate: true },
);

const view = computed(() => {
	if (confirmed.value) return 'form';
	if (status.value === 'loading') return 'checking';
	if (status.value === 'unavailable') return 'unavailable';
	if (status.value === 'ready') return 'restricted';
	return 'missing';
});
const offline = computed(() => confirmed.value && status.value === 'unavailable');

const fields = reactive({ title: '', description: '', startsAt: '' });
const errors = reactive({ title: '', description: '', startsAt: '' });
const formMessage = ref('');
const uncertain = computed(() => Boolean(events.state.uncertainCreates[groupId.value]));
const summary = ref(null);
const pending = computed(() =>
	groupId.value ? events.isPending(`create-${groupId.value}`) : false,
);
const titleCount = computed(() => codePoints(fields.title));
const descriptionCount = computed(() => codePoints(fields.description));
const limits = { title: EVENT_TITLE_MAX, description: EVENT_DESCRIPTION_MAX };
const zone = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
	} catch {
		return '';
	}
})();

function clearDraft() {
	fields.title = fields.description = fields.startsAt = '';
	errors.title = errors.description = errors.startsAt = '';
	formMessage.value = '';
}

// Confirmed removal (including a new membership generation) discards the
// draft. Loading and transient outages preserve a current member's work.
watch(
	() => confirmed.value?.viewer.membership_id ?? null,
	(current, previous) => {
		if (previous !== null && current !== previous) clearDraft();
	},
);

// A different account, or a different group, never inherits an unsent draft.
watch([() => session.state.account?.id ?? null, groupId], clearDraft);

function validate() {
	errors.title = eventFieldMessage('title', eventFieldProblem('title', fields.title));
	errors.description = eventFieldMessage(
		'description',
		eventFieldProblem('description', fields.description),
	);
	const time = startsAtProblem(fields.startsAt);
	errors.startsAt = eventFieldMessage('starts_at', time.problem);
	return { ok: !errors.title && !errors.description && !errors.startsAt, instant: time.instant };
}

async function focusFirstProblem() {
	await nextTick();
	if (errors.title) document.getElementById('event-title')?.focus();
	else if (errors.description) document.getElementById('event-description')?.focus();
	else if (errors.startsAt) document.getElementById('event-starts-at')?.focus();
	else summary.value?.focus();
}

// Every other current member gets a notice; a sole member notifies nobody.
function scheduledMessage(event, group) {
	const others = (group.member_count ?? 0) > 1;
	return `${event.title} is scheduled.${others ? ' Other members have been notified.' : ''}`;
}

async function submit() {
	if (!confirmed.value || pending.value || uncertain.value) return;
	formMessage.value = '';
	const checked = validate();
	if (!checked.ok) {
		await focusFirstProblem();
		return;
	}
	const startedAt = navigation;
	const accountId = session.state.account?.id;
	const target = confirmed.value;
	const outcome = await events.create(target.id, {
		membershipId: target.viewer.membership_id,
		title: normalizeText(fields.title),
		description: normalizeText(fields.description),
		startsAt: checked.instant,
	});
	if (
		startedAt !== navigation ||
		accountId !== session.state.account?.id ||
		confirmed.value?.viewer.membership_id !== target.viewer.membership_id
	)
		return;
	if (outcome.status === 'ok') {
		groups.setFlash('event', scheduledMessage(outcome.event, target));
		await router.push({
			name: 'group-event',
			params: { id: outcome.event.group_id, eventId: outcome.event.id },
		});
		return;
	}
	if (['superseded', 'unauthenticated', 'busy'].includes(outcome.status)) return;
	if (outcome.status === 'rejected' && outcome.code === 'VALIDATION_ERROR') {
		errors.title = eventFieldMessage('title', outcome.fields?.title);
		errors.description = eventFieldMessage('description', outcome.fields?.description);
		errors.startsAt = eventFieldMessage('starts_at', outcome.fields?.starts_at);
		if (!errors.title && !errors.description && !errors.startsAt)
			formMessage.value = 'That event couldn’t be created. Check the details and try again.';
	} else if (outcome.status === 'unavailable') {
		// Creation is not idempotent: never resend. The member checks the event
		// list, where a committed event already appears.
		formMessage.value =
			'We couldn’t confirm whether the event was created, so nothing was resent. Check the event list before trying again, or you may schedule it twice.';
	} else {
		formMessage.value = outcome.message || 'That event couldn’t be created.';
	}
	await focusFirstProblem();
}
</script>

<template>
	<section v-if="view === 'checking'" class="social-view event-create-view" data-screen="event-new" aria-busy="true">
		<p class="social-status" role="status">Checking your membership…</p>
	</section>

	<section v-else-if="view === 'unavailable'" class="social-view event-create-view" data-screen="event-new">
		<div class="social-state social-state--error" role="alert">
			<h1>We can’t confirm your membership right now.</h1>
			<p>Nothing was scheduled, and the form stays closed until we can confirm you belong to this group.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
	</section>

	<section v-else-if="view === 'missing'" class="social-view event-create-view" data-screen="event-new">
		<div class="social-state" data-state="missing">
			<p class="eyebrow">New event</p>
			<h1>This group isn’t available.</h1>
			<p>It may not exist, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'groups' }">Browse groups</RouterLink>
		</div>
	</section>

	<section v-else-if="view === 'restricted'" class="social-view event-create-view" data-screen="event-new">
		<div class="social-state" role="status" data-state="restricted">
			<p class="eyebrow">New event{{ group ? ` · ${group.title}` : '' }}</p>
			<h1>Only members can schedule events.</h1>
			<p>Join {{ group?.title }} first. Nothing you write is sent to a group you don’t belong to, and nothing was scheduled if you were removed while writing.</p>
			<RouterLink v-if="group" class="button button--secondary" :to="{ name: 'group', params: { id: group.id } }">About this group</RouterLink>
		</div>
	</section>

	<section v-else class="social-view event-create-view" data-screen="event-new">
		<p v-if="offline" class="form-alert" role="status" data-state="offline">
			We can’t re-check your membership right now. Anything you schedule is still checked by the group, and nothing is retried automatically.
		</p>
		<header class="social-view__head">
			<p class="eyebrow">New event · {{ confirmed.title }}</p>
			<h1>Schedule an <em>event.</em></h1>
			<p class="social-view__lede">Every other member of {{ confirmed.title }} is notified. Members answer Going or Not going. Events can’t be edited or cancelled afterwards.</p>
		</header>

		<form class="group-form event-form" novalidate @submit.prevent="submit">
			<div ref="summary" tabindex="-1" class="group-form__summary" aria-live="polite">
				<p v-if="formMessage || uncertain" class="field-error" role="alert">{{ formMessage || "Check the event list before scheduling again. The previous event may already have been created." }}</p>
				<RouterLink v-if="uncertain" class="text-link" :to="{ name: 'group-events', params: { id: confirmed.id } }">Check the event list <span aria-hidden="true">↗</span></RouterLink>
			</div>

			<div class="group-form__field">
				<label for="event-title">Title</label>
				<input id="event-title" v-model="fields.title" name="title" type="text" autocomplete="off" :aria-invalid="Boolean(errors.title)" :aria-describedby="errors.title ? 'event-title-error event-title-count' : 'event-title-count'" />
				<p id="event-title-count" class="group-form__count">{{ titleCount }} / {{ limits.title }}</p>
				<p v-if="errors.title" id="event-title-error" class="field-error">{{ errors.title }}</p>
			</div>

			<div class="group-form__field">
				<label for="event-description">Description</label>
				<textarea id="event-description" v-model="fields.description" name="description" rows="5" :aria-invalid="Boolean(errors.description)" :aria-describedby="errors.description ? 'event-description-error event-description-count' : 'event-description-count'"></textarea>
				<p id="event-description-count" class="group-form__count">{{ descriptionCount }} / {{ limits.description.toLocaleString('en-GB') }}</p>
				<p v-if="errors.description" id="event-description-error" class="field-error">{{ errors.description }}</p>
			</div>

			<div class="group-form__field">
				<label for="event-starts-at">Day and time</label>
				<input id="event-starts-at" v-model="fields.startsAt" name="starts_at" type="datetime-local" max="9999-12-31T23:59" :aria-invalid="Boolean(errors.startsAt)" :aria-describedby="errors.startsAt ? 'event-starts-at-error event-starts-at-hint' : 'event-starts-at-hint'" />
				<p id="event-starts-at-hint" class="group-form__count">Your time{{ zone ? ` (${zone})` : '' }}. Other members see it in their own time zone.</p>
				<p v-if="errors.startsAt" id="event-starts-at-error" class="field-error">{{ errors.startsAt }}</p>
			</div>

			<div class="group-form__actions">
				<button class="button button--primary" type="submit" :disabled="uncertain" :aria-disabled="pending || uncertain" :aria-busy="pending">{{ pending ? 'Scheduling…' : 'Schedule event' }}</button>
				<RouterLink class="button button--secondary" :to="{ name: 'group-events', params: { id: confirmed.id } }">Cancel</RouterLink>
			</div>
		</form>
	</section>
</template>
