import { MESSAGE_PAGE } from '../../api/chats.js';
import { mergeMessages } from './message-utils.js';

// Newest messages plus, when this is a refresh after a gap (reconnect, missed
// frames), every page back to the last message already known. It never relies
// on `before_id` alone, which pages older history and would skip new messages.
// `fetchPage` is a private conversation's or a group room's history read.
export async function fetchNewest(fetchPage, known) {
	const first = await fetchPage({ limit: MESSAGE_PAGE });
	if (first.status !== 'ok') return first;
	let messages = first.messages;
	let oldest = first;
	while (known > 0 && oldest.hasMore && oldest.messages[0].id > known) {
		const page = await fetchPage({ beforeId: oldest.nextBeforeId, limit: MESSAGE_PAGE });
		if (page.status !== 'ok') return page;
		// Require progress rather than capping recovery and silently leaving a gap.
		if (!page.messages.length || page.messages.at(-1).id >= oldest.messages[0].id)
			return { status: 'unavailable' };
		messages = mergeMessages(messages, page.messages);
		oldest = page;
	}
	return { status: 'ok', messages, hasMore: oldest.hasMore, nextBeforeId: oldest.nextBeforeId };
}
