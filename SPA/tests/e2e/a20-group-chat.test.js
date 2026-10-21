import { expect, test } from '@playwright/test';
import { installChatFixtures } from '../fixtures/phase5/browser.js';
import { ChatBackend } from '../fixtures/phase5/chat-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application against the
// approved SN-B20 group-room model. SN-A21 owns real-service authorization,
// persistence and delivery.
const message = (page, id) => page.locator(`.message[data-message-id="${id}"]`);
const indicator = (page) => page.getByTestId('message-indicator');
const field = (page) => page.getByLabel(/^Message Chess Club$/u);
const groupNav = (page) => page.getByRole('navigation', { name: 'Chess Club sections' });
const sends = (backend) =>
	backend.log.filter(
		(entry) => entry.method === 'POST' && /\/groups\/301\/messages$/u.test(entry.path),
	);
const roomRequests = (backend) =>
	backend.log.filter((entry) => /\/groups\/301\/messages|\/group-chats(\?|$)/u.test(entry.path));
const nonce = (index) => `0000000${index}-0000-4000-8000-000000000000`;

async function noHorizontalScroll(page) {
	const overflow = await page.evaluate(() => {
		const width = document.documentElement.clientWidth;
		const wide = [...document.querySelectorAll('body *')]
			.filter((element) => element.getBoundingClientRect().right > width + 1)
			.slice(0, 6)
			.map(
				(element) =>
					`${element.tagName}.${element.className} right=${Math.round(element.getBoundingClientRect().right)} of ${width}`,
			);
		return { extra: document.documentElement.scrollWidth - width, wide };
	});
	expect(overflow.wide).toEqual([]);
	expect(overflow.extra).toBeLessThanOrEqual(1);
}

test.describe('SN-A20 fixture group chat', () => {
	test('a member opens the room from the group and writes, with emoji, using only the keyboard', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301');
		await groupNav(page).getByRole('link', { name: /^Chat/u }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/301\/chat$/u);
		await expect(page.getByRole('heading', { level: 1, name: 'Chess Club' })).toBeVisible();
		await expect(message(page, 803)).toContainText('I do ♟️');
		await expect(groupNav(page).getByRole('link', { name: 'Chat' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		// A room has no image control.
		await expect(page.locator('#message-image')).toHaveCount(0);

		await field(page).focus();
		await page.keyboard.type('Saturday works for me ');
		await page.getByRole('button', { name: 'Emoji' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('group', { name: 'Choose an emoji' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Grinning face' })).toBeFocused();
		await page.getByRole('button', { name: 'Thumbs up' }).focus();
		await page.keyboard.press('Space');
		await expect(field(page)).toBeFocused();
		await expect(field(page)).toHaveValue('Saturday works for me 👍');
		await page.keyboard.press('Enter');
		await expect(message(page, 804)).toContainText('Saturday works for me 👍');
		await expect(field(page)).toBeFocused();
		await expect(field(page)).toHaveValue('');
		expect(sends(backend)).toHaveLength(1);
		expect(sends(backend)[0].json.membership_id).toBe(501);

		// A reload reads the same room from the server.
		await page.reload();
		await expect(message(page, 804)).toContainText('Saturday works for me 👍');
		await expect(page.locator('.message--pending')).toHaveCount(0);
	});

	test('room messages arrive live, the indicator and tab follow, and notifications stay separate', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		const { actAs } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301');
		const notifications = page.getByRole('button', { name: /^Notifications/u });
		await expect(notifications).toContainText('2');
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 2 unread messages');
		await expect(groupNav(page).getByRole('link', { name: 'Chat' })).toBeVisible();

		actAs(10, 'POST', '/groups/301/messages', {
			membership_id: 504,
			client_id: nonce(1),
			body: 'Live from Lee',
		});
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 3 unread messages');
		await expect(
			groupNav(page).getByRole('link', { name: /^Chat, 1 unread message$/u }),
		).toBeVisible();
		await expect(notifications).toContainText('2');

		// The Messages page lists the room with its count.
		await indicator(page).click();
		await expect(page.locator('[data-group-id="301"] .message-unread')).toHaveText('1');
		await expect(page.locator('[data-group-id="301"]')).toContainText('Lee Example: Live from Lee');
		await page.locator('[data-group-id="301"] a').click();
		await expect(page).toHaveURL(/\/groups\/301\/chat$/u);
		await expect(message(page, 804)).toContainText('Live from Lee');
		// Opening the room reads it: only the group's part of the total goes.
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 2 unread messages');

		actAs(7, 'POST', '/groups/301/messages', {
			membership_id: 502,
			client_id: nonce(2),
			body: 'And Ada too',
		});
		await expect(message(page, 805)).toContainText('And Ada too');
		await expect(message(page, 805).locator('.message__who')).toHaveText('Ada Lovelace');
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 2 unread messages');
		await expect(notifications).toContainText('2');
		const ids = await page
			.locator('.message[data-message-id]')
			.evaluateAll((items) => items.map((item) => Number(item.dataset.messageId)));
		expect(ids).toEqual([801, 802, 803, 804, 805]);
		// Another member's name is only a name: no profile link in the room.
		await expect(page.locator('.message-list a')).toHaveCount(0);
	});

	test('a lost connection and an offline send recover without duplicates', async ({ page }) => {
		const backend = new ChatBackend();
		const { actAs, dropSockets, network } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/chat');
		await expect(message(page, 803)).toBeVisible();

		network.offline = true;
		await field(page).fill('typed while offline');
		await page.keyboard.press('Enter');
		const failed = page.locator('.message--failed');
		await expect(failed).toContainText('couldn’t confirm');
		expect(sends(backend)).toHaveLength(0);
		network.offline = false;
		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(message(page, 804)).toContainText('typed while offline');
		await expect(page.locator('.message--pending')).toHaveCount(0);
		expect(sends(backend)).toHaveLength(1);
		expect(backend.groupMessages.size).toBe(4);

		await dropSockets();
		for (let index = 1; index <= 3; index += 1)
			actAs(10, 'POST', '/groups/301/messages', {
				membership_id: 504,
				client_id: nonce(index),
				body: `while away ${index}`,
			});
		await expect(page.locator('.message', { hasText: 'while away 3' })).toBeVisible({
			timeout: 15000,
		});
		const ids = await page
			.locator('.message[data-message-id]')
			.evaluateAll((items) => items.map((item) => Number(item.dataset.messageId)));
		expect(ids).toEqual([801, 802, 803, 804, 805, 806, 807]);
	});

	test('an outage while opening the room shows a retry and nothing from the room', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		backend.faults.push({ method: 'GET', path: /\/groups\/301\/messages$/u, repeat: true });
		await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/chat');
		await expect(
			page.getByRole('heading', { name: 'We can’t open this group chat right now.' }),
		).toBeVisible();
		await expect(page.locator('.message-list')).toHaveCount(0);
		await expect(page.locator('form')).toHaveCount(0);
		await expect(page.getByText('I do ♟️')).toHaveCount(0);
		backend.faults.length = 0;
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(message(page, 803)).toBeVisible();
		await expect(field(page)).toBeVisible();
	});

	test('rapid sends keep their order with no duplicates', async ({ page }) => {
		const backend = new ChatBackend();
		await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/chat');
		await expect(message(page, 803)).toBeVisible();
		await field(page).focus();
		for (const text of ['one', 'two', 'three', 'four', 'five']) {
			await page.keyboard.type(text);
			await page.keyboard.press('Enter');
		}
		await expect(message(page, 808)).toContainText('five');
		const bodies = await page.locator('.message__body').allTextContents();
		expect(bodies.slice(-5)).toEqual(['one', 'two', 'three', 'four', 'five']);
		expect(sends(backend)).toHaveLength(5);
		expect(new Set(sends(backend).map((entry) => entry.json.client_id)).size).toBe(5);
		await expect(page.locator('.message--pending')).toHaveCount(0);
	});

	test('removal during an open room clears it, and readmission shows a fresh room', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		const { flushSignals } = await installChatFixtures(page, backend, { id: 10 });
		await page.goto('/groups/301/chat');
		await expect(message(page, 803)).toBeVisible();
		await field(page).fill('half-written thought');

		backend.removeMember(301, 10);
		backend.signal('social.invalidate', [10]);
		flushSignals();
		await expect(
			page.getByRole('heading', { name: 'Only members of Chess Club can chat here.' }),
		).toBeVisible();
		await expect(page.locator('form')).toHaveCount(0);
		await expect(page.locator('.message-list')).toHaveCount(0);
		await expect(page.getByText('half-written thought')).toHaveCount(0);
		await expect(page.getByText('I do ♟️')).toHaveCount(0);
		expect(sends(backend)).toHaveLength(0);

		// Back to the group and forward again: still no cached room.
		await page.getByRole('link', { name: 'About this group' }).click();
		await page.goBack();
		await expect(page).toHaveURL(/\/groups\/301\/chat$/u);
		await expect(
			page.getByRole('heading', { name: 'Only members of Chess Club can chat here.' }),
		).toBeVisible();
		await expect(page.getByText('I do ♟️')).toHaveCount(0);
		await expect(page.locator('.message-list')).toHaveCount(0);

		backend.admit(301, 10, []);
		backend.signal('social.invalidate', [10]);
		flushSignals();
		await expect(message(page, 803)).toContainText('I do ♟️');
		await expect(field(page)).toHaveValue('');
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 0 unread messages');
		await field(page).fill('back again');
		await page.keyboard.press('Enter');
		await expect(message(page, 804)).toContainText('back again');
		expect(sends(backend)).toHaveLength(1);
		expect(sends(backend)[0].json.membership_id).toBe(505);
	});

	test('invitees, requesters and outsiders see only the members-only notice', async ({ page }) => {
		const backend = new ChatBackend();
		const { viewer } = await installChatFixtures(page, backend, { id: 8 });
		for (const id of [8, 9, 99, 12]) {
			viewer.id = id;
			await page.goto('/groups/301/chat');
			await expect(
				page.getByRole('heading', { name: 'Only members of Chess Club can chat here.' }),
			).toBeVisible();
			await expect(page.locator('form')).toHaveCount(0);
			await expect(page.locator('.message-list')).toHaveCount(0);
			for (const text of ['Welcome to the club.', 'I do ♟️', 'Ada Lovelace', 'Lee Example'])
				await expect(page.getByText(text)).toHaveCount(0);
			await page.goto('/groups/301');
			await expect(page.locator('a[href="/groups/301/chat"]')).toHaveCount(0);
		}
		expect(roomRequests(backend).filter((entry) => !/unread$/u.test(entry.path))).toEqual([]);
		viewer.id = 42;
		await page.goto('/groups/999/chat');
		await expect(
			page.getByRole('heading', { name: 'This group chat isn’t available.' }),
		).toBeVisible();
	});

	test('signing out clears the room and drafts for the next person', async ({ page }) => {
		const backend = new ChatBackend();
		const { viewer } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/chat');
		await expect(message(page, 803)).toBeVisible();
		await field(page).fill('draft for the club');
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login/u);
		await expect(page.getByText('Welcome to the club.')).toHaveCount(0);
		await expect(page.getByTestId('message-indicator')).toHaveCount(0);
		await page.goBack();
		await expect(page.getByText('Welcome to the club.')).toHaveCount(0);
		await page.goto('/groups/301/chat');
		await expect(page).toHaveURL(/\/login/u);
		// The next account is not a member: no room, no draft.
		viewer.id = 99;
		await page.goto('/groups/301/chat');
		await expect(
			page.getByRole('heading', { name: 'Only members of Chess Club can chat here.' }),
		).toBeVisible();
		await expect(page.getByText('draft for the club')).toHaveCount(0);
	});

	test('360px and desktop layouts wrap long text and keep 44px controls', async ({ page }) => {
		const backend = new ChatBackend();
		backend.groupMessages.get(803).body =
			`${'Unbroken'.repeat(40)} 👩🏽‍💻 ${'x'.repeat(200)}\nSecond line`;
		backend.commitRoom(301, 10, { body: 'A fresh one' });
		backend.signals = [];
		const { viewer } = await installChatFixtures(page, backend, { id: 42 });
		for (const width of [360, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			viewer.id = 42;
			// Opening the room reads it, so each pass starts with one unread message.
			backend.groupCursors.set(501, 803);
			await page.goto('/groups/301');
			await expect(groupNav(page).getByRole('link', { name: /^Chat, 1 unread/u })).toBeVisible();
			await noHorizontalScroll(page);
			for (const control of await page.locator('.group-nav a').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.goto('/messages');
			await expect(page.locator('.roster-list[aria-label="Group chats"] .roster-row')).toHaveCount(
				1,
			);
			await noHorizontalScroll(page);
			for (const control of await page.locator('.roster-row__link').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a20-messages-${width}.png`, fullPage: true });
			await page.goto('/groups/301/chat');
			await expect(message(page, 803)).toBeVisible();
			await noHorizontalScroll(page);
			await page.getByRole('button', { name: 'Emoji' }).click();
			await noHorizontalScroll(page);
			for (const control of await page
				.locator('.message-composer button, .group-nav a, .emoji-picker__item')
				.all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a20-room-${width}.png`, fullPage: true });
		}
	});
});
