import { computed, inject, watch } from 'vue';

import { sessionKey } from '../auth/session-state.js';
import { socialKey } from '../social/social-state.js';
import { useSocialResource } from '../social/use-social-resource.js';
import { messagesKey } from './message-state.js';
import { findRoom } from './rooms.js';

// The viewer's own room summary for one group: its unread count for the group
// navigation. Always the server's count (message frames and read changes
// refetch it quietly), never tallied from frames. Without a message state, for
// someone who cannot have a room, or when the server shows no room, there is
// nothing to count and nothing is asked.
export function useRoomSummary(groupId, enabled = computed(() => true)) {
	const messages = inject(messagesKey, null);
	const social = inject(socialKey, null);
	const session = inject(sessionKey, null);
	if (!(messages && social && session)) return { unread: computed(() => null) };
	const viewerId = computed(() => session.state.account?.id ?? null);
	const resource = useSocialResource(
		() => (enabled.value ? findRoom(messages.api, groupId.value) : { status: 'ok', room: null }),
		{
			social,
			sources: () => [groupId.value, viewerId.value, enabled.value],
			retain: true,
		},
	);
	watch(
		() => messages.state.revision,
		() => resource.reload('quiet'),
	);
	const unread = computed(() => resource.result.value?.room?.unread_count ?? null);
	return { unread };
}
