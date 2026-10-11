<script setup>
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used in Vue templates
// biome-ignore-all lint/correctness/noUnusedImports: components used in Vue templates
import { computed, ref, watch } from 'vue';

import ComposePage from '../content/ComposePage.vue';
import { useGroup } from './use-group.js';

// The composer is open only for a viewer the server has confirmed as a current
// member. Every signal, reconnect, focus or route change re-reads the group.
// A re-read must not wipe what the member is writing, so the last confirmed
// membership stays in force while a refetch is in flight or briefly fails; the
// composer closes the moment a response says the viewer is no longer a member
// (the server also refuses the write). A group or account change starts over.
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
	if (confirmed.value) return 'compose';
	if (status.value === 'loading') return 'checking';
	if (status.value === 'unavailable') return 'unavailable';
	if (status.value === 'ready') return 'restricted';
	return 'missing';
});
const offline = computed(() => confirmed.value && status.value === 'unavailable');
</script>

<template>
	<section v-if="view === 'checking'" class="social-view compose-view" data-screen="compose" data-scope="group" aria-busy="true">
		<p class="social-status" role="status">Checking your membership…</p>
	</section>

	<section v-else-if="view === 'unavailable'" class="social-view compose-view" data-screen="compose" data-scope="group">
		<div class="social-state social-state--error" role="alert">
			<h1>We can’t confirm your membership right now.</h1>
			<p>Nothing was posted, and the composer stays closed until we can confirm you belong to this group.</p>
			<button class="button button--secondary" type="button" @click="reload('hard')">Try again</button>
		</div>
	</section>

	<section v-else-if="view === 'missing'" class="social-view compose-view" data-screen="compose" data-scope="group">
		<div class="social-state" data-state="missing">
			<p class="eyebrow">New group post</p>
			<h1>This group isn’t available.</h1>
			<p>It may not exist, or the link may be wrong.</p>
			<RouterLink class="button button--secondary" :to="{ name: 'groups' }">Browse groups</RouterLink>
		</div>
	</section>

	<section v-else-if="view === 'restricted'" class="social-view compose-view" data-screen="compose" data-scope="group">
		<div class="social-state" role="status" data-state="restricted">
			<p class="eyebrow">New group post{{ group ? ` · ${group.title}` : '' }}</p>
			<h1>Only members can post here.</h1>
			<p>Join {{ group?.title }} first. Nothing you write is sent to a group you don’t belong to, and nothing was posted if you were removed while writing.</p>
			<RouterLink v-if="group" class="button button--secondary" :to="{ name: 'group', params: { id: group.id } }">About this group</RouterLink>
		</div>
	</section>

	<template v-else>
		<p v-if="offline" class="form-alert" role="status" data-state="offline">
			We can’t re-check your membership right now. Anything you publish is still checked by the group, and nothing is retried automatically.
		</p>
		<ComposePage :key="confirmed.id" :group="confirmed" @membership-lost="reload('quiet')" />
	</template>
</template>
