import { ROOM_PAGE } from '../../api/chats.js';

// Finds the room summary for one group. The room list is the only source of the
// membership the viewer holds now, their read cursor and unread count, so a
// group outside the first page is looked for page by page. No room means the
// viewer is not a member.
export async function findRoom(api, groupId) {
	let page = 1;
	for (;;) {
		const result = await api.fetchRooms({ page, perPage: ROOM_PAGE });
		if (result.status !== 'ok') return result;
		const room = result.rooms.find((item) => item.group_id === groupId);
		if (room) return { status: 'ok', room };
		if (page >= result.pagination.total_pages) return { status: 'ok', room: null };
		page += 1;
	}
}
