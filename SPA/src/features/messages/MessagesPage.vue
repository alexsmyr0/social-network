<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, inject, watch } from 'vue';
import { useRoute } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
import PaginationNav from '../social/PaginationNav.vue';
import SocialAvatar from '../social/SocialAvatar.vue';
import { socialKey } from '../social/social-state.js';
import { countLabel, parsePage } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { messagesKey } from './message-state.js';
import { previewLabel, timeLabel } from './message-utils.js';

const session = inject(sessionKey);
const social = inject(socialKey);
const messages = inject(messagesKey);
const route = useRoute();
const page = computed(() => parsePage(route.query.page));
const viewerId = computed(() => session.state.account?.id ?? null);

// The roster is the conversations the viewer has plus the people they may
// message now. It is never a list of every account.
const { status, result, reload } = useSocialResource(
	() => messages.api.fetchRoster({ page: page.value }),
	{ social, sources: () => [page.value, viewerId.value] },
);
// Live frames and read changes refetch quietly. Counts are always the
// server's, never tallied from frames.
watch(
	() => messages.state.revision,
	() => reload('quiet'),
);

const entries = computed(() => result.value?.entries ?? []);
const pagination = computed(() => result.value?.pagination ?? null);
const beyondLastPage = computed(
	() => entries.value.length === 0 && pagination.value?.total > 0 && page.value > 1,
);
const summary = computed(() =>
	pagination.value ? countLabel(pagination.value.total, 'conversation') : '',
);

function previewText(entry) {
	if (entry.preview === null)
		return entry.can_send ? 'No messages yet. Say hello.' : 'No messages yet.';
	const text = previewLabel(entry.preview);
	return entry.last_sender_id === viewerId.value ? `You: ${text}` : text;
}
</script>

<template>
	<section class="social-view message-view roster-view" data-screen="messages" :aria-busy="status === 'loading'">
		<header class="social-view__head">
			<p class="eyebrow">Private messages</p>
			<h1>Your <em>messages.</em></h1>
			<p class="social-view__lede">Talk privately with people you follow or who follow you. These are separate from your notifications.</p>
		</header>

		<p v-if="status === 'loading'" class="social-status" role="status">Loading your conversations…</p>
		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<h2>We can’t load your messages right now.</h2>
			<p>Nothing is shown until we can confirm who you may message.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
		<div v-else-if="status !== 'ready'" class="social-state" role="status" data-state="restricted">
			<h2>Messages aren’t available.</h2>
		</div>
		<template v-else>
			<p class="social-status" role="status">{{ summary }}</p>
			<div v-if="beyondLastPage" class="social-state" role="status">
				<h2>That page doesn’t exist.</h2>
				<RouterLink class="button button--secondary" :to="{ name: 'messages' }">First page</RouterLink>
			</div>
			<div v-else-if="entries.length === 0" class="social-state" role="status" data-state="empty">
				<h2>No conversations yet.</h2>
				<p>Follow someone, or let them follow you, and they will appear here.</p>
				<RouterLink class="button button--secondary" :to="{ name: 'people' }">Find people</RouterLink>
			</div>
			<ul v-else class="roster-list" aria-label="Conversations">
				<li v-for="entry in entries" :key="entry.user_id" class="roster-row" :class="{ 'roster-row--unread': entry.unread_count > 0 }" :data-user-id="entry.user_id">
					<RouterLink class="roster-row__link" :to="{ name: 'conversation', params: { id: entry.user_id } }">
						<SocialAvatar :name="entry.name" size="md" />
						<span class="roster-row__main">
							<span class="roster-row__name">
								<span>{{ entry.name }}</span>
								<span v-if="messages.presenceFor(entry) !== null" class="presence" :data-online="messages.presenceFor(entry)">
									<span class="presence__dot" aria-hidden="true"></span>
									<span class="presence__label">{{ messages.presenceFor(entry) ? 'Online' : 'Offline' }}</span>
								</span>
								<span v-if="!entry.can_send" class="badge roster-row__readonly">Read only</span>
							</span>
							<span class="roster-row__preview">{{ previewText(entry) }}</span>
						</span>
						<span class="roster-row__meta">
							<time v-if="entry.last_message_at" :datetime="entry.last_message_at">{{ timeLabel(entry.last_message_at) }}</time>
							<span v-if="entry.unread_count > 0" class="message-unread" role="img" :aria-label="`${entry.unread_count} unread ${entry.unread_count === 1 ? 'message' : 'messages'}`">{{ entry.unread_count }}</span>
						</span>
					</RouterLink>
				</li>
			</ul>
			<PaginationNav v-if="pagination" :page="page" :total-pages="pagination.total_pages" label="Conversation pages" />
		</template>
	</section>
</template>
