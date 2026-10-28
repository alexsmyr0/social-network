import { expect, test } from '@playwright/test';
import {
	actors,
	admit,
	conflict,
	createGroup,
	dispose,
	errorCode,
	http,
	indicator,
	leave,
	membership,
	notices,
	remove,
	trigger,
	uuid,
} from './support/real-service.js';

// SN-A21: group rooms across real services. Current membership, and the exact
// membership generation, decide every outcome; follows and profile privacy do
// not widen a room, and a room never widens a profile.
const message = (page, id) => page.locator(`.message[data-message-id="${id}"]`);
const field = (page, group) => page.getByLabel(new RegExp(`^Message ${group.title}$`, 'u'));
const groupNav = (page, group) => page.getByRole('navigation', { name: `${group.title} sections` });
const unreadLabel = (n) => `Messages, ${n} unread message${n === 1 ? '' : 's'}`;
const room = (group, tail = 'messages') => `/api/v1/groups/${group.id}/${tail}`;
const send = (actor, group, mem, body, extra = {}) =>
	http(
		actor,
		'post',
		room(group),
		{ membership_id: mem.id, client_id: uuid(), body, ...extra },
		201,
	);
const history = async (actor, group) =>
	(await http(actor, 'get', `${room(group)}?limit=50`)).data.messages;
const unread = async (actor) =>
	(await http(actor, 'get', '/api/v1/group-chats/unread')).data.unread_count;
const dmUnread = async (actor) =>
	(await http(actor, 'get', '/api/v1/chats/unread')).data.unread_count;
const noticeCount = async (actor) =>
	(await http(actor, 'get', '/api/v1/notifications')).data.unread_count;
const rooms = async (actor) => (await http(actor, 'get', '/api/v1/group-chats?per_page=50')).data;

test.describe('SN-A21 real group chat', () => {
	test.setTimeout(240000);

	test('only current members read and write; delivery reaches every member session and indicators stay separate', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, [
			'Creator',
			'Ann',
			'Ben',
			'Invitee',
			'Requester',
			'Outsider',
		]);
		const [creator, ann, ben, invitee, requester, outsider] = all;
		try {
			const group = await createGroup(creator);
			const annMem = await admit(creator, group, ann);
			const benMem = await admit(creator, group, ben);
			const creatorMem = await membership(creator, group);
			await http(creator, 'post', room(group, 'invitations'), { user_id: invitee.account.id }, 201);
			await http(requester, 'post', room(group, 'join-requests'), undefined, 201);
			// Ann has a second browser session: both get the frame.
			const annSecond = await ann.context.newPage();

			// The room is empty for a new group and exists for every member.
			for (const [actor, mem] of [
				[creator, creatorMem],
				[ann, annMem],
				[ben, benMem],
			]) {
				expect((await history(actor, group)).length).toBe(0);
				const summary = (await rooms(actor)).find((entry) => entry.group.id === group.id);
				expect(summary).toMatchObject({
					group: { id: group.id, title: group.title },
					membership_id: mem.id,
					last_message: null,
					read_through_id: 0,
					unread_count: 0,
				});
			}

			// Ann's first page is the room; Ben's pages sit on the home page.
			await ann.page.goto(`/groups/${group.id}`);
			await annSecond.goto('/people');
			await ben.page.goto('/people');
			await expect(indicator(ben.page)).toHaveAttribute('aria-label', unreadLabel(0));

			// Creator writes from the group page with the keyboard.
			await creator.page.goto(`/groups/${group.id}`);
			await groupNav(creator.page, group).getByRole('link', { name: /^Chat/u }).focus();
			await creator.page.keyboard.press('Enter');
			await expect(creator.page).toHaveURL(new RegExp(`/groups/${group.id}/chat$`, 'u'));
			await expect(creator.page.locator('#message-image')).toHaveCount(0);
			await field(creator.page, group).focus();
			await creator.page.keyboard.type('Welcome to the club ♟️');
			await creator.page.keyboard.press('Enter');
			await expect(creator.page.locator('.message--mine').last()).toContainText('♟️');
			const first = (await history(creator, group))[0];
			expect(first).toMatchObject({
				group_id: group.id,
				sender_id: creator.account.id,
				body: 'Welcome to the club ♟️',
			});
			expect(Object.keys(first).sort()).toEqual(
				[
					'body',
					'client_id',
					'created_at',
					'group_id',
					'id',
					'sender_id',
					'sender_username',
				].sort(),
			);

			// Both of Ann's sessions and Ben's page show it live; the creator's own send is not unread.
			await expect(indicator(ben.page)).toHaveAttribute('aria-label', unreadLabel(1));
			await expect(indicator(annSecond)).toHaveAttribute('aria-label', unreadLabel(1));
			await expect(
				groupNav(ann.page, group).getByRole('link', { name: /^Chat, 1 unread message$/u }),
			).toBeVisible();
			expect(await unread(creator)).toBe(0);
			expect(await unread(ann)).toBe(1);
			// A room message is neither a notification nor a private message.
			expect(await dmUnread(ben)).toBe(0);
			await expect(trigger(ben.page)).toContainText(String(await noticeCount(ben)));
			expect((await notices(ben)).filter((n) => n.target.kind !== 'group_invitation').length).toBe(
				(await notices(ben)).length,
			);

			// Ben reads it by opening the room; only the room's part of the total goes.
			await ben.page.goto('/messages');
			await expect(ben.page.locator(`[data-group-id="${group.id}"] .message-unread`)).toHaveText(
				'1',
			);
			await ben.page.locator(`[data-group-id="${group.id}"] a`).first().click();
			await expect(message(ben.page, first.id)).toContainText('Welcome to the club');
			await expect(indicator(ben.page)).toHaveAttribute('aria-label', unreadLabel(0));
			expect(await unread(ben)).toBe(0);
			expect(await unread(ann)).toBe(1);
			await field(ben.page, group).fill('Glad to be here 👍');
			await ben.page.keyboard.press('Enter');
			await expect(ben.page.locator('.message--mine').last()).toContainText('👍');
			await expect(indicator(annSecond)).toHaveAttribute('aria-label', unreadLabel(2));
			await ann.page.goto(`/groups/${group.id}/chat`);
			const names = await ann.page.locator('.message__who').allTextContents();
			expect(names).toEqual([creator.name, ben.name]);
			await expect(indicator(ann.page)).toHaveAttribute('aria-label', unreadLabel(0));

			// Everyone who is not a current member gets 404 on every room route and sees
			// only the members-only notice in the browser.
			for (const actor of [invitee, requester, outsider]) {
				await http(actor, 'get', room(group), undefined, 404);
				await http(
					actor,
					'post',
					room(group),
					{ membership_id: annMem.id, client_id: uuid(), body: 'nope' },
					404,
				);
				await http(
					actor,
					'put',
					room(group, 'messages/read'),
					{ membership_id: annMem.id, through_id: first.id },
					404,
				);
				expect(await rooms(actor)).toEqual([]);
				expect(await unread(actor)).toBe(0);
				await actor.page.goto(`/groups/${group.id}/chat`);
				await expect(
					actor.page.getByRole('heading', {
						name: `Only members of ${group.title} can chat here.`,
					}),
				).toBeVisible();
				await expect(actor.page.locator('form')).toHaveCount(0);
				await expect(actor.page.locator('main')).not.toContainText('Welcome to the club');
			}
			// Another member's membership ID never authorizes a write.
			const borrowed = await ben.context.request.post(room(group), {
				data: { membership_id: annMem.id, client_id: uuid(), body: 'impersonate' },
			});
			expect(borrowed.ok()).toBe(false);
			expect((await history(ben, group)).map((m) => m.body)).not.toContain('impersonate');

			// Validation: a room accepts text only, bounded, with a UUID nonce.
			const bad = await http(
				ben,
				'post',
				room(group),
				{ membership_id: benMem.id, client_id: 'not-a-uuid', body: '   ' },
				400,
			);
			expect(bad.error.fields.client_id).toBe('INVALID_UUID');
			expect(bad.error.fields.body).toBe('CONTENT_REQUIRED');
			await http(
				ben,
				'post',
				room(group),
				{ membership_id: benMem.id, client_id: uuid(), body: 'x', image_url: '/api/v1/media/1' },
				400,
			);
			const long = await http(
				ben,
				'post',
				room(group),
				{ membership_id: benMem.id, client_id: uuid(), body: '😀'.repeat(2001) },
				400,
			);
			expect(long.error.fields.body).toBe('TOO_LONG');
			// 2000 code points are accepted.
			await send(ben, group, benMem, '😀'.repeat(2000));

			// Ben leaves the room page so what arrives next stays unread for him.
			await ben.page.goto('/people');
			// Exact retries share one result; a changed payload under a nonce conflicts.
			const nonce = uuid();
			const body = { membership_id: annMem.id, client_id: nonce, body: 'once only' };
			const created = (await http(ann, 'post', room(group), body, 201)).data;
			expect((await http(ann, 'post', room(group), body, 200)).data).toEqual(created);
			expect((await history(ben, group)).filter((m) => m.client_id === nonce)).toHaveLength(1);
			expect(await errorCode(ann, 'post', room(group), { ...body, body: 'different' }, 409)).toBe(
				'MESSAGE_CONFLICT',
			);

			// Cursor rules: this room's IDs only, monotonic, scoped to the membership.
			const read = (actor, mem, through, status = 200) =>
				http(
					actor,
					'put',
					room(group, 'messages/read'),
					{ membership_id: mem.id, through_id: through },
					status,
				);
			const before = await unread(ben);
			expect(before).toBeGreaterThan(0);
			expect((await read(ben, benMem, created.id)).data.unread_count).toBe(0);
			expect((await read(ben, benMem, first.id)).data.unread_count).toBe(0);
			await read(ben, benMem, created.id + 1000, 400);
			await conflict(
				ben,
				'put',
				room(group, 'messages/read'),
				{ membership_id: benMem.id + 999, through_id: created.id },
				'STALE_MEMBERSHIP',
			);
		} finally {
			await dispose(all);
		}
	});

	test('removal during an open room clears it at once; readmission shows a fresh generation with the whole history', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Creator', 'Ann', 'Ben']);
		const [creator, ann, ben] = all;
		try {
			const group = await createGroup(creator);
			const annMem = await admit(creator, group, ann);
			const benMem = await admit(creator, group, ben);
			const creatorMem = await membership(creator, group);
			const early = (await send(creator, group, creatorMem, 'Before Ann')).data;
			const annOwn = (await send(ann, group, annMem, 'Ann was here')).data;

			// Ann has the room open with a half-written draft when she is removed.
			await ann.page.goto(`/groups/${group.id}/chat`);
			await expect(message(ann.page, annOwn.id)).toBeVisible();
			await field(ann.page, group).fill('half-written thought');
			await remove(creator, annMem);
			await expect(
				ann.page.getByRole('heading', {
					name: `Only members of ${group.title} can chat here.`,
				}),
			).toBeVisible();
			await expect(ann.page.locator('form')).toHaveCount(0);
			await expect(ann.page.locator('.message-list')).toHaveCount(0);
			await expect(ann.page.locator('main')).not.toContainText('Before Ann');
			await expect(ann.page.locator('main')).not.toContainText('half-written thought');
			await expect(indicator(ann.page)).toHaveAttribute('aria-label', unreadLabel(0));
			// Server: no room data of any kind, even her own message; her old ID cannot write.
			await http(ann, 'get', room(group), undefined, 404);
			await http(
				ann,
				'post',
				room(group),
				{ membership_id: annMem.id, client_id: uuid(), body: 'late' },
				404,
			);
			expect(await rooms(ann)).toEqual([]);
			expect(await unread(ann)).toBe(0);
			// Back and forward still show no cached room.
			await ann.page.goto(`/groups/${group.id}`);
			await ann.page.goBack();
			await expect(
				ann.page.getByRole('heading', { name: `Only members of ${group.title} can chat here.` }),
			).toBeVisible();
			await expect(ann.page.getByText('Before Ann')).toHaveCount(0);

			// Contributions stay for the members, attributed to the departed author.
			const after = await history(ben, group);
			expect(after.map((m) => m.id)).toEqual([early.id, annOwn.id]);
			expect(after[1].sender_id).toBe(ann.account.id);
			// The room moves on while she is away; none of it reaches her.
			const missed = (await send(ben, group, benMem, 'You will not see this')).data;
			await http(ann, 'get', room(group), undefined, 404);

			// Readmission: new generation, the entire history, nothing unread, old ID stale.
			const fresh = await admit(creator, group, ann);
			expect(fresh.id).not.toBe(annMem.id);
			const back = await history(ann, group);
			expect(back.map((m) => m.id)).toEqual([early.id, annOwn.id, missed.id]);
			const summary = (await rooms(ann)).find((entry) => entry.group.id === group.id);
			expect(summary).toMatchObject({
				membership_id: fresh.id,
				read_through_id: missed.id,
				unread_count: 0,
			});
			expect(await unread(ann)).toBe(0);
			await conflict(
				ann,
				'post',
				room(group),
				{ membership_id: annMem.id, client_id: uuid(), body: 'stale' },
				'STALE_MEMBERSHIP',
			);
			await conflict(
				ann,
				'put',
				room(group, 'messages/read'),
				{ membership_id: annMem.id, through_id: missed.id },
				'STALE_MEMBERSHIP',
			);
			expect((await history(ann, group)).length).toBe(3);
			// The open page recovers by itself with no draft or stale state.
			await ann.page.goto(`/groups/${group.id}/chat`);
			await expect(message(ann.page, missed.id)).toContainText('You will not see this');
			await expect(field(ann.page, group)).toHaveValue('');
			await expect(indicator(ann.page)).toHaveAttribute('aria-label', unreadLabel(0));
			await field(ann.page, group).fill('back again');
			await ann.page.keyboard.press('Enter');
			await expect(ann.page.locator('.message--mine').last()).toContainText('back again');
			const sent = (await history(ben, group)).at(-1);
			expect(sent).toMatchObject({ sender_id: ann.account.id, body: 'back again' });

			// Leaving behaves like removal for the leaver, and the creator cannot leave.
			await ben.page.goto(`/groups/${group.id}/chat`);
			await expect(message(ben.page, sent.id)).toBeVisible();
			await leave(ben, benMem);
			await expect(
				ben.page.getByRole('heading', { name: `Only members of ${group.title} can chat here.` }),
			).toBeVisible();
			await expect(ben.page.locator('main')).not.toContainText('back again');
			await http(ben, 'get', room(group), undefined, 404);
			await conflict(
				creator,
				'delete',
				`/api/v1/group-memberships/${creatorMem.id}`,
				undefined,
				'CREATOR_CANNOT_LEAVE',
			);
		} finally {
			await dispose(all);
		}
	});

	test('a dropped socket during removal is recovered by reconnecting; signing out leaves nothing behind', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Creator', 'Ann']);
		const [creator, ann] = all;
		try {
			const group = await createGroup(creator);
			const annMem = await admit(creator, group, ann);
			const creatorMem = await membership(creator, group);
			const note = (await send(creator, group, creatorMem, 'Members only note')).data;
			const connections = [];
			let dropping = false;
			await ann.page.routeWebSocket(/\/ws$/u, (ws) => {
				const server = ws.connectToServer();
				server.onMessage((frame) => {
					if (!dropping) ws.send(frame);
				});
				connections.push(ws);
			});
			await ann.page.goto(`/groups/${group.id}/chat`);
			await expect(message(ann.page, note.id)).toBeVisible();
			await expect.poll(() => connections.length).toBeGreaterThan(0);
			const opened = connections.length;
			// Removal's frame never arrives, so the page still shows the room until it reconnects.
			dropping = true;
			await remove(creator, annMem);
			await ann.page.waitForTimeout(1500);
			await expect(message(ann.page, note.id)).toBeVisible();
			dropping = false;
			await connections.at(-1).close();
			await expect.poll(() => connections.length, { timeout: 30000 }).toBeGreaterThan(opened);
			await expect(
				ann.page.getByRole('heading', { name: `Only members of ${group.title} can chat here.` }),
			).toBeVisible({ timeout: 30000 });
			await expect(ann.page.getByText('Members only note')).toHaveCount(0);

			// Sign-out clears the room, the draft and the indicator for the next person.
			await creator.page.goto(`/groups/${group.id}/chat`);
			await expect(message(creator.page, note.id)).toBeVisible();
			await field(creator.page, group).fill('draft for the club');
			await creator.page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await expect(creator.page).toHaveURL(/\/login/u);
			await expect(creator.page.getByText('Members only note')).toHaveCount(0);
			await expect(indicator(creator.page)).toHaveCount(0);
			await creator.page.goBack();
			await expect(creator.page.getByText('Members only note')).toHaveCount(0);
			await creator.page.goto(`/groups/${group.id}/chat`);
			await expect(creator.page).toHaveURL(/\/login/u);
			await http(creator, 'get', room(group), undefined, 401);
			await http(creator, 'get', '/api/v1/group-chats', undefined, 401);
		} finally {
			await dispose(all);
		}
	});
});
