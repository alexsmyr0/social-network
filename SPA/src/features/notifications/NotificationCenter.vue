<script setup>
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from '../social/SocialAvatar.vue';
import { socialKey } from '../social/social-state.js';
import { notificationsKey } from './notification-state.js';

const notices = inject(notificationsKey, null);
const session = inject(sessionKey);
const social = inject(socialKey, null);
const route = useRoute();
const open = ref(false);
const kind = ref('notices');
const reviewMessage = ref('');
const trigger = ref(null);
const heading = ref(null);
const panel = ref(null);
const currentAccount = computed(() => session.state.account?.id);
watch(currentAccount, () => {
	open.value = false;
	kind.value = 'notices';
	reviewMessage.value = '';
});
watch(
	() => route.fullPath,
	() => {
		open.value = false;
	},
);

const state = computed(() => notices?.state);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const pagination = computed(() =>
	kind.value === 'requests' ? state.value?.requestPagination : state.value?.noticePagination,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const page = computed(() =>
	kind.value === 'requests' ? state.value?.requestPage : state.value?.noticePage,
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const readBusy = computed(() => Object.keys(state.value?.pendingReads ?? {}).length > 0);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function toggle() {
	open.value = !open.value;
	if (open.value) {
		void notices.reload('hard');
		await nextTick();
		heading.value?.focus();
	}
}

async function close() {
	open.value = false;
	await nextTick();
	trigger.value?.focus();
}
function onEscape(event) {
	if (event.key === 'Escape' && open.value) {
		event.preventDefault();
		void close();
	}
}
function onOutside(event) {
	if (open.value && !panel.value?.contains(event.target) && !trigger.value?.contains(event.target))
		open.value = false;
}
document.addEventListener('keydown', onEscape);
document.addEventListener('pointerdown', onOutside);
onUnmounted(() => {
	document.removeEventListener('keydown', onEscape);
	document.removeEventListener('pointerdown', onOutside);
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function decide(person, followId, decision) {
	const outcome = await social.decideRequest(person.id, followId, decision);
	if (outcome.kind === 'superseded' || outcome.kind === 'unauthenticated') return;
	reviewMessage.value = outcome.message ?? '';
	await nextTick();
	// A resolved row disappears; return focus to the stable panel heading.
	heading.value?.focus();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
async function markRead(id) {
	const accountId = currentAccount.value;
	await notices.markRead(id);
	await nextTick();
	if (open.value && currentAccount.value === accountId) heading.value?.focus();
}

const LABELS = {
	pending: 'Wants to follow you',
	accepted: 'Request accepted',
	declined: 'Request declined',
	cancelled: 'Request cancelled',
	unfollowed: 'No longer following',
	post_like: 'Liked your post',
	post_dislike: 'Disliked your post',
	comment: 'Commented on your post',
	comment_like: 'Liked your comment',
	comment_dislike: 'Disliked your comment',
};
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const noticeLabel = (notice) =>
	notice.type === 'follow_request' ? LABELS[notice.target.state] : LABELS[notice.type];
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function dateLabel(value) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf())
		? ''
		: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
	<div v-if="notices && session.state.status === 'authenticated'" class="notification-center">
		<button ref="trigger" class="notification-trigger" type="button" :aria-expanded="open" aria-controls="notification-panel" @click="toggle">
			<span>Notifications</span>
			<span v-if="state.unreadCount !== null" class="notification-badge" :aria-label="`${state.unreadCount} unread`">{{ state.unreadCount }}</span>
			<span v-else class="notification-badge notification-badge--unknown" aria-label="Unread count unavailable">—</span>
		</button>
		<section v-if="open" id="notification-panel" ref="panel" class="notification-panel" aria-labelledby="notification-heading">
			<header class="notification-panel__head">
				<div><p class="eyebrow">Your circle</p><h2 id="notification-heading" ref="heading" tabindex="-1">Keeping you <em>posted.</em></h2></div>
				<button class="notification-close" type="button" aria-label="Close notifications" @click="close">×</button>
			</header>
			<p class="notification-connection" role="status">{{ state.connection === 'online' ? 'Live updates connected' : 'Live updates reconnecting · the list refreshes regularly' }}</p>
			<div class="notification-tabs" role="group" aria-label="Notification lists">
				<button type="button" :aria-pressed="kind === 'notices'" @click="kind = 'notices'">All notices</button>
				<button type="button" :aria-pressed="kind === 'requests'" @click="kind = 'requests'">Follow requests<span v-if="state.requestPagination"> ({{ state.requestPagination.total }})</span></button>
			</div>
			<div class="notification-panel__body" :aria-busy="state.status === 'loading'">
				<p v-if="reviewMessage" class="field-error" role="alert">{{ reviewMessage }}</p>
				<p v-if="state.message" class="field-error" role="alert">{{ state.message }}</p>
				<p v-if="state.status === 'loading' || state.status === 'idle'" role="status">Loading notifications…</p>
				<div v-else-if="state.status === 'unavailable'" class="social-state" role="alert">
					<h3>We can’t load your notices right now.</h3><p>Try again to see the current list.</p>
					<button class="button button--secondary" type="button" @click="notices.reload()">Try notifications again</button>
				</div>
				<template v-else-if="state.status === 'ready'">
					<div v-if="kind === 'notices'" class="notification-toolbar">
						<p>{{ state.unreadCount }} unread</p>
						<button class="button button--secondary" type="button" :disabled="readBusy || state.unreadCount === 0" @click="markRead()">Mark all read</button>
					</div>
					<ul v-if="kind === 'notices' && state.notifications.length" class="notice-list" aria-label="Notifications">
						<li v-for="notice in state.notifications" :key="notice.id" class="notice" :class="{ 'notice--unread': !notice.is_read }" :data-notice-id="notice.id">
							<SocialAvatar :name="notice.actor.display_name" :src="notice.actor.avatar_url" size="sm" />
							<div class="notice__content">
								<RouterLink :to="{ name: 'profile', params: { id: notice.actor.id } }">{{ notice.actor.display_name }}</RouterLink>
								<p>{{ noticeLabel(notice) }}</p>
								<p v-if="notice.target.kind !== 'follow_request'" class="notice__context">{{ notice.target.title || 'Untitled post' }}<span v-if="notice.target.excerpt"> · {{ notice.target.excerpt }}</span></p>
								<time :datetime="notice.created_at">{{ dateLabel(notice.created_at) }}</time>
								<div v-if="notice.actions.length" class="notice__actions">
									<button v-for="decision in notice.actions" :key="decision" class="button" :class="decision === 'accept' ? 'button--primary' : 'button--secondary'" type="button" :aria-label="`${decision === 'accept' ? 'Accept' : 'Decline'} follow request from ${notice.actor.display_name}`" :disabled="Boolean(social.state.pendingFollows[notice.actor.id])" @click="decide(notice.actor, notice.target.follow_id, decision)">{{ decision === 'accept' ? 'Accept' : 'Decline' }}</button>
								</div>
								<p v-if="social.state.followMessages[notice.actor.id]" class="field-error" role="alert">{{ social.state.followMessages[notice.actor.id] }}</p>
								<button v-if="!notice.is_read" class="notice-read" type="button" :disabled="readBusy" :aria-label="`Mark notification from ${notice.actor.display_name} read`" @click="markRead(notice.id)">Mark read</button>
							</div>
						</li>
					</ul>
					<ul v-else-if="kind === 'requests' && state.requests.length" class="notice-list" aria-label="Incoming follow requests">
						<li v-for="request in state.requests" :key="request.id" class="notice" :data-request-id="request.id">
							<SocialAvatar :name="request.requester.display_name" :src="request.requester.avatar_url" size="sm" />
							<div class="notice__content">
								<RouterLink :to="{ name: 'profile', params: { id: request.requester.id } }">{{ request.requester.display_name }}</RouterLink>
								<p>Wants to follow you</p><time :datetime="request.created_at">{{ dateLabel(request.created_at) }}</time>
								<div class="notice__actions">
									<button class="button button--primary" type="button" :aria-label="`Accept follow request from ${request.requester.display_name}`" :disabled="Boolean(social.state.pendingFollows[request.requester.id])" @click="decide(request.requester, request.id, 'accept')">Accept</button>
									<button class="button button--secondary" type="button" :aria-label="`Decline follow request from ${request.requester.display_name}`" :disabled="Boolean(social.state.pendingFollows[request.requester.id])" @click="decide(request.requester, request.id, 'decline')">Decline</button>
								</div>
								<p v-if="social.state.followMessages[request.requester.id]" class="field-error" role="alert">{{ social.state.followMessages[request.requester.id] }}</p>
							</div>
						</li>
					</ul>
					<div v-else class="notification-empty" role="status"><h3>{{ kind === 'requests' ? 'No pending requests here.' : 'You’re all caught up.' }}</h3><p>{{ kind === 'requests' ? 'New follow requests will appear here.' : 'Notices from your circle will appear here.' }}</p></div>
					<nav v-if="pagination && (pagination.total_pages > 1 || page > 1)" class="pager" aria-label="Notification pages">
						<button class="button button--secondary" type="button" :disabled="page <= 1" @click="notices.setPage(kind, page - 1)">Previous</button>
						<span>Page {{ page }} of {{ pagination.total_pages || 1 }}</span>
						<button class="button button--secondary" type="button" :disabled="page >= pagination.total_pages" @click="notices.setPage(kind, page + 1)">Next</button>
					</nav>
				</template>
			</div>
		</section>
	</div>
</template>
