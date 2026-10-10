import { computed, inject } from 'vue';
import { useRoute } from 'vue-router';

import { sessionKey } from '../auth/session-state.js';
import { socialKey } from '../social/social-state.js';
import { parseUserId } from '../social/social-utils.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { groupsKey } from './group-state.js';

// The group a route names, with the viewer's current role. Every group screen
// (and SN-A16's group posts) starts here: protected reads are requested only
// after this confirms membership, and a signal, reconnect, focus, route or
// account change discards the group before refetching, so a removed member
// never keeps a stale "member" view.
export function useGroup() {
	const session = inject(sessionKey);
	const social = inject(socialKey);
	const groups = inject(groupsKey);
	const route = useRoute();
	const groupId = computed(() => parseUserId(route.params.id));
	const viewerId = computed(() => session.state.account?.id ?? null);

	const resource = useSocialResource(
		async () => (groupId.value ? groups.api.fetchGroup(groupId.value) : { status: 'not-found' }),
		{ social, sources: () => [groupId.value, viewerId.value] },
	);
	const group = computed(() => resource.result.value?.group ?? null);
	const role = computed(() => group.value?.viewer.role ?? 'none');
	const isMember = computed(() => role.value === 'creator' || role.value === 'member');
	const isCreator = computed(() => role.value === 'creator');

	return { ...resource, groupId, viewerId, group, role, isMember, isCreator };
}

// Sections a role may open. Nonmembers see discovery metadata only; the
// member list is members-only and join-request review is creator-only.
export function groupSections(role) {
	const sections = [{ name: 'group', label: 'About' }];
	if (role === 'creator' || role === 'member')
		sections.push({ name: 'group-members', label: 'Members' });
	if (role === 'creator') sections.push({ name: 'group-requests', label: 'Join requests' });
	return sections;
}
