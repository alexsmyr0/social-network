import { expect, test } from '@playwright/test';
import { installChatFixtures } from '../fixtures/phase5/browser.js';
import { ChatBackend } from '../fixtures/phase5/chat-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application against the
// approved SN-B20 private-message model. SN-A21 owns real-service
// authorization, persistence and delivery.
const message = (page, id) => page.locator(`.message[data-message-id="${id}"]`);
const indicator = (page) => page.getByTestId('message-indicator');
const field = (page) => page.getByLabel(/^Message /u);
const sends = (backend) =>
	backend.log.filter((entry) => entry.method === 'POST' && /\/messages$/u.test(entry.path));
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

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

test.describe('SN-A19 fixture private messages', () => {
	test('a member opens a conversation and writes, with emoji, using only the keyboard', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/');
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 2 unread messages');
		await indicator(page).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/messages$/u);
		await expect(page.locator('.roster-row')).toHaveCount(3);
		await page.getByRole('link', { name: /Lee Example/u }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/messages\/10$/u);
		await expect(message(page, 504)).toBeVisible();
		// Opening the thread reads it: the indicator drops to zero.
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 0 unread messages');

		await field(page).focus();
		await page.keyboard.type('Yes, Friday works ');
		await page.getByRole('button', { name: 'Emoji' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('group', { name: 'Choose an emoji' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Grinning face' })).toBeFocused();
		await page.getByRole('button', { name: 'Thumbs up' }).focus();
		await page.keyboard.press('Space');
		await expect(field(page)).toBeFocused();
		await expect(field(page)).toHaveValue('Yes, Friday works 👍');
		await page.keyboard.press('Enter');
		await expect(message(page, 505)).toContainText('Yes, Friday works 👍');
		// Focus stays in the box so the next line can follow immediately.
		await expect(field(page)).toBeFocused();
		await expect(field(page)).toHaveValue('');
		expect(sends(backend)).toHaveLength(1);

		// A reload reads the same thread from the server.
		await page.reload();
		await expect(message(page, 505)).toContainText('Yes, Friday works 👍');
		await expect(page.locator('.message--pending')).toHaveCount(0);
	});

	test('messages arrive live, the indicator follows, and notifications stay separate', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		const { actAs } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/people');
		const notifications = page.getByRole('button', { name: /^Notifications/u });
		await expect(notifications).toContainText('2');
		await expect(indicator(page)).toContainText('2');
		const notificationBox = await notifications.boundingBox();
		const messageBox = await indicator(page).boundingBox();
		expect(notificationBox.x + notificationBox.width).toBeLessThanOrEqual(messageBox.x + 1);

		actAs(10, 'POST', '/chats/42/messages', {
			client_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			body: 'Live from Lee',
		});
		// The sender here is Lee, so the recipient (Alex) gets the live frame.
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 3 unread messages');
		await expect(notifications).toContainText('2');
		const colors = await page.evaluate(() => {
			const style = (selector) => getComputedStyle(document.querySelector(selector));
			return [
				style('.message-badge').backgroundColor,
				style('.notification-badge').backgroundColor,
			];
		});
		expect(colors[0]).not.toBe(colors[1]);

		await indicator(page).click();
		await expect(page.locator('[data-user-id="10"] .message-unread')).toHaveText('3');
		await page.getByRole('link', { name: /Lee Example/u }).click();
		await expect(page.locator('.message', { hasText: 'Live from Lee' })).toBeVisible();
		actAs(10, 'POST', '/chats/42/messages', {
			client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			body: 'And a second one',
		});
		await expect(page.locator('.message', { hasText: 'And a second one' })).toBeVisible();
		await expect(indicator(page)).toHaveAttribute('aria-label', 'Messages, 0 unread messages');
		await expect(notifications).toContainText('2');
		// Presence follows the partner.
		await expect(page.locator('.conversation-head .presence')).toHaveText('Online');
		backend.setOnline(10, false);
		actAs(10, 'GET', '/chats/unread');
		await expect(page.locator('.conversation-head .presence')).toHaveText('Offline');
	});

	test('a lost connection and an offline send recover without duplicates', async ({ page }) => {
		const backend = new ChatBackend();
		const { actAs, dropSockets, network } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/messages/10');
		await expect(message(page, 504)).toBeVisible();

		// Offline: the send fails, keeps its nonce and offers a retry.
		network.offline = true;
		await field(page).fill('typed while offline');
		await page.keyboard.press('Enter');
		const failed = page.locator('.message--failed');
		await expect(failed).toContainText('couldn’t confirm');
		expect(sends(backend)).toHaveLength(0);
		network.offline = false;
		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(message(page, 505)).toContainText('typed while offline');
		await expect(page.locator('.message--pending')).toHaveCount(0);
		expect(sends(backend)).toHaveLength(1);
		expect(backend.dms.size).toBe(5);

		// The socket drops and messages arrive while it is down; reconnecting
		// recovers all of them, in order, once.
		await dropSockets();
		for (let index = 1; index <= 3; index += 1)
			actAs(10, 'POST', '/chats/42/messages', {
				client_id: `0000000${index}-0000-4000-8000-000000000000`,
				body: `while away ${index}`,
			});
		await expect(page.locator('.message', { hasText: 'while away 3' })).toBeVisible({
			timeout: 15000,
		});
		const ids = await page
			.locator('.message[data-message-id]')
			.evaluateAll((items) => items.map((item) => Number(item.dataset.messageId)));
		expect(ids).toEqual([503, 504, 505, 506, 507, 508]);
	});

	test('rapid sends keep their order with no duplicates', async ({ page }) => {
		const backend = new ChatBackend();
		await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/messages/10');
		await expect(message(page, 504)).toBeVisible();
		await field(page).focus();
		for (const text of ['one', 'two', 'three', 'four', 'five']) {
			await page.keyboard.type(text);
			await page.keyboard.press('Enter');
		}
		await expect(message(page, 509)).toContainText('five');
		const bodies = await page.locator('.message__body').allTextContents();
		expect(bodies.slice(-5)).toEqual(['one', 'two', 'three', 'four', 'five']);
		expect(sends(backend)).toHaveLength(5);
		expect(new Set(sends(backend).map((entry) => entry.json.client_id)).size).toBe(5);
		await expect(page.locator('.message--pending')).toHaveCount(0);
	});

	test('losing the relationship turns sending off while history stays readable', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		const { actAs } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/messages/10');
		await expect(message(page, 504)).toBeVisible();
		await field(page).fill('unsent thought');
		// Lee stops following Alex: nobody follows anybody now.
		backend.setFollow(10, 42, 'none');
		actAs(42, 'GET', '/chats/unread');
		await expect(field(page)).toBeDisabled();
		await expect(page.getByText('You can’t message Lee Example any more.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
		await expect(message(page, 503)).toBeVisible();
		await expect(message(page, 504)).toBeVisible();
		expect(sends(backend)).toHaveLength(0);
		await page.goto('/messages');
		await expect(page.locator('[data-user-id="10"]')).toContainText('Read only');
	});

	test('strangers, pending requesters and other people’s threads disclose nothing', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		await installChatFixtures(page, backend, { id: 42 });
		for (const id of [9, 8, 99, 42, 12345]) {
			await page.goto(`/messages/${id}`);
			await expect(
				page.getByRole('heading', { name: 'This conversation isn’t available.' }),
			).toBeVisible();
			await expect(page.locator('form')).toHaveCount(0);
			await expect(page.locator('.message-list')).toHaveCount(0);
			for (const name of ['Pat Example', 'Sam Example', 'Robin Example'])
				await expect(page.getByText(name)).toHaveCount(0);
		}
		await page.goto('/messages');
		for (const name of ['Pat Example', 'Sam Example', 'Robin Example', 'Quinn Example'])
			await expect(page.getByText(name)).toHaveCount(0);
		// Another account's own conversation is not reachable through Alex's session.
		await page.goto('/messages/10');
		await expect(message(page, 503)).toBeVisible();
		expect(backend.log.filter((entry) => entry.method === 'POST')).toHaveLength(0);
	});

	test('signing out clears private messages, drafts and images for the next person', async ({
		page,
	}) => {
		const backend = new ChatBackend();
		const { viewer } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/messages/7');
		await expect(message(page, 502).locator('img')).toHaveAttribute('src', /^blob:/u);
		await field(page).fill('draft for Ada');
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login/u);
		await expect(page.getByText('Morning! Did you see the new rules?')).toHaveCount(0);
		await expect(page.getByTestId('message-indicator')).toHaveCount(0);
		// A direct visit lands on the sign-in page, not the thread.
		await page.goto('/messages/7');
		await expect(page).toHaveURL(/\/login/u);
		viewer.id = 10;
		await page.goto('/messages/7');
		// Lee follows Ada but has no history with her: an empty thread, no draft.
		await expect(field(page)).toHaveValue('');
		await expect(page.getByText('Morning! Did you see the new rules?')).toHaveCount(0);
	});

	test('images are staged privately, previewed and sent from the keyboard', async ({ page }) => {
		const backend = new ChatBackend();
		const { uploads } = await installChatFixtures(page, backend, { id: 42 });
		await page.goto('/messages/10');
		await expect(message(page, 504)).toBeVisible();
		await page.locator('#message-image').setInputFiles({
			name: 'board.png',
			mimeType: 'image/png',
			buffer: PNG,
		});
		await expect(page.locator('.message-composer__preview img')).toHaveAttribute('src', /^blob:/u);
		expect(uploads.map((part) => part.name)).toEqual(['image']);
		await page.getByRole('button', { name: 'Send' }).focus();
		await page.keyboard.press('Enter');
		await expect(message(page, 505).locator('img')).toHaveAttribute('src', /^blob:/u);
		await expect(message(page, 505).locator('.message__body')).toHaveCount(0);
		expect(sends(backend)[0].json.image_url).toBe('/api/v1/media/703');
		await page.reload();
		await expect(message(page, 505).locator('img')).toHaveAttribute('src', /^blob:/u);
		// The same image is not readable by a third account.
		const outsider = backend.request(99, 'GET', '/api/v1/media/703', {});
		expect(outsider.status).toBe(404);
	});

	test('360px and desktop layouts wrap long text and keep 44px controls', async ({ page }) => {
		const backend = new ChatBackend();
		backend.dms.get(504).body = `${'Unbroken'.repeat(40)} 👩🏽‍💻 ${'x'.repeat(200)}\nSecond line`;
		const { viewer } = await installChatFixtures(page, backend, { id: 42 });
		for (const width of [360, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			viewer.id = 42;
			await page.goto('/messages');
			await expect(page.locator('.roster-row')).toHaveCount(3);
			await noHorizontalScroll(page);
			for (const control of await page.locator('.roster-row__link').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a19-messages-${width}.png`, fullPage: true });
			await page.goto('/messages/10');
			await expect(message(page, 504)).toBeVisible();
			await noHorizontalScroll(page);
			await page.getByRole('button', { name: 'Emoji' }).click();
			await noHorizontalScroll(page);
			for (const control of await page
				.locator('.message-composer button, .message-composer .file-button, .emoji-picker__item')
				.all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a19-conversation-${width}.png`, fullPage: true });
		}
	});
});
