import { expect, test } from '@playwright/test';
import {
	actors,
	admit,
	conflict,
	createGroup,
	dispose,
	eventNotices,
	follow,
	http,
	indicator,
	leave,
	membership,
	noOverflow,
	notices,
	png,
	privacy,
	recreate,
	trigger,
	uuid,
} from './support/real-service.js';

// SN-A21: permissions that cross features, state that must survive a restart,
// and the keyboard/mobile/desktop layouts, all on real data.
const unreadLabel = (n) => `Messages, ${n} unread message${n === 1 ? '' : 's'}`;
const dm = (other, tail = 'messages') => `/api/v1/chats/${other.account.id}/${tail}`;
const room = (group, tail = 'messages') => `/api/v1/groups/${group.id}/${tail}`;
const events = (group, tail = '') => `/api/v1/groups/${group.id}/events${tail}`;
const sendDm = (from, to, body, extra = {}) =>
	http(from, 'post', dm(to), { client_id: uuid(), body, ...extra }, 201);
const sendRoom = (actor, group, mem, body) =>
	http(actor, 'post', room(group), { membership_id: mem.id, client_id: uuid(), body }, 201);
const startsAt = '2099-11-05T19:30:00Z';
const createEvent = async (actor, group, mem, title, description = 'Bring a board') =>
	(
		await http(
			actor,
			'post',
			events(group),
			{ membership_id: mem.id, title, description, starts_at: startsAt },
			201,
		)
	).data;
async function mediaStatus(actor, path) {
	const response = await actor.context.request.get(path);
	if (response.status() === 200) expect(await response.body()).toEqual(png);
	return response.status();
}
// Everything an actor can read about Phase 5, without volatile presence.
async function snapshot(actor, { others = [], groups = [], eventsOf = [] }) {
	const out = { dm: {}, rooms: {}, events: {} };
	out.roster = (await http(actor, 'get', '/api/v1/chats?per_page=50')).data.map(
		({ is_online, ...rest }) => rest,
	);
	out.dmUnread = (await http(actor, 'get', '/api/v1/chats/unread')).data;
	out.roomUnread = (await http(actor, 'get', '/api/v1/group-chats/unread')).data;
	out.roomList = (await http(actor, 'get', '/api/v1/group-chats?per_page=50')).data;
	out.notices = (await http(actor, 'get', '/api/v1/notifications?per_page=50')).data;
	for (const other of others)
		out.dm[other.account.id] = (await http(actor, 'get', `${dm(other)}?limit=50`)).data;
	for (const group of groups)
		out.rooms[group.id] = (await http(actor, 'get', `${room(group)}?limit=50`)).data;
	for (const [group, event] of eventsOf) {
		out.events[event.id] = {
			event: (await http(actor, 'get', events(group, `/${event.id}`))).data,
			responses: (await http(actor, 'get', events(group, `/${event.id}/responses`))).data,
		};
	}
	return out;
}

test.describe('SN-A21 follows, membership and privacy never widen each other', () => {
	test.setTimeout(240000);

	test('a shared group opens no private chat, a follow opens no room or event, and a profile change changes only what it governs', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Creator', 'Ann', 'Ben', 'Fan']);
		const [creator, ann, ben, fan] = all;
		try {
			await privacy(ben, 'private');
			const group = await createGroup(creator);
			const annMem = await admit(creator, group, ann);
			const benMem = await admit(creator, group, ben);
			// Fan follows both members (Ben must accept) but belongs to no group.
			await follow(fan, ann);
			await follow(fan, ben);

			// Members of the same group, no follow: no private chat and no profile access.
			await http(ann, 'get', dm(ben), undefined, 404);
			await http(ann, 'post', dm(ben), { client_id: uuid(), body: 'hi' }, 404);
			await http(ben, 'get', dm(ann), undefined, 404);
			expect((await http(ann, 'get', `/api/v1/users/${ben.account.id}/profile`)).data.access).toBe(
				'teaser',
			);
			await ann.page.goto(`/messages/${ben.account.id}`);
			await expect(
				ann.page.getByRole('heading', { name: 'This conversation isn’t available.' }),
			).toBeVisible();
			// ...but the room and the events work for both.
			await sendRoom(ann, group, annMem, 'room works');
			const event = await createEvent(ben, group, benMem, 'Members only');
			expect(await eventNotices(ann, event.id)).toHaveLength(1);

			// A follower who is not a member: private chat yes, room and events no.
			await sendDm(fan, ann, 'dm works');
			await http(fan, 'get', room(group), undefined, 404);
			await http(fan, 'get', events(group), undefined, 404);
			await http(fan, 'get', events(group, `/${event.id}`), undefined, 404);
			expect(await eventNotices(fan, event.id)).toHaveLength(0);
			expect((await http(fan, 'get', '/api/v1/group-chats')).data).toEqual([]);
			expect((await http(fan, 'get', `/api/v1/users/${ben.account.id}/profile`)).data.access).toBe(
				'full',
			);
			await fan.page.goto(`/groups/${group.id}/chat`);
			await expect(
				fan.page.getByRole('heading', { name: `Only members of ${group.title} can chat here.` }),
			).toBeVisible();
			await fan.page.goto(`/groups/${group.id}/events`);
			await expect(fan.page.getByText('Only members can see group events.')).toBeVisible();

			// Ben following Ann (public) opens a private chat for them without touching the room.
			await follow(ben, ann);
			await sendDm(ben, ann, 'now we can talk');
			expect((await http(ann, 'get', dm(ben))).data.messages).toHaveLength(1);

			// Ann leaves the group: she keeps her private chats and loses the room and events.
			await leave(ann, annMem);
			await http(ann, 'get', room(group), undefined, 404);
			await http(ann, 'get', events(group), undefined, 404);
			expect((await http(ann, 'get', `${dm(fan)}?limit=50`)).data.messages).toHaveLength(1);
			expect((await http(ann, 'get', `${dm(ben)}?limit=50`)).data.messages).toHaveLength(1);
			await sendDm(ann, ben, 'still can talk');
			// Her contribution to the room stays for the others.
			expect(
				(await http(ben, 'get', `${room(group)}?limit=50`)).data.messages.map((m) => m.body),
			).toEqual(['room works']);
			expect((await http(ben, 'get', events(group, `/${event.id}`))).data.creator.id).toBe(
				ben.account.id,
			);

			// The profile toggle governs the profile and live delivery, nothing in the group.
			await privacy(ben, 'public');
			await http(fan, 'get', room(group), undefined, 404);
			await privacy(ben, 'private');
			expect((await http(ben, 'get', `${room(group)}?limit=50`)).data.messages).toHaveLength(1);
			// A third party's relationship to one side still opens nothing between others.
			await http(fan, 'get', dm(ben), undefined, 200);
			await http(creator, 'get', dm(ben), undefined, 404);
		} finally {
			await dispose(all);
		}
	});
});

test('SN-A21 events, messages, cursors, notices, sessions and bytes survive container recreation', async ({
	browser,
	baseURL,
}) => {
	test.setTimeout(300000);
	const all = await actors(browser, baseURL, ['Creator', 'Ann', 'Ben', 'Outsider']);
	const [creator, ann, ben, outsider] = all;
	try {
		await follow(creator, ann);
		const group = await createGroup(creator);
		const creatorMem = await membership(creator, group);
		const annMem = await admit(creator, group, ann);
		const benMem = await admit(creator, group, ben);
		const event = await createEvent(creator, group, creatorMem, 'Survives restart');
		await http(
			ann,
			'put',
			events(group, `/${event.id}/response`),
			{ membership_id: annMem.id, choice: 'going', expected_version: 0 },
			200,
		);
		// A DM with a committed image, one read and one unread; a room with read and unread.
		const upload = await creator.context.request.post(dm(ann, 'images'), {
			multipart: { image: { name: 'a.png', mimeType: 'image/png', buffer: png } },
		});
		const image = (await upload.json()).data.image_url;
		const withImage = (await sendDm(creator, ann, 'Look at this', { image_url: image })).data;
		await sendDm(creator, ann, 'Second');
		await http(ann, 'put', dm(creator, 'read'), { through_id: withImage.id }, 200);
		const roomA = (await sendRoom(creator, group, creatorMem, 'Room one')).data;
		await sendRoom(creator, group, creatorMem, 'Room two');
		await http(
			ann,
			'put',
			room(group, 'messages/read'),
			{ membership_id: annMem.id, through_id: roomA.id },
			200,
		);
		// A removed member's retained room message and a stale membership ID.
		const benMessage = (await sendRoom(ben, group, benMem, 'Ben was here')).data;
		await http(creator, 'delete', `/api/v1/group-memberships/${benMem.id}`, undefined, 204);
		const nonce = uuid();
		const retryBody = { membership_id: annMem.id, client_id: nonce, body: 'retry across restart' };
		const retried = (await http(ann, 'post', room(group), retryBody, 201)).data;

		// The open room reads what it shows, so the cursor is part of the snapshot.
		await ann.page.goto(`/groups/${group.id}/chat`);
		await expect(ann.page.locator(`.message[data-message-id="${retried.id}"]`)).toBeVisible();
		await expect(indicator(ann.page)).toHaveAttribute('aria-label', unreadLabel(1));
		const world = { groups: [group], eventsOf: [[group, event]] };
		const before = {
			creator: await snapshot(creator, { ...world, others: [ann] }),
			ann: await snapshot(ann, { ...world, others: [creator] }),
		};
		expect(before.ann.dmUnread.unread_count).toBe(1);
		expect(before.ann.roomUnread.unread_count).toBe(0);
		// The creator has not opened the room: Ben's message and Ann's are unread for them.
		expect(before.creator.roomUnread.unread_count).toBe(2);

		recreate();

		// Sessions persist: the same cookies still work. Nothing was reset or reread.
		const after = {
			creator: await snapshot(creator, { ...world, others: [ann] }),
			ann: await snapshot(ann, { ...world, others: [creator] }),
		};
		expect(after.creator).toEqual(before.creator);
		expect(after.ann).toEqual(before.ann);
		expect(await mediaStatus(ann, withImage.image_url)).toBe(200);
		expect(await mediaStatus(creator, withImage.image_url)).toBe(200);
		expect(await mediaStatus(outsider, withImage.image_url)).toBe(404);
		// Removed member: nothing readable, stored message still shown to members.
		await http(ben, 'get', room(group), undefined, 404);
		expect(
			(await http(ann, 'get', `${room(group)}?limit=50`)).data.messages.map((m) => m.id),
		).toContain(benMessage.id);
		await http(
			ben,
			'post',
			room(group),
			{ membership_id: benMem.id, client_id: uuid(), body: 'stale' },
			404,
		);
		// Retry nonces persist: the same payload returns the original; changes conflict.
		expect((await http(ann, 'post', room(group), retryBody, 200)).data).toEqual(retried);
		await conflict(ann, 'post', room(group), { ...retryBody, body: 'changed' }, 'MESSAGE_CONFLICT');
		// Response versions persist: a stale version stays stale, a current one succeeds.
		await conflict(
			ann,
			'put',
			events(group, `/${event.id}/response`),
			{ membership_id: annMem.id, choice: 'going', expected_version: 0 },
			'STALE_EVENT_RESPONSE',
		);
		await http(
			ann,
			'put',
			events(group, `/${event.id}/response`),
			{ membership_id: annMem.id, choice: 'not_going', expected_version: 1 },
			200,
		);

		// The page opened before recreation reconnects by itself and receives live messages.
		await expect(ann.page.locator('.message', { hasText: 'retry across restart' })).toBeVisible();
		const live = (await sendRoom(creator, group, creatorMem, 'After the restart')).data;
		await expect(ann.page.locator(`.message[data-message-id="${live.id}"]`)).toBeVisible({
			timeout: 45000,
		});
		// A page opened after recreation shows the indicators from stored cursors.
		await ann.page.goto('/people');
		await expect(indicator(ann.page)).toHaveAttribute('aria-label', unreadLabel(1));
		await expect(trigger(ann.page)).toBeVisible();
		// Event notices persist with their read state.
		expect(await eventNotices(ann, event.id)).toHaveLength(1);
		expect(
			(await notices(ann)).filter((n) => n.target.kind === 'group_event')[0].target.group.id,
		).toBe(group.id);

		// Session cleanup still works after the restart.
		await ann.page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(ann.page).toHaveURL(/\/login/u);
		await http(ann, 'get', '/api/v1/chats/unread', undefined, 401);
		await http(ann, 'get', '/api/v1/group-chats', undefined, 401);
		await http(ann, 'get', events(group), undefined, 401);
		expect((await ann.context.request.get(withImage.image_url)).status()).toBe(401);
	} finally {
		await dispose(all);
	}
});

for (const [label, viewport] of [
	['desktop', { width: 1280, height: 900 }],
	['360px', { width: 360, height: 800 }],
]) {
	test(`SN-A21 events, private messages and group chat are usable by keyboard at ${label}`, async ({
		browser,
		baseURL,
	}) => {
		test.setTimeout(180000);
		const all = await actors(browser, baseURL, ['Creator', 'Ann']);
		const [creator, ann] = all;
		try {
			for (const actor of all) await actor.page.setViewportSize(viewport);
			await follow(creator, ann);
			const group = await createGroup(creator);
			const creatorMem = await membership(creator, group);
			await admit(creator, group, ann);
			const long = `${'Unbroken'.repeat(30)} 👩🏽‍💻 ${'x'.repeat(150)}`;
			const event = await createEvent(
				creator,
				group,
				creatorMem,
				`Long ${'Title'.repeat(15)}`,
				long,
			);
			await sendDm(creator, ann, `${long}\nSecond line`);
			await sendRoom(creator, group, creatorMem, `${long}\nSecond line`);

			const controls = async (page, selector) => {
				for (const control of await page.locator(selector).all())
					expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			};
			// Events: list, detail, form.
			await ann.page.goto(`/groups/${group.id}/events`);
			await expect(ann.page.locator(`[data-event-id="${event.id}"]`)).toBeVisible();
			await noOverflow(ann.page);
			await controls(ann.page, '.events-section a.button, .events-section button');
			await ann.page.screenshot({ path: `.tmp/a21-events-${label}.png`, fullPage: true });
			await ann.page.goto(`/groups/${group.id}/events/${event.id}`);
			await expect(ann.page.locator('.event-choice')).toHaveCount(2);
			await ann.page.locator('.event-choice[data-choice="going"]').focus();
			await ann.page.keyboard.press('Enter');
			await expect(ann.page.locator('.event-response__status')).toHaveText(
				'Your answer is saved: Going.',
			);
			await noOverflow(ann.page);
			await controls(ann.page, '.event-choice');
			await ann.page.screenshot({ path: `.tmp/a21-event-${label}.png`, fullPage: true });
			await ann.page.goto(`/groups/${group.id}/events/new`);
			await ann.page.getByRole('button', { name: 'Schedule event' }).click();
			await noOverflow(ann.page);
			await controls(ann.page, '.event-form button, .event-form a.button');

			// Private messages: roster, thread, emoji picker.
			await ann.page.goto('/messages');
			await expect(
				ann.page.locator('.roster-list[aria-label="Conversations"] .roster-row'),
			).toHaveCount(1);
			await noOverflow(ann.page);
			await controls(ann.page, '.roster-row__link');
			await ann.page.screenshot({ path: `.tmp/a21-messages-${label}.png`, fullPage: true });
			await ann.page.goto(`/messages/${creator.account.id}`);
			await expect(ann.page.locator('.message[data-message-id]')).toHaveCount(1);
			await noOverflow(ann.page);
			await ann.page.getByRole('button', { name: 'Emoji' }).click();
			await noOverflow(ann.page);
			await controls(
				ann.page,
				'.message-composer button, .message-composer .file-button, .emoji-picker__item',
			);
			await ann.page.screenshot({ path: `.tmp/a21-conversation-${label}.png`, fullPage: true });

			// Group chat: group navigation, roster entry, room.
			await ann.page.goto(`/groups/${group.id}`);
			await noOverflow(ann.page);
			await controls(ann.page, '.group-nav a');
			await ann.page.goto('/messages');
			await expect(
				ann.page.locator('.roster-list[aria-label="Group chats"] .roster-row'),
			).toHaveCount(1);
			await noOverflow(ann.page);
			await ann.page.goto(`/groups/${group.id}/chat`);
			await expect(ann.page.locator('.message[data-message-id]')).toHaveCount(1);
			await noOverflow(ann.page);
			await ann.page.getByLabel(new RegExp(`^Message ${group.title}$`, 'u')).fill('Keyboard reply');
			await ann.page.keyboard.press('Enter');
			await expect(ann.page.locator('.message--mine').last()).toContainText('Keyboard reply');
			await controls(ann.page, '.message-composer button, .group-nav a');
			await ann.page.screenshot({ path: `.tmp/a21-room-${label}.png`, fullPage: true });
		} finally {
			await dispose(all);
		}
	});
}
