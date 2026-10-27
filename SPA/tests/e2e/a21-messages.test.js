import { expect, test } from '@playwright/test';
import {
	actors,
	dispose,
	errorCode,
	follow,
	http,
	indicator,
	png,
	privacy,
	trigger,
	unfollow,
	uuid,
} from './support/real-service.js';

// SN-A21: private messages across real services. Who may send follows accepted
// follows in either direction; who receives a live frame also depends on the
// recipient's own follow or public profile; stored delivery never depends on
// the recipient being online.
const message = (page, id) => page.locator(`.message[data-message-id="${id}"]`);
const field = (page) => page.getByLabel(/^Message /u);
const unreadLabel = (n) => `Messages, ${n} unread message${n === 1 ? '' : 's'}`;
const url = (other, tail = 'messages') => `/api/v1/chats/${other.account.id}/${tail}`;
const send = (from, to, body, extra = {}) =>
	http(from, 'post', url(to), { client_id: uuid(), body, ...extra }, 201);
async function history(actor, other) {
	return (await http(actor, 'get', `${url(other)}?limit=50`)).data.messages;
}
const unread = async (actor) =>
	(await http(actor, 'get', '/api/v1/chats/unread')).data.unread_count;
const noticeCount = async (actor) =>
	(await http(actor, 'get', '/api/v1/notifications')).data.unread_count;
const roster = async (actor) => (await http(actor, 'get', '/api/v1/chats?per_page=50')).data;
async function mediaStatus(actor, path) {
	const response = await actor.context.request.get(path);
	if (response.status() === 200) expect(await response.body()).toEqual(png);
	return response.status();
}
async function stage(actor, other) {
	const response = await actor.context.request.post(url(other, 'images'), {
		multipart: { image: { name: 'x.png', mimeType: 'image/png', buffer: png } },
	});
	return response;
}

// A pending request and no relationship never qualify, in either direction.
async function expectNoChat(sam, other) {
	await http(sam, 'get', url(other), undefined, 404);
	await http(sam, 'post', url(other), { client_id: uuid(), body: 'nope' }, 404);
	await http(other, 'get', url(sam), undefined, 404);
	await http(other, 'post', url(sam), { client_id: uuid(), body: 'nope' }, 404);
	expect((await roster(sam)).map((entry) => entry.user_id)).not.toContain(other.account.id);
	expect((await roster(other)).map((entry) => entry.user_id)).not.toContain(sam.account.id);
}
// Roster rows carry no email, avatar or internal fields; presence only when visible.
const ROSTER_KEYS = [
	'can_send',
	'last_message_at',
	'last_message_preview',
	'last_sender_id',
	'read_through_id',
	'unread_count',
	'user_id',
	'username',
];
function expectRosterShape(entries) {
	for (const entry of entries)
		expect(Object.keys(entry).sort()).toEqual(
			'is_online' in entry ? [...ROSTER_KEYS, 'is_online'].sort() : ROSTER_KEYS,
		);
}

test.describe('SN-A21 real private messages', () => {
	test.setTimeout(240000);

	test('the delivery matrix: only eligible pairs send, live follows the approved rule, strangers read nothing', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, [
			'Sam',
			'Pub',
			'Priv',
			'Mut',
			'Fan',
			'FanPriv',
			'Req',
			'Stranger',
		]);
		const [sam, pub, priv, mut, fan, fanPriv, req, stranger] = all;
		try {
			for (const actor of [priv, fanPriv, req]) await privacy(actor, 'private');
			await follow(sam, pub); // Sam -> public: accepted at once
			await follow(sam, priv); // Sam -> private: accepted by Priv; Priv does not follow back
			await follow(sam, mut);
			await follow(mut, sam); // mutual
			await follow(fan, sam); // recipient -> sender only; Fan is public
			await follow(fanPriv, sam); // recipient -> sender only; FanPriv is private
			const pending = await follow(sam, req, { accept: false });
			expect(pending.state).toBe('pending');

			// Everyone who can receive has a page open: they are online.
			for (const actor of [pub, priv, mut, fan, fanPriv]) await actor.page.goto('/people');
			for (const actor of [pub, priv, mut, fan, fanPriv])
				await expect(indicator(actor.page)).toHaveAttribute('aria-label', unreadLabel(0));

			for (const other of [req, stranger]) await expectNoChat(sam, other);
			expect(await unread(req)).toBe(0);

			// Sam writes to Pub from the keyboard in the browser: live for a public recipient.
			await sam.page.goto(`/messages/${pub.account.id}`);
			await field(sam.page).focus();
			await sam.page.keyboard.type('Hello Pub 👋');
			await sam.page.keyboard.press('Enter');
			await expect(sam.page.locator('.message--mine').last()).toContainText('Hello Pub 👋');
			await expect(indicator(pub.page)).toHaveAttribute('aria-label', unreadLabel(1));
			expect(await unread(pub)).toBe(1);
			// A message is not a notification.
			expect(await noticeCount(pub)).toBe(0);
			await expect(trigger(pub.page)).toContainText('0');

			// Every other eligible pair stores the message; live where the rule says so.
			for (const [name, to] of Object.entries({ mut, fan, fanPriv })) {
				await send(sam, to, `Hi ${name}`);
				await expect(indicator(to.page), name).toHaveAttribute('aria-label', unreadLabel(1));
			}
			// Priv is private and does not follow Sam: stored, but no live frame.
			await send(sam, priv, 'Hi Priv');
			expect(await unread(priv)).toBe(1);
			await priv.page.waitForTimeout(3000);
			await expect(indicator(priv.page)).toHaveAttribute('aria-label', unreadLabel(0));
			// Reloading fetches the stored message.
			await priv.page.reload();
			await expect(indicator(priv.page)).toHaveAttribute('aria-label', unreadLabel(1));

			// Priv answers: Sam is public, so Priv's reply is live for Sam.
			await sam.page.goto('/people');
			await expect(indicator(sam.page)).toHaveAttribute('aria-label', unreadLabel(0));
			await send(priv, sam, 'Hi back');
			await expect(indicator(sam.page)).toHaveAttribute('aria-label', unreadLabel(1));

			// Turning Priv public makes later messages live for Priv.
			await privacy(priv, 'public');
			await send(sam, priv, 'Now public');
			await expect(indicator(priv.page)).toHaveAttribute('aria-label', unreadLabel(2));
			await privacy(priv, 'private');

			// Presence needs profile access: Sam sees Priv (follows them) but not FanPriv.
			const rows = Object.fromEntries((await roster(sam)).map((entry) => [entry.user_id, entry]));
			expect(rows[priv.account.id].is_online).toBe(true);
			expect(rows[pub.account.id].is_online).toBe(true);
			expect('is_online' in rows[fanPriv.account.id]).toBe(false);
			expect(rows[fanPriv.account.id].can_send).toBe(true);
			expectRosterShape(Object.values(rows));

			// Strangers never see history through the UI either.
			await stranger.page.goto(`/messages/${sam.account.id}`);
			await expect(
				stranger.page.getByRole('heading', { name: 'This conversation isn’t available.' }),
			).toBeVisible();
			await expect(stranger.page.locator('main')).not.toContainText('Hello Pub');
			await expect(stranger.page.locator('form')).toHaveCount(0);
			// A third person cannot read a pair's history, even with a relationship to one side.
			await http(mut, 'get', url(pub), undefined, 404);
		} finally {
			await dispose(all);
		}
	});

	test('indicators stay distinct from notifications, survive reload and clear only on read; retries are exact', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Sam', 'Pub', 'Asker']);
		const [sam, pub, asker] = all;
		try {
			await privacy(pub, 'private');
			await follow(sam, pub);
			// A pending follow request is an unread notice for Pub; messages must not change it.
			await follow(asker, pub, { accept: false });
			const notices = await noticeCount(pub);
			expect(notices).toBeGreaterThan(0);
			const first = (await send(sam, pub, 'one')).data;
			const second = (await send(sam, pub, 'two')).data;
			const third = (await send(sam, pub, 'three')).data;
			expect(await unread(pub)).toBe(3);
			expect(await noticeCount(pub)).toBe(notices);
			// Fetching history does not read anything; Sam's own sends never count.
			await history(pub, sam);
			expect(await unread(pub)).toBe(3);
			expect(await unread(sam)).toBe(0);

			// Reload keeps the indicator.
			await pub.page.goto('/people');
			await expect(indicator(pub.page)).toHaveAttribute('aria-label', unreadLabel(3));
			await pub.page.reload();
			await expect(indicator(pub.page)).toHaveAttribute('aria-label', unreadLabel(3));

			// Cursor rules: valid, monotonic, only this pair's IDs, never invented ones.
			const read = (through) => http(pub, 'put', url(sam, 'read'), { through_id: through }, 200);
			expect((await read(first.id)).data).toEqual({ through_id: first.id, unread_count: 2 });
			expect((await read(0)).data).toEqual({ through_id: first.id, unread_count: 2 });
			const invented = await http(
				pub,
				'put',
				url(sam, 'read'),
				{ through_id: third.id + 1000 },
				400,
			);
			expect(invented.error.fields).toEqual({ through_id: 'INVALID_ID' });
			expect((await read(third.id)).data).toEqual({ through_id: third.id, unread_count: 0 });
			// An older ID after a newer one never moves the cursor back.
			expect((await read(second.id)).data).toEqual({ through_id: third.id, unread_count: 0 });
			expect(await unread(pub)).toBe(0);
			// A message committed after the cursor stays unread.
			const fourth = (await send(sam, pub, 'four')).data;
			expect(await unread(pub)).toBe(1);
			expect((await read(second.id)).data.unread_count).toBe(1);
			await pub.page.reload();
			await expect(indicator(pub.page)).toHaveAttribute('aria-label', unreadLabel(1));
			// Opening the conversation reads what it renders.
			await pub.page.goto(`/messages/${sam.account.id}`);
			await expect(message(pub.page, fourth.id)).toBeVisible();
			await expect(indicator(pub.page)).toHaveAttribute('aria-label', unreadLabel(0));
			expect(await unread(pub)).toBe(0);
			expect(await noticeCount(pub)).toBe(notices);

			// Exact retries: same nonce and payload returns the original with no new row.
			const nonce = uuid();
			const payload = { client_id: nonce, body: 'retry me' };
			const created = (await http(sam, 'post', url(pub), payload, 201)).data;
			const again = (await http(sam, 'post', url(pub), payload, 200)).data;
			expect(again).toEqual(created);
			expect(created.client_id).toBe(nonce);
			expect((await history(sam, pub)).filter((m) => m.client_id === nonce)).toHaveLength(1);
			// Pub had read everything, so the retried message is the only unread one, counted once.
			expect(await unread(pub)).toBe(1);
			// A different payload under the same nonce is a conflict; a new nonce is a new message.
			expect(
				await errorCode(sam, 'post', url(pub), { client_id: nonce, body: 'changed' }, 409),
			).toBe('MESSAGE_CONFLICT');
			await send(sam, pub, 'retry me');
			expect((await history(sam, pub)).filter((m) => m.body === 'retry me')).toHaveLength(2);
			expect(await unread(pub)).toBe(2);
			// A send without a nonce is refused, not stored.
			const missing = await http(sam, 'post', url(pub), { body: 'x' }, 400);
			expect(missing.error.fields.client_id).toBe('REQUIRED');
			// Pages are ascending and cover the whole history.
			const page = (await http(sam, 'get', `${url(pub)}?limit=2`)).data;
			expect(page.messages.map((m) => m.id)).toEqual(
				[...page.messages.map((m) => m.id)].sort((a, b) => a - b),
			);
			expect(page.has_more).toBe(true);
		} finally {
			await dispose(all);
		}
	});

	test('relationship changes revoke sending at once while history and committed images stay with the pair', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Sam', 'Pub', 'Third']);
		const [sam, pub, third] = all;
		try {
			const edge = await follow(sam, pub);
			await follow(third, sam);
			// An image goes through the browser: upload, preview, send from the keyboard.
			await sam.page.goto(`/messages/${pub.account.id}`);
			await sam.page.locator('#message-image').setInputFiles({
				name: 'board.png',
				mimeType: 'image/png',
				buffer: png,
			});
			await expect(sam.page.locator('.message-composer__preview img')).toBeVisible();
			await sam.page.getByRole('button', { name: 'Send' }).focus();
			await sam.page.keyboard.press('Enter');
			await expect(sam.page.locator('.message--mine img')).toHaveAttribute('src', /^blob:/u);
			const withImage = (await history(sam, pub)).find((m) => m.image_url);
			expect(withImage.image_url).toMatch(/^\/api\/v1\/media\/\d+$/u);
			// Committed bytes: both participants; nobody else.
			expect(await mediaStatus(sam, withImage.image_url)).toBe(200);
			expect(await mediaStatus(pub, withImage.image_url)).toBe(200);
			expect(await mediaStatus(third, withImage.image_url)).toBe(404);
			await pub.page.goto(`/messages/${sam.account.id}`);
			await expect(pub.page.locator('.message--theirs img')).toHaveAttribute('src', /^blob:/u);

			// A staged image is private to the uploader and bound to one recipient.
			const staged = await stage(sam, pub);
			expect(staged.status()).toBe(200);
			const image = (await staged.json()).data.image_url;
			expect(await mediaStatus(sam, image)).toBe(200);
			expect(await mediaStatus(pub, image)).toBe(404);
			expect(await mediaStatus(third, image)).toBe(404);
			const claim = (actor, to, extra) =>
				http(
					actor,
					'post',
					url(to),
					{ client_id: uuid(), body: 'x', image_url: image, ...extra },
					404,
				);
			await claim(third, sam);
			await claim(sam, third);
			expect(await mediaStatus(sam, image)).toBe(200);
			const claimed = (
				await http(sam, 'post', url(pub), { client_id: uuid(), body: '', image_url: image }, 201)
			).data;
			expect(claimed.image_url).toBeTruthy();
			// A claimed image cannot be reused in another new message.
			await claim(sam, pub);
			// A reference that is not a private media URL is a validation error, not a guess.
			const bad = await http(
				sam,
				'post',
				url(pub),
				{ client_id: uuid(), body: 'x', image_url: '/static/uploads/x.png' },
				400,
			);
			expect(bad.error.fields.image_url).toBe('INVALID_ID');

			// The page is open when Sam unfollows: the composer goes read-only, history stays.
			await pub.page.goto(`/messages/${sam.account.id}`);
			await field(pub.page).fill('half-typed');
			await unfollow(sam, pub, edge.id);
			await expect(field(pub.page)).toBeDisabled();
			await expect(pub.page.getByRole('button', { name: 'Send' })).toBeDisabled();
			await expect(pub.page.locator('.message[data-message-id]').first()).toBeVisible();
			// Server side: no sending or uploading either way; history and bytes remain.
			for (const [actor, other] of [
				[sam, pub],
				[pub, sam],
			]) {
				await http(actor, 'post', url(other), { client_id: uuid(), body: 'blocked' }, 404);
				expect((await stage(actor, other)).status()).toBe(404);
				expect((await history(actor, other)).length).toBe(2);
				const entry = (await roster(actor)).find((row) => row.user_id === other.account.id);
				expect(entry.can_send).toBe(false);
			}
			expect(await mediaStatus(pub, withImage.image_url)).toBe(200);
			expect(await mediaStatus(sam, withImage.image_url)).toBe(200);
			expect(await mediaStatus(third, withImage.image_url)).toBe(404);
			await pub.page.goto('/messages');
			await expect(pub.page.locator(`[data-user-id="${sam.account.id}"]`)).toContainText(
				'Read only',
			);

			// Refollowing restores sending; the history is the same.
			await follow(sam, pub);
			const after = await send(sam, pub, 'welcome back');
			expect(after.data.id).toBeGreaterThan(claimed.id);
			expect((await history(pub, sam)).length).toBe(3);
			await pub.page.goto(`/messages/${sam.account.id}`);
			await expect(field(pub.page)).toBeEnabled();
			await expect(message(pub.page, after.data.id)).toBeVisible();
		} finally {
			await dispose(all);
		}
	});

	test('offline sending, a failed send and a dropped connection recover once and in order', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Sam', 'Pub', 'Away']);
		const [sam, pub, away] = all;
		try {
			await follow(sam, pub);
			await follow(sam, away);
			// Away is not connected at all: the messages are stored and wait.
			await send(sam, away, 'while you were out');
			await send(sam, away, 'and another');
			expect(await unread(away)).toBe(2);
			await away.page.goto('/people');
			await expect(indicator(away.page)).toHaveAttribute('aria-label', unreadLabel(2));
			await away.page.goto('/messages');
			const row = away.page.locator(`[data-user-id="${sam.account.id}"]`);
			await expect(row.locator('.message-unread')).toHaveText('2');
			await expect(row).toContainText('and another');
			await row.locator('a').first().click();
			await expect(indicator(away.page)).toHaveAttribute('aria-label', unreadLabel(0));

			// Sam's browser goes offline: the send fails, keeps its nonce, retries once.
			await sam.page.goto(`/messages/${pub.account.id}`);
			await expect(field(sam.page)).toBeEnabled();
			await sam.context.setOffline(true);
			await field(sam.page).fill('typed while offline');
			await sam.page.keyboard.press('Enter');
			const failed = sam.page.locator('.message--failed');
			await expect(failed).toContainText('couldn’t confirm');
			const typed = async () =>
				(await history(pub, sam)).filter((m) => m.body === 'typed while offline');
			expect(await typed()).toHaveLength(0);
			await sam.context.setOffline(false);
			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(sam.page.locator('.message--pending')).toHaveCount(0);
			expect(await typed()).toHaveLength(1);

			// Pub's real socket drops frames and is then closed; the messages sent in
			// the meantime are recovered by the reconnect refetch, in order and once.
			const connections = [];
			let dropping = false;
			await pub.page.routeWebSocket(/\/ws$/u, (ws) => {
				const server = ws.connectToServer();
				server.onMessage((frame) => {
					if (!dropping) ws.send(frame);
				});
				connections.push(ws);
			});
			await pub.page.goto(`/messages/${sam.account.id}`);
			await expect(pub.page.locator('.message[data-message-id]').last()).toContainText(
				'typed while offline',
			);
			await expect.poll(() => connections.length).toBeGreaterThan(0);
			const opened = connections.length;
			dropping = true;
			const sent = [];
			for (let index = 1; index <= 3; index += 1)
				sent.push((await send(sam, pub, `while away ${index}`)).data.id);
			await pub.page.waitForTimeout(1500);
			await expect(pub.page.locator('.message', { hasText: 'while away 3' })).toHaveCount(0);
			dropping = false;
			await connections.at(-1).close();
			await expect.poll(() => connections.length, { timeout: 30000 }).toBeGreaterThan(opened);
			await expect(pub.page.locator('.message', { hasText: 'while away 3' })).toBeVisible({
				timeout: 30000,
			});
			const ids = await pub.page
				.locator('.message[data-message-id]')
				.evaluateAll((items) => items.map((item) => Number(item.dataset.messageId)));
			expect(ids).toEqual([...ids].sort((a, b) => a - b));
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of sent) expect(ids).toContain(id);
			await expect(indicator(pub.page)).toHaveAttribute('aria-label', unreadLabel(0));
		} finally {
			await dispose(all);
		}
	});

	test('signing out leaves no private messages for the next person', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, ['Sam', 'Pub']);
		const [sam, pub] = all;
		try {
			await follow(sam, pub);
			await send(sam, pub, 'Private note');
			await pub.page.goto(`/messages/${sam.account.id}`);
			await expect(pub.page.getByText('Private note')).toBeVisible();
			await field(pub.page).fill('draft for Sam');
			await pub.page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await expect(pub.page).toHaveURL(/\/login/u);
			await expect(pub.page.getByText('Private note')).toHaveCount(0);
			await expect(indicator(pub.page)).toHaveCount(0);
			await pub.page.goBack();
			await expect(pub.page.getByText('Private note')).toHaveCount(0);
			await pub.page.goto(`/messages/${sam.account.id}`);
			await expect(pub.page).toHaveURL(/\/login/u);
			await http(pub, 'get', url(sam), undefined, 401);
			await http(pub, 'get', '/api/v1/chats/unread', undefined, 401);
		} finally {
			await dispose(all);
		}
	});
});
