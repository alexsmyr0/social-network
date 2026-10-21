// Stateful stand-in for the SN-B20 private-message and group-room contract,
// used only by tests. It extends the Phase 5 event model (users, follows,
// notices, signals) with direct messages, retry nonces, read cursors, presence
// and private DM media, and with group rooms (members-only messages, per
// membership-generation cursors that start at the room's latest message),
// following the order and rules of the approved pack's reference model
// (`validate-phase-5.py`). `chat-model.test.js` and `room-model.test.js` prove
// it against the pack before any UI result relies on it. It is never imported by `SPA/src` (a
// policy test enforces that).
import { mergeState } from '../phase4/group-backend.js';
import { pngBytes } from '../phase4/group-content-backend.js';
import {
	defaultEventState,
	EventBackend,
	loadEventFixtures,
	packToState,
} from './event-backend.js';

export { loadEventFixtures as loadChatFixtures };

const MAX_ID = Number.MAX_SAFE_INTEGER;
const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /\p{Cc}/u;
const SURROGATE = /\p{Cs}/u;
export const CHAT_CLOCK = '2026-10-15T12:00:00Z';

const MESSAGES = {
	NOT_FOUND: 'Not found',
	UNAUTHORIZED: 'Unauthorized',
	BAD_REQUEST: 'Bad request',
	VALIDATION_ERROR: 'Validation failed',
	METHOD_NOT_ALLOWED: 'Method not allowed',
	UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
	PAYLOAD_TOO_LARGE: 'Payload too large',
	ORIGIN_FORBIDDEN: 'Origin forbidden',
	CSRF_CHECK_FAILED: 'Csrf check failed',
	MESSAGE_CONFLICT: 'Message retry differs from original',
	INTERNAL_SERVER_ERROR: 'Internal server error',
};

function reply(status, body = null, headers = {}) {
	return { status, headers: { ...NO_STORE, ...headers }, body };
}

function failure(status, code, fields) {
	const error = { code, message: MESSAGES[code] ?? code };
	if (fields) error.fields = fields;
	return reply(status, { error });
}

const notFound = () => failure(404, 'NOT_FOUND');
const badRequest = () => failure(400, 'BAD_REQUEST');

const ROUTES = [
	['roomUnread', /^\/api\/v1\/group-chats\/unread$/u, ['GET']],
	['rooms', /^\/api\/v1\/group-chats$/u, ['GET']],
	['roomMessages', /^\/api\/v1\/groups\/([^/]+)\/messages$/u, ['GET', 'POST']],
	['roomRead', /^\/api\/v1\/groups\/([^/]+)\/messages\/read$/u, ['PUT']],
	['unread', /^\/api\/v1\/chats\/unread$/u, ['GET']],
	['roster', /^\/api\/v1\/chats$/u, ['GET']],
	['messages', /^\/api\/v1\/chats\/([^/]+)\/messages$/u, ['GET', 'POST']],
	['images', /^\/api\/v1\/chats\/([^/]+)\/images$/u, ['POST']],
	['read', /^\/api\/v1\/chats\/([^/]+)\/read$/u, ['PUT']],
	['media', /^\/api\/v1\/media\/([^/]+)$/u, ['GET']],
];

function matchChatRoute(pathname) {
	for (const [name, pattern, methods] of ROUTES) {
		const match = pattern.exec(pathname);
		if (match) return { name, param: match[1], methods };
	}
	return null;
}

function parseId(text) {
	if (typeof text !== 'string' || !/^[1-9]\d*$/u.test(text)) return null;
	const id = Number(text);
	return id <= MAX_ID ? id : null;
}

function queryNumbers(params, allowed) {
	const result = {};
	for (const key of new Set(params.keys())) {
		const values = params.getAll(key);
		const max = allowed[key];
		if (max === undefined || values.length !== 1 || !/^[1-9]\d*$/u.test(values[0])) return null;
		const value = Number(values[0]);
		if (value > max) return null;
		result[key] = value;
	}
	return result;
}

function messageText(value, required) {
	if (typeof value !== 'string') return { error: value == null ? 'REQUIRED' : 'INVALID_TEXT' };
	const text = value.replace(/\r\n/gu, '\n').trim();
	if (required && text === '') return { error: 'CONTENT_REQUIRED' };
	if ([...text].length > 2000) return { error: 'TOO_LONG' };
	if (CONTROL.test(text.replace(/[\n\t]/gu, '')) || SURROGATE.test(text))
		return { error: 'INVALID_TEXT' };
	return { text };
}

const BODY_KEYS = {
	messages: ['client_id', 'body', 'image_url'],
	read: ['through_id'],
	roomMessages: ['membership_id', 'client_id', 'body'],
	roomRead: ['membership_id', 'through_id'],
};
const STRING_KEYS = new Set(['client_id', 'body', 'image_url']);

// Alex (42) is the usual viewer. Group 301 (Chess Club, created by Alex) has Ada
// (7, private) and Lee (10) as members, and a room with three messages that
// Alex has read; Book Club (302, created by Robin) has Alex's usual strangers. Ada (7, private) is followed by Alex, so her
// conversation and presence are visible and open to messages; Lee (10)
// follows Alex, so Alex may message back; Sam (8) has only a pending request
// and Pat (9) / Robin (99) are strangers.
export function defaultChatState() {
	const base = defaultEventState();
	return {
		...base,
		follows: {
			...base.follows,
			72: { id: 72, follower_id: 42, followed_id: 7, state: 'accepted' },
			73: { id: 73, follower_id: 10, followed_id: 42, state: 'accepted' },
			74: { id: 74, follower_id: 42, followed_id: 8, state: 'pending' },
			75: { id: 75, follower_id: 42, followed_id: 11, state: 'accepted' },
		},
		dms: {
			501: {
				id: 501,
				sender_id: 7,
				recipient_id: 42,
				body: 'Morning! Did you see the new rules?',
				created_at: '2026-10-15T09:00:00Z',
				client_id: null,
			},
			502: {
				id: 502,
				sender_id: 42,
				recipient_id: 7,
				body: 'Yes. Here is the board.',
				image_url: '/api/v1/media/702',
				created_at: '2026-10-15T09:05:00Z',
				client_id: null,
			},
			503: {
				id: 503,
				sender_id: 10,
				recipient_id: 42,
				body: 'Are we still on for Friday?',
				created_at: '2026-10-15T10:00:00Z',
				client_id: null,
			},
			504: {
				id: 504,
				sender_id: 10,
				recipient_id: 42,
				body: 'Bring the clock.',
				created_at: '2026-10-15T10:01:00Z',
				client_id: null,
			},
		},
		dm_cursors: { '42:7': 501, '7:42': 502, '42:10': 0, '10:42': 504 },
		media: { 702: { uploader_id: 42, recipient_id: 7, message_id: 502 } },
		online: { 7: true, 10: true, 11: false, 42: true },
		group_messages: {
			801: {
				id: 801,
				group_id: 301,
				sender_id: 7,
				membership_id: 502,
				body: 'Welcome to the club.',
				created_at: '2026-10-15T09:10:00Z',
				client_id: null,
			},
			802: {
				id: 802,
				group_id: 301,
				sender_id: 42,
				membership_id: 501,
				body: 'Thanks, Ada. Who has a board?',
				created_at: '2026-10-15T09:12:00Z',
				client_id: null,
			},
			803: {
				id: 803,
				group_id: 301,
				sender_id: 10,
				membership_id: 504,
				body: 'I do ♟️',
				created_at: '2026-10-15T09:15:00Z',
				client_id: null,
			},
		},
		group_cursors: { 501: 803, 502: 803, 504: 803 },
		next_ids: { ...base.next_ids, dm: 505, media: 703, group_messages: 804 },
	};
}

// The pack's compact format plus the direct-message tables.
export function chatPackToState(pack, given) {
	const merged = mergeState(pack.state, given);
	const state = packToState(pack, given);
	return {
		...state,
		dms: structuredClone(merged.dms ?? {}),
		dm_cursors: structuredClone(merged.dm_cursors ?? {}),
		media: structuredClone(merged.media ?? {}),
		online: Object.fromEntries(
			Object.values(merged.users).map((user) => [user.id, Boolean(user.online)]),
		),
		group_messages: structuredClone(merged.messages ?? {}),
		group_cursors: structuredClone(merged.group_cursors ?? {}),
		next_ids: {
			...state.next_ids,
			dm: merged.next_ids.dm,
			media: merged.next_ids.media,
			group_messages: merged.next_ids.message,
		},
	};
}

export class ChatBackend extends EventBackend {
	constructor({ state = defaultChatState(), given } = {}) {
		super({ state, given });
		const merged = mergeState(state, given);
		this.clock = CHAT_CLOCK;
		this.dms = new Map(Object.values(merged.dms ?? {}).map((dm) => [dm.id, { ...dm }]));
		this.dmCursors = new Map(Object.entries(merged.dm_cursors ?? {}));
		this.media = new Map(
			Object.entries(merged.media ?? {}).map(([id, item]) => [Number(id), { ...item }]),
		);
		this.online = new Map(
			Object.entries(merged.online ?? {}).map(([id, value]) => [Number(id), Boolean(value)]),
		);
		this.groupMessages = new Map(
			Object.values(merged.group_messages ?? {}).map((message) => [message.id, { ...message }]),
		);
		this.groupCursors = new Map(
			Object.entries(merged.group_cursors ?? {}).map(([id, value]) => [Number(id), value]),
		);
		this.uploads = [];
		this.uploadFault = null;
	}

	static fromPack(pack, given) {
		return new ChatBackend({ state: chatPackToState(pack, given) });
	}

	snapshot() {
		const table = (map) => Object.fromEntries([...map].map(([id, value]) => [id, { ...value }]));
		return {
			...super.snapshot(),
			dms: table(this.dms),
			dm_cursors: Object.fromEntries(this.dmCursors),
			media: table(this.media),
			online: Object.fromEntries(this.online),
			group_messages: table(this.groupMessages),
			group_cursors: Object.fromEntries(this.groupCursors),
		};
	}

	// --- relationship and presence rules ---------------------------------------

	accepted(from, to) {
		return this.follows.some(
			(f) => f.follower_id === from && f.followed_id === to && f.state === 'accepted',
		);
	}

	canSend(a, b) {
		return (
			a !== b &&
			Boolean(this.user(a)) &&
			Boolean(this.user(b)) &&
			(this.accepted(a, b) || this.accepted(b, a))
		);
	}

	pairMessages(a, b) {
		return [...this.dms.values()]
			.filter(
				(dm) =>
					(dm.sender_id === a && dm.recipient_id === b) ||
					(dm.sender_id === b && dm.recipient_id === a),
			)
			.sort((x, y) => x.id - y.id);
	}

	historyAllowed(a, b) {
		return (
			a !== b &&
			Boolean(this.user(a)) &&
			Boolean(this.user(b)) &&
			(this.canSend(a, b) || this.pairMessages(a, b).length > 0)
		);
	}

	// Instant delivery to the recipient: allowed to send, online, and either they
	// follow the sender or their profile is public.
	live(sender, recipient) {
		const subject = this.user(recipient);
		return Boolean(
			subject &&
				this.canSend(sender, recipient) &&
				this.online.get(recipient) &&
				(this.accepted(recipient, sender) || subject.visibility === 'public'),
		);
	}

	presenceVisible(viewerId, subjectId) {
		const subject = this.user(subjectId);
		return Boolean(
			subject && (subject.visibility === 'public' || this.accepted(viewerId, subjectId)),
		);
	}

	cursor(a, b) {
		return this.dmCursors.get(`${a}:${b}`) ?? 0;
	}

	unreadWith(a, b) {
		if (!this.historyAllowed(a, b)) return 0;
		const cursor = this.cursor(a, b);
		return this.pairMessages(a, b).filter((dm) => dm.recipient_id === a && dm.id > cursor).length;
	}

	unreadTotal(a) {
		return [...this.users.values()]
			.filter((user) => user.id !== a)
			.reduce((sum, user) => sum + this.unreadWith(a, user.id), 0);
	}

	// --- group room rules ---------------------------------------------------------

	// The viewer's current membership in a visible group: the only thing that
	// opens a room. Outsiders, invitees, requesters and departed members have none.
	roomMember(userId, groupId) {
		return this.group(groupId) ? this.membershipOf(groupId, userId) : null;
	}

	roomMessages(groupId) {
		return [...this.groupMessages.values()]
			.filter((message) => message.group_id === groupId)
			.sort((a, b) => a.id - b.id);
	}

	latestRoomId(groupId) {
		return this.roomMessages(groupId).at(-1)?.id ?? 0;
	}

	roomCursor(membership) {
		return this.groupCursors.get(membership.id) ?? 0;
	}

	roomUnread(userId, groupId) {
		const membership = this.roomMember(userId, groupId);
		if (!membership) return 0;
		const cursor = this.roomCursor(membership);
		return this.roomMessages(groupId).filter(
			(message) => message.sender_id !== userId && message.id > cursor,
		).length;
	}

	roomUnreadTotal(userId) {
		return [...this.groups.keys()].reduce((sum, id) => sum + this.roomUnread(userId, id), 0);
	}

	roomRecipients(groupId) {
		return this.activeMembers(groupId)
			.map((member) => member.user_id)
			.sort((a, b) => a - b);
	}

	roomWire(message) {
		const { membership_id: _generation, ...wire } = message;
		return { ...wire, sender_username: this.displayName(message.sender_id) };
	}

	// A new membership starts reading at the room's latest message: the whole
	// history is readable and nothing earlier counts as unread.
	admit(groupId, userId, named) {
		const membership = super.admit(groupId, userId, named);
		this.groupCursors.set(membership.id, this.latestRoomId(groupId));
		return membership;
	}

	removeMembership(viewer, id, json) {
		const result = super.removeMembership(viewer, id, json);
		if (result.status < 400) this.groupCursors.delete(id);
		return result;
	}

	removeMember(groupId, userId) {
		const membership = this.membershipOf(groupId, userId);
		super.removeMember(groupId, userId);
		if (membership) this.groupCursors.delete(membership.id);
	}

	// A room message committed directly, as another member's session would.
	commitRoom(groupId, senderId, fields = {}) {
		const membership = this.membershipOf(groupId, senderId);
		if (!membership) throw new Error(`User ${senderId} is not in group ${groupId}`);
		const id = this.allocate('group_messages');
		const message = {
			id,
			group_id: groupId,
			sender_id: senderId,
			membership_id: membership.id,
			body: fields.body ?? '',
			created_at: fields.created_at ?? this.clock,
			client_id: fields.client_id ?? null,
		};
		this.groupMessages.set(id, message);
		this.signal('group.message', this.roomRecipients(groupId), this.roomWire(message));
		return message;
	}

	signal(type, recipients, payload) {
		const before = this.signals.length;
		super.signal(type, recipients);
		if (payload !== undefined && this.signals.length > before)
			this.signals[this.signals.length - 1].payload = payload;
	}

	// --- control actions used by journeys --------------------------------------

	setFollow(from, to, state) {
		const index = this.follows.findIndex((f) => f.follower_id === from && f.followed_id === to);
		if (state === 'none') {
			if (index >= 0) this.follows.splice(index, 1);
		} else if (index >= 0) {
			this.follows[index].state = state;
		} else {
			this.follows.push({
				id: this.nextFollowId++,
				follower_id: from,
				followed_id: to,
				state,
				created_at: this.clock,
				accepted_at: state === 'accepted' ? this.clock : null,
			});
		}
		this.signal('social.invalidate', [from, to]);
	}

	// Presence changes reach every viewer whose profile access shows them.
	setOnline(userId, value, { announce = true } = {}) {
		this.online.set(userId, value);
		if (!announce) return;
		const recipients = [...this.users.values()]
			.filter((user) => user.id !== userId && this.presenceVisible(user.id, userId))
			.map((user) => user.id);
		this.signal('presence.update', recipients, { user_id: userId, is_online: value });
	}

	presenceSnapshot(viewerId) {
		return {
			users: [...this.users.values()]
				.filter((user) => this.online.get(user.id) && this.presenceVisible(viewerId, user.id))
				.map((user) => ({ user_id: user.id, is_online: true })),
		};
	}

	// A message committed directly, as another account's session would.
	commit(senderId, recipientId, fields = {}) {
		const id = this.allocate('dm');
		const message = {
			id,
			sender_id: senderId,
			recipient_id: recipientId,
			body: fields.body ?? '',
			created_at: fields.created_at ?? this.clock,
			client_id: fields.client_id ?? null,
		};
		if (fields.image_url) message.image_url = fields.image_url;
		this.dms.set(id, message);
		this.dmCursors.set(`${senderId}:${recipientId}`, this.cursor(senderId, recipientId));
		this.dmCursors.set(`${recipientId}:${senderId}`, this.cursor(recipientId, senderId));
		const recipients = this.live(senderId, recipientId) ? [senderId, recipientId] : [senderId];
		this.signal('dm.message', recipients, this.wire(message));
		return message;
	}

	observable(actorId) {
		return {
			...super.observable(actorId),
			dms_count: this.dms.size,
			group_messages_count: this.groupMessages.size,
			recipient_unread: this.unreadWith(2, 1),
			media_701_message: this.media.get(701)?.message_id,
			dm_cursor: actorId === 1 || actorId === 2 ? this.cursor(actorId, 3 - actorId) : 0,
		};
	}

	// --- wire shapes -----------------------------------------------------------

	wire(message) {
		return { ...message, sender_username: this.displayName(message.sender_id) };
	}

	rosterRow(actorId, user) {
		const messages = this.pairMessages(actorId, user.id);
		const last = messages.at(-1) ?? null;
		const row = {
			user_id: user.id,
			username: this.displayName(user.id),
			last_message_at: last ? last.created_at : null,
			last_message_preview: last ? [...last.body].slice(0, 200).join('') || '[image]' : null,
			last_sender_id: last ? last.sender_id : null,
			can_send: this.canSend(actorId, user.id),
			unread_count: this.unreadWith(actorId, user.id),
			read_through_id: this.cursor(actorId, user.id),
		};
		if (this.presenceVisible(actorId, user.id)) row.is_online = Boolean(this.online.get(user.id));
		return { row, last: last ? last.id : null };
	}

	// --- dispatch --------------------------------------------------------------

	request(viewerId, method, url, payload = {}) {
		const target = new URL(url, 'http://fixture.test');
		const route = matchChatRoute(target.pathname);
		if (!route) return super.request(viewerId, method, url, payload);
		this.log.push({
			viewerId,
			method,
			path: `${target.pathname}${target.search}`,
			json: payload.json,
		});
		const guarded = this.guard(viewerId, method, route, payload);
		if (guarded.error) return guarded.error;
		const fault = this.faults.findIndex(
			(item) => item.method === method && item.path.test(target.pathname),
		);
		if (fault >= 0) {
			const item = this.faults[fault];
			if (!item.repeat) this.faults.splice(fault, 1);
			if (!item.commit) return failure(500, 'INTERNAL_SERVER_ERROR');
			const result = this.dispatchChat(guarded.viewer, method, route, target, payload);
			return result.status < 400 ? failure(500, 'INTERNAL_SERVER_ERROR') : result;
		}
		return this.dispatchChat(guarded.viewer, method, route, target, payload);
	}

	// Order from the contract: method → origin → CSRF header → session →
	// identifiers → content type → size → structure.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only mirror of the contract's check order
	guard(viewerId, method, route, payload) {
		if (!route.methods.includes(method))
			return {
				error: {
					...failure(405, 'METHOD_NOT_ALLOWED'),
					headers: { ...NO_STORE, Allow: route.methods.join(', ') },
				},
			};
		const write = method !== 'GET';
		if (write && (payload.origin ?? 'http://localhost:3000') !== 'http://localhost:3000')
			return { error: failure(403, 'ORIGIN_FORBIDDEN') };
		if (write && payload.headers && payload.headers['X-Requested-With'] !== 'XMLHttpRequest')
			return { error: failure(403, 'CSRF_CHECK_FAILED') };
		const viewer = viewerId === null ? null : this.user(viewerId);
		if (!viewer) return { error: failure(401, 'UNAUTHORIZED') };
		if (route.param !== undefined && route.name !== 'media' && parseId(route.param) === null)
			return { error: badRequest() };
		if (route.name === 'media' && parseId(route.param) === null) return { error: badRequest() };
		const upload = route.name === 'images';
		const expected = upload ? 'multipart/form-data' : 'application/json';
		if (write && (payload.contentType ?? expected) !== expected)
			return { error: failure(415, 'UNSUPPORTED_MEDIA_TYPE') };
		if ((payload.bodyBytes ?? 0) > 16384) return { error: failure(413, 'PAYLOAD_TOO_LARGE') };
		if (payload.rawJson !== undefined) return { error: badRequest() };
		return { viewer };
	}

	dispatchChat(viewer, method, route, target, payload) {
		const params = target.searchParams;
		const id = route.param === undefined ? null : parseId(route.param);
		switch (route.name) {
			case 'roomUnread':
				return this.readRoomUnread(viewer, params);
			case 'rooms':
				return this.readRooms(viewer, params);
			case 'roomMessages':
				return method === 'GET'
					? this.roomHistory(viewer, id, params)
					: this.sendRoomMessage(viewer, id, params, payload.json);
			case 'roomRead':
				return this.markRoomRead(viewer, id, params, payload.json);
			case 'unread':
				return this.readUnread(viewer, params);
			case 'roster':
				return this.readRoster(viewer, params);
			case 'media':
				return this.readMedia(viewer, id, params);
			case 'images':
				return this.upload(viewer, id, params, payload);
			case 'read':
				return this.markRead(viewer, id, params, payload.json);
			default:
				return method === 'GET'
					? this.history(viewer, id, params)
					: this.sendMessage(viewer, id, params, payload.json);
		}
	}

	bodyOf(json, allowed) {
		if (json === undefined) return { body: {} };
		if (json === null || typeof json !== 'object' || Array.isArray(json))
			return { error: badRequest() };
		if (Object.keys(json).some((key) => !allowed.includes(key))) return { error: badRequest() };
		for (const [key, value] of Object.entries(json)) {
			if (STRING_KEYS.has(key) ? typeof value !== 'string' : !Number.isInteger(value))
				return { error: badRequest() };
		}
		return { body: { ...json } };
	}

	readUnread(viewer, params) {
		if (queryNumbers(params, {}) === null) return badRequest();
		return reply(200, { data: { unread_count: this.unreadTotal(viewer.id) } });
	}

	readRoster(viewer, params) {
		if (queryNumbers(params, { page: 1000000, per_page: 50 }) === null) return badRequest();
		const entries = [...this.users.values()]
			.filter((user) => user.id !== viewer.id && this.historyAllowed(viewer.id, user.id))
			.map((user) => this.rosterRow(viewer.id, user));
		entries.sort((a, b) => {
			if (a.last !== null && b.last !== null) return b.last - a.last;
			if (a.last !== null) return -1;
			if (b.last !== null) return 1;
			return (
				a.row.username.toLowerCase().localeCompare(b.row.username.toLowerCase(), 'en') ||
				a.row.user_id - b.row.user_id
			);
		});
		return this.pagedReply(entries, params, (item) => item.row);
	}

	readRoomUnread(viewer, params) {
		if (queryNumbers(params, {}) === null) return badRequest();
		return reply(200, { data: { unread_count: this.roomUnreadTotal(viewer.id) } });
	}

	readRooms(viewer, params) {
		if (queryNumbers(params, { page: 1000000, per_page: 50 }) === null) return badRequest();
		const rooms = [...this.groups.values()]
			.sort((a, b) => a.id - b.id)
			.filter((group) => this.roomMember(viewer.id, group.id))
			.map((group) => {
				const membership = this.roomMember(viewer.id, group.id);
				const last = this.roomMessages(group.id).at(-1);
				return {
					group: { id: group.id, title: group.title },
					membership_id: membership.id,
					last_message: last ? this.roomWire(last) : null,
					read_through_id: this.roomCursor(membership),
					unread_count: this.roomUnread(viewer.id, group.id),
				};
			});
		return this.pagedReply(rooms, params, (room) => room);
	}

	roomHistory(viewer, groupId, params) {
		const query = queryNumbers(params, { before_id: MAX_ID, limit: 50 });
		if (query === null) return badRequest();
		if (!this.roomMember(viewer.id, groupId)) return notFound();
		const before = query.before_id ?? MAX_ID + 1;
		const limit = query.limit ?? 10;
		const eligible = this.roomMessages(groupId).filter((message) => message.id < before);
		const page = eligible.slice(-limit);
		const more = eligible.length > limit;
		return reply(200, {
			data: {
				messages: page.map((message) => this.roomWire(message)),
				has_more: more,
				next_before_id: more ? page[0].id : null,
			},
		});
	}

	sendRoomMessage(viewer, groupId, params, json) {
		if (queryNumbers(params, {}) === null) return badRequest();
		const { body, error } = this.bodyOf(json, BODY_KEYS.roomMessages);
		if (error) return error;
		const fields = {};
		if (body.client_id === undefined) fields.client_id = 'REQUIRED';
		else if (!UUID.test(body.client_id)) fields.client_id = 'INVALID_UUID';
		const checked = messageText(body.body, true);
		if (checked.error) fields.body = checked.error;
		if (!this.idField(body.membership_id, { zero: false })) fields.membership_id = 'INVALID_ID';
		if (Object.keys(fields).length) return failure(400, 'VALIDATION_ERROR', fields);
		const { membership, error: denied } = this.currentMembership(viewer, groupId, body);
		if (denied) return denied;
		const existing = [...this.groupMessages.values()].find(
			(message) => message.sender_id === viewer.id && message.client_id === body.client_id,
		);
		if (existing) {
			const same =
				existing.group_id === groupId &&
				existing.body === checked.text &&
				existing.membership_id === membership.id;
			return same
				? reply(200, { data: this.roomWire(existing) })
				: failure(409, 'MESSAGE_CONFLICT');
		}
		const message = {
			id: this.allocate('group_messages'),
			group_id: groupId,
			sender_id: viewer.id,
			membership_id: membership.id,
			body: checked.text,
			client_id: body.client_id,
			created_at: this.clock,
		};
		this.groupMessages.set(message.id, message);
		const data = this.roomWire(message);
		this.signal('group.message', this.roomRecipients(groupId), data);
		return reply(201, { data });
	}

	markRoomRead(viewer, groupId, params, json) {
		if (queryNumbers(params, {}) === null) return badRequest();
		const { body, error } = this.bodyOf(json, BODY_KEYS.roomRead);
		if (error) return error;
		const fields = {};
		if (!this.idField(body.membership_id, { zero: false })) fields.membership_id = 'INVALID_ID';
		if (!this.idField(body.through_id, { zero: true })) fields.through_id = 'INVALID_ID';
		if (Object.keys(fields).length) return failure(400, 'VALIDATION_ERROR', fields);
		const { membership, error: denied } = this.currentMembership(viewer, groupId, body);
		if (denied) return denied;
		const known = new Set(this.roomMessages(groupId).map((message) => message.id));
		if (body.through_id !== 0 && !known.has(body.through_id))
			return failure(400, 'VALIDATION_ERROR', { through_id: 'INVALID_ID' });
		const before = this.roomCursor(membership);
		const after = Math.max(before, body.through_id);
		this.groupCursors.set(membership.id, after);
		const data = { through_id: after, unread_count: this.roomUnread(viewer.id, groupId) };
		if (after !== before)
			this.signal('chat.read', [viewer.id], { kind: 'group', target_id: groupId, ...data });
		return reply(200, { data });
	}

	history(viewer, partnerId, params) {
		const query = queryNumbers(params, { before_id: MAX_ID, limit: 50 });
		if (query === null) return badRequest();
		if (!this.historyAllowed(viewer.id, partnerId)) return notFound();
		const before = query.before_id ?? MAX_ID + 1;
		const limit = query.limit ?? 10;
		const eligible = this.pairMessages(viewer.id, partnerId).filter((dm) => dm.id < before);
		const page = eligible.slice(-limit);
		const more = eligible.length > limit;
		return reply(200, {
			data: {
				messages: page.map((dm) => this.wire(dm)),
				has_more: more,
				next_before_id: more ? page[0].id : null,
			},
		});
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only mirror of the contract's send rules
	sendMessage(viewer, partnerId, params, json) {
		if (queryNumbers(params, {}) === null) return badRequest();
		const { body, error } = this.bodyOf(json, BODY_KEYS.messages);
		if (error) return error;
		if (body.image_url === '') delete body.image_url;
		const fields = {};
		if (body.client_id === undefined) fields.client_id = 'REQUIRED';
		else if (!UUID.test(body.client_id)) fields.client_id = 'INVALID_UUID';
		const checked = messageText(body.body, !body.image_url);
		if (checked.error) fields.body = checked.error;
		if (Object.keys(fields).length) return failure(400, 'VALIDATION_ERROR', fields);
		if (!this.canSend(viewer.id, partnerId)) return notFound();
		const text = checked.text;
		const existing = [...this.dms.values()].find(
			(dm) => dm.sender_id === viewer.id && dm.client_id === body.client_id,
		);
		if (existing) {
			const same =
				existing.recipient_id === partnerId &&
				existing.body === text &&
				existing.image_url === body.image_url;
			return same ? reply(200, { data: this.wire(existing) }) : failure(409, 'MESSAGE_CONFLICT');
		}
		let media = null;
		if (body.image_url) {
			const match = /^\/api\/v1\/media\/(\d+)$/u.exec(body.image_url);
			media = match ? this.media.get(Number(match[1])) : null;
			if (
				!media ||
				media.uploader_id !== viewer.id ||
				media.recipient_id !== partnerId ||
				media.message_id !== null
			)
				return notFound();
		}
		const message = {
			id: this.allocate('dm'),
			sender_id: viewer.id,
			recipient_id: partnerId,
			body: text,
			client_id: body.client_id,
			created_at: this.clock,
		};
		if (media) {
			message.image_url = body.image_url;
			media.message_id = message.id;
		}
		this.dmCursors.set(`${viewer.id}:${partnerId}`, this.cursor(viewer.id, partnerId));
		this.dmCursors.set(`${partnerId}:${viewer.id}`, this.cursor(partnerId, viewer.id));
		this.dms.set(message.id, message);
		const recipients = this.live(viewer.id, partnerId) ? [viewer.id, partnerId] : [viewer.id];
		const data = this.wire(message);
		this.signal('dm.message', recipients, data);
		return reply(201, { data });
	}

	markRead(viewer, partnerId, params, json) {
		if (queryNumbers(params, {}) === null) return badRequest();
		const { body, error } = this.bodyOf(json, BODY_KEYS.read);
		if (error) return error;
		const through = body.through_id;
		if (!Number.isInteger(through) || through < 0 || through > MAX_ID)
			return failure(400, 'VALIDATION_ERROR', { through_id: 'INVALID_ID' });
		if (!this.historyAllowed(viewer.id, partnerId)) return notFound();
		const known = new Set(this.pairMessages(viewer.id, partnerId).map((dm) => dm.id));
		if (through !== 0 && !known.has(through))
			return failure(400, 'VALIDATION_ERROR', { through_id: 'INVALID_ID' });
		const before = this.cursor(viewer.id, partnerId);
		const after = Math.max(before, through);
		this.dmCursors.set(`${viewer.id}:${partnerId}`, after);
		const data = { through_id: after, unread_count: this.unreadWith(viewer.id, partnerId) };
		if (after !== before)
			this.signal('chat.read', [viewer.id], { kind: 'dm', target_id: partnerId, ...data });
		return reply(200, { data });
	}

	upload(viewer, partnerId, params, payload) {
		if (queryNumbers(params, {}) === null) return badRequest();
		const parts = payload.multipart ?? [];
		if (parts.length !== 1 || parts[0].name !== 'image') return badRequest();
		if (this.uploadFault) {
			const status = this.uploadFault;
			this.uploadFault = null;
			return status === 413
				? failure(413, 'PAYLOAD_TOO_LARGE')
				: failure(status, status === 422 ? 'INVALID_IMAGE' : 'INTERNAL_SERVER_ERROR');
		}
		if (!this.canSend(viewer.id, partnerId)) return notFound();
		const id = this.allocate('media');
		this.media.set(id, { uploader_id: viewer.id, recipient_id: partnerId, message_id: null });
		this.uploads.push({ id, ...parts[0] });
		return reply(200, { data: { image_url: `/api/v1/media/${id}` } });
	}

	readMedia(viewer, mediaId, params) {
		if (queryNumbers(params, {}) === null) return badRequest();
		const media = this.media.get(mediaId);
		const allowed =
			media &&
			(media.message_id !== null
				? [media.uploader_id, media.recipient_id].includes(viewer.id)
				: media.uploader_id === viewer.id);
		if (!allowed) return notFound();
		return { ...reply(200, null, { 'Content-Type': 'image/png' }), bytes: pngBytes() };
	}
}

// fetch-compatible adapter that also understands multipart uploads and private
// image reads, and records every call, for the component-level unit tests.
export function createChatFetch(backend, { viewer = () => 42, before, after, onLogout } = {}) {
	const calls = [];
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only fetch adapter
	async function fetchRef(url, init = {}) {
		const method = init.method ?? 'GET';
		const json = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		const form =
			typeof FormData !== 'undefined' && init.body instanceof FormData ? init.body : null;
		const multipart = form
			? [...form.entries()].map(([name, value]) => ({
					name,
					filename: value?.name,
					type: value?.type,
					size: value?.size,
				}))
			: undefined;
		const headers = init.headers ?? {};
		const entry = { url, method, json, headers, multipart };
		calls.push(entry);
		if (before) await before(entry);
		if (method === 'POST' && url === '/api/v1/users/logout') {
			onLogout?.();
			return {
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => ({ data: { logged_out: true } }),
			};
		}
		const result = backend.request(viewer(), method, url, { json, headers, multipart });
		if (after) await after(entry, result);
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			headers: {
				get: (name) => result.headers[name] ?? result.headers[name.toLowerCase()] ?? null,
			},
			json: async () => {
				if (result.body === null) throw new SyntaxError('empty body');
				return JSON.parse(JSON.stringify(result.body));
			},
			blob: async () => new Blob([result.bytes ?? new Uint8Array()], { type: 'image/png' }),
		};
	}
	fetchRef.calls = calls;
	return fetchRef;
}
