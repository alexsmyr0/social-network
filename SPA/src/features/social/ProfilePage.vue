<script setup>
import { computed, inject, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import ActivityPanel from '../content/ActivityPanel.vue';
import { messagesKey } from '../messages/message-state.js';
import { findRosterEntry } from '../messages/use-thread.js';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import FollowControl from './FollowControl.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import PrivacyControl from './PrivacyControl.vue';
// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from './SocialAvatar.vue';
import { socialKey } from './social-state.js';
import { formatBirthDate, parseUserId } from './social-utils.js';
import { useSocialResource } from './use-social-resource.js';

const social = inject(socialKey);
const route = useRoute();
const userId = computed(() => parseUserId(route.params.id));

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const { status, result, reload } = useSocialResource(
	async () => (userId.value ? social.api.fetchProfile(userId.value) : { status: 'not-found' }),
	{ social, sources: () => userId.value },
);

const subject = computed(() => result.value?.profile ?? null);

// A conversation is open when either person follows the other. The profile
// only says whether the viewer follows the subject, so the other direction is
// read from the message roster, which marks who the viewer may write to.
const messages = inject(messagesKey, null);
const rosterCanSend = ref(false);
watch(
	() => [subject.value?.id, subject.value?.relationship.state],
	async ([id, state]) => {
		rosterCanSend.value = false;
		if (!id || !messages || state === 'self' || state === 'accepted') return;
		const lookup = await findRosterEntry(messages.api, id);
		if (subject.value?.id !== id || subject.value?.relationship.state !== state) return;
		rosterCanSend.value = lookup.status === 'ok' && Boolean(lookup.entry?.can_send);
	},
	{ immediate: true },
);
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const canMessage = computed(
	() => subject.value?.relationship.state === 'accepted' || rosterCanSend.value,
);
const full = computed(() => subject.value?.access === 'full');
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const owner = computed(() => subject.value?.relationship.state === 'self');
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const details = computed(() => {
	if (!full.value) return [];
	const { profile } = subject.value;
	const rows = [
		['Name', `${profile.first_name} ${profile.last_name}`.trim()],
		['Email', profile.email],
		['Date of birth', formatBirthDate(profile.date_of_birth)],
	];
	if (profile.nickname) rows.splice(1, 0, ['Nickname', profile.nickname]);
	return rows.filter(([, value]) => value);
});
</script>

<template>
	<section class="social-view profile-view" data-screen="profile" :aria-busy="status === 'loading'">
		<p v-if="status === 'loading'" class="social-status" role="status">Loading profile…</p>

		<div v-else-if="status === 'not-found' || status === 'rejected'" class="social-state" data-state="missing">
			<p class="eyebrow">Profile</p>
			<h1>This profile isn’t available.</h1>
			<p>It may not exist anymore, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'people' }">Browse people</RouterLink>
		</div>

		<div v-else-if="status === 'unavailable'" class="social-state social-state--error" role="alert">
			<h1>We can’t load this profile right now.</h1>
			<p>Nothing was changed, and no details are shown until we can confirm access.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>

		<template v-else-if="subject">
			<header class="profile-head">
				<SocialAvatar :name="subject.display_name" :src="full ? subject.profile.avatar_url : null" size="lg" />
				<div class="profile-head__copy">
					<p class="eyebrow">{{ owner ? 'Your profile' : 'Profile' }}</p>
					<h1>{{ subject.display_name }}</h1>
					<p v-if="full" class="profile-head__visibility" data-visibility>
						<span class="badge" :class="`badge--${subject.profile.visibility}`">{{ subject.profile.visibility === 'private' ? 'Private profile' : 'Public profile' }}</span>
					</p>
					<p v-else class="profile-head__visibility">
						<span class="badge badge--private">Private profile</span>
					</p>
					<RouterLink v-if="canMessage" class="text-link profile-head__message" :to="{ name: 'conversation', params: { id: subject.id } }">Message {{ subject.display_name }} <span aria-hidden="true">→</span></RouterLink>
				</div>
				<FollowControl :person="subject" />
			</header>

			<div v-if="!full" class="social-state profile-teaser" data-state="teaser">
				<h2>Only their name is public.</h2>
				<p>
					{{ subject.relationship.state === 'pending'
						? 'Your request is waiting for their answer. You’ll see more if they accept it.'
						: 'Follow to ask for access. They decide whether to accept.' }}
				</p>
			</div>

			<template v-else>
				<dl class="profile-details">
					<div v-for="[label, value] in details" :key="label">
						<dt>{{ label }}</dt>
						<dd>{{ value }}</dd>
					</div>
					<div v-if="subject.profile.about_me" class="profile-details__about">
						<dt>About</dt>
						<dd class="profile-details__text">{{ subject.profile.about_me }}</dd>
					</div>
				</dl>

				<nav class="profile-counts" aria-label="Connections">
					<RouterLink :to="{ name: 'followers', params: { id: subject.id } }">
						<strong>{{ subject.profile.followers_count }}</strong> {{ subject.profile.followers_count === 1 ? 'follower' : 'followers' }}
					</RouterLink>
					<RouterLink :to="{ name: 'following', params: { id: subject.id } }">
						<strong>{{ subject.profile.following_count }}</strong> following
					</RouterLink>
				</nav>

				<PrivacyControl v-if="owner" :profile="subject.profile" />
				<RouterLink v-if="owner" class="text-link" :to="{name:'activity'}">Your private activity</RouterLink>
				<ActivityPanel :user-id="subject.id" />
			</template>
		</template>
	</section>
</template>
