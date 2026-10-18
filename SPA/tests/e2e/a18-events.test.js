import { expect, test } from '@playwright/test';

import { installGroupFixtures } from '../fixtures/phase4/browser.js';
import { EventBackend } from '../fixtures/phase5/event-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application against the
// approved SN-B20 event model. SN-A21 owns real-service authorization,
// persistence and delivery.
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const card = (page, id) => page.locator(`[data-event-id="${id}"]`);
const choice = (page, value) => page.locator(`.event-choice[data-choice="${value}"]`);
const status = (page) => page.locator('.event-response__status');
const posts = (backend) =>
	backend.log.filter((entry) => entry.method === 'POST' && /\/events$/u.test(entry.path));

async function noHorizontalScroll(page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(1);
}

test.describe('SN-A18 fixture group events', () => {
	test('a member schedules and answers an event using only the keyboard', async ({ page }) => {
		const backend = new EventBackend();
		await installGroupFixtures(page, backend, { id: 7 });
		await page.goto('/groups/301/events');
		await expect(card(page, 702)).toBeVisible();
		await page.getByRole('link', { name: 'Schedule an event' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/301\/events\/new$/u);
		await page.getByRole('button', { name: 'Schedule event' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Title')).toBeFocused();
		await expect(page.getByText('Give the event a title.')).toBeVisible();
		await page.keyboard.type('Simul night');
		await page.keyboard.press('Tab');
		await page.keyboard.type('Ten boards, bring a clock.');
		await page.getByLabel('Day and time').fill('2099-11-05T19:30');
		await page.getByRole('button', { name: 'Schedule event' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/301\/events\/703$/u);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Simul night');
		await expect(
			page.getByText('Simul night is scheduled. Other members have been notified.'),
		).toBeVisible();
		expect(posts(backend)).toHaveLength(1);
		expect(posts(backend)[0].json.membership_id).toBe(502);

		await choice(page, 'going').focus();
		await page.keyboard.press('Space');
		await expect(status(page)).toHaveText('Your answer is saved: Going.');
		await expect(choice(page, 'going')).toHaveAttribute('aria-pressed', 'true');
		// Focus stays on the control that was used, so the answer can be changed.
		await expect(choice(page, 'going')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(choice(page, 'not_going')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(status(page)).toHaveText('Your answer is saved: Not going.');
		await expect(page.getByText('0 going · 1 not going')).toBeVisible();
		expect(backend.responses.get('703:502')).toMatchObject({ choice: 'not_going', version: 2 });
		// A reload shows the same answer and counts from the server, not from the page.
		await page.reload();
		await expect(choice(page, 'not_going')).toHaveAttribute('aria-pressed', 'true');
		await expect(choice(page, 'going')).toHaveAttribute('aria-pressed', 'false');
		await expect(page.getByText('0 going · 1 not going')).toBeVisible();
	});

	test('a new event reaches the other members’ notices live and opens the event', async ({
		page,
	}) => {
		const backend = new EventBackend();
		const { actAs } = await installGroupFixtures(page, backend, { id: 10 });
		await page.goto('/groups/301');
		const trigger = page.getByRole('button', { name: /^Notifications/u });
		await expect(trigger).toContainText('0');
		const created = actAs(42, 'POST', '/groups/301/events', {
			membership_id: 501,
			title: 'Lightning round',
			description: 'Five minute games',
			starts_at: '2099-12-01T18:00:00Z',
		});
		expect(created.status).toBe(201);
		await expect(trigger).toContainText('1');
		await trigger.click();
		const mine = [...backend.eventNotices.values()].find(
			(item) => item.event_id === created.body.data.id && item.recipient_id === 10,
		);
		const notice = page.locator(`[data-notice-id="${mine.id}"]`);
		await expect(notice).toContainText('Alex Example');
		await expect(notice).toContainText('Scheduled an event');
		await expect(notice.getByRole('button')).toHaveCount(1);
		await notice.getByRole('link', { name: 'See the event in Chess Club' }).click();
		await expect(page).toHaveURL(/\/groups\/301\/events\/703$/u);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lightning round');
		await choice(page, 'going').click();
		await expect(status(page)).toHaveText('Your answer is saved: Going.');
		expect(backend.responses.get('703:504')).toMatchObject({ choice: 'going', version: 1 });
	});

	test('counts follow other members live, a stale tab is refused and removal clears the page', async ({
		page,
	}) => {
		const backend = new EventBackend();
		const { actAs } = await installGroupFixtures(page, backend, { id: 7 });
		await page.goto('/groups/301/events/701');
		await expect(page.getByText('1 going · 0 not going')).toBeVisible();
		actAs(10, 'PUT', '/groups/301/events/701/response', {
			membership_id: 504,
			choice: 'not_going',
			expected_version: 0,
		});
		await expect(page.getByText('1 going · 1 not going')).toBeVisible();
		await expect(page.locator('.event-responses__item')).toHaveCount(2);

		// Another tab changed Ada's own answer and this one missed the signal.
		backend.request(7, 'PUT', '/api/v1/groups/301/events/701/response', {
			json: { membership_id: 502, choice: 'not_going', expected_version: 1 },
			headers: XHR,
		});
		backend.signals.length = 0;
		// This tab still believes Ada is going (version 1), so it offers Not going.
		await expect(choice(page, 'going')).toHaveAttribute('aria-pressed', 'true');
		await choice(page, 'not_going').click();
		await expect(status(page)).toContainText('Your answer changed somewhere else');
		await expect(status(page)).not.toContainText('Your answer is saved');
		await expect(choice(page, 'not_going')).toHaveAttribute('aria-pressed', 'true');

		actAs(42, 'DELETE', '/group-memberships/502');
		await expect(page.getByText('Only members can see group events.')).toBeVisible();
		await expect(page.getByText('Opening night')).toHaveCount(0);
		await expect(page.locator('.event-choice')).toHaveCount(0);
		await expect(page.locator('.event-responses')).toHaveCount(0);
	});

	for (const [id, role] of [
		[99, 'an outsider'],
		[8, 'a pending invitee'],
		[9, 'a pending requester'],
		[12, 'a departed member'],
	]) {
		test(`${role} reaches no event content through direct routes`, async ({ page }) => {
			const backend = new EventBackend();
			await installGroupFixtures(page, backend, { id });
			for (const route of [
				'/groups/301/events',
				'/groups/301/events/701',
				'/groups/301/events/new',
			]) {
				await page.goto(route, { waitUntil: 'domcontentloaded' });
				await expect(
					page.getByText(/Only members can (see group events|schedule events)\./u),
				).toBeVisible();
				await expect(page.getByText('Opening night')).toHaveCount(0);
				await expect(page.getByText('Bring a board')).toHaveCount(0);
				await expect(page.locator('form')).toHaveCount(0);
			}
			expect(backend.log.filter((entry) => /\/events/u.test(entry.path))).toHaveLength(0);
		});
	}

	test('signing out leaves no event content for the next account', async ({ page }) => {
		const backend = new EventBackend();
		const { viewer } = await installGroupFixtures(page, backend, { id: 7 });
		await page.goto('/groups/301/events');
		await expect(card(page, 701)).toBeVisible();
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login/u);
		viewer.id = 99;
		await page.goto('/groups/301/events', { waitUntil: 'domcontentloaded' });
		await expect(page.getByText('Only members can see group events.')).toBeVisible();
		await expect(page.getByText('Opening night')).toHaveCount(0);
	});

	test('outages show recoverable states and a reconnect refetches missed changes', async ({
		page,
	}) => {
		const backend = new EventBackend();
		const { sockets } = await installGroupFixtures(page, backend, { id: 10 });
		backend.faults.push({ method: 'GET', path: /\/events$/u, repeat: true });
		await page.goto('/groups/301/events');
		await expect(page.getByText('We can’t load the events right now.')).toBeVisible();
		await expect(card(page, 701)).toHaveCount(0);
		backend.faults.length = 0;
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(card(page, 701)).toBeVisible();
		// Lee is removed while the socket is down; reconnect clears the events.
		await expect.poll(() => sockets.length).toBeGreaterThan(0);
		backend.request(42, 'DELETE', '/api/v1/group-memberships/504', { headers: XHR });
		backend.signals.length = 0;
		await sockets.at(-1).close();
		await expect(page.getByText('Only members can see group events.')).toBeVisible({
			timeout: 15000,
		});
		await expect(card(page, 701)).toHaveCount(0);
	});

	test('a lost scheduling response is not resent and never duplicates the event', async ({
		page,
	}) => {
		const backend = new EventBackend();
		await installGroupFixtures(page, backend, { id: 42 });
		backend.faults.push({ method: 'POST', path: /\/events$/u, commit: true });
		await page.goto('/groups/301/events/new');
		await page.getByLabel('Title').fill('Lost response');
		await page.getByLabel('Description').fill('Kept');
		await page.getByLabel('Day and time').fill('2099-11-07T18:00');
		await page.getByRole('button', { name: 'Schedule event' }).click();
		await expect(page.getByText('nothing was resent', { exact: false })).toBeVisible();
		await expect(page.getByLabel('Title')).toHaveValue('Lost response');
		expect(posts(backend)).toHaveLength(1);
		await page.getByRole('link', { name: /Check the event list/u }).click();
		await expect(card(page, 703)).toHaveCount(1);
		expect(backend.events.size).toBe(3);
	});
});

test.describe('SN-A18 times are shown in the viewer’s zone', () => {
	test.use({ timezoneId: 'America/New_York', locale: 'en-GB' });

	test('an event reads in the viewer’s zone and a scheduled wall time is sent as an absolute instant', async ({
		page,
	}) => {
		const backend = new EventBackend();
		await installGroupFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/events/701');
		// 17:30 UTC in October 2099 is 13:30 in New York (daylight time).
		await expect(page.locator('.event-detail__when time')).toContainText('13:30');
		await expect(page.locator('.event-detail__when time')).toHaveAttribute(
			'datetime',
			'2099-10-20T17:30:00Z',
		);
		await page.goto('/groups/301/events/new');
		await expect(page.getByText(/Your time \(America\/New_York\)/u)).toBeVisible();
		await page.getByLabel('Title').fill('Zone check');
		await page.getByLabel('Description').fill('Read in New York');
		await page.getByLabel('Day and time').fill('2099-11-05T19:30');
		await page.getByRole('button', { name: 'Schedule event' }).click();
		await expect(page).toHaveURL(/\/events\/703$/u);
		expect(posts(backend)[0].json.starts_at).toBe(
			new Date('2099-11-05T19:30:00-05:00').toISOString().replace('.000Z', 'Z'),
		);
		await expect(page.locator('.event-detail__when time')).toContainText('19:30');
	});
});

test.describe('SN-A18 layouts', () => {
	test('360px and desktop layouts wrap long text and keep 44px controls', async ({ page }) => {
		const backend = new EventBackend();
		backend.events.get(701).title = 'Opening'.repeat(18);
		backend.events.get(701).description = `${'Tactics'.repeat(120)}\nSecond line`;
		const { viewer } = await installGroupFixtures(page, backend, { id: 7 });
		for (const width of [360, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			viewer.id = 7;
			await page.goto('/groups/301/events');
			await expect(card(page, 701)).toBeVisible();
			await noHorizontalScroll(page);
			for (const control of await page
				.locator('.events-section a.button, .events-section button')
				.all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a18-events-${width}.png`, fullPage: true });
			await page.goto('/groups/301/events/701');
			await expect(page.locator('.event-choice')).toHaveCount(2);
			await noHorizontalScroll(page);
			for (const control of await page.locator('.event-choice').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a18-event-${width}.png`, fullPage: true });
			await page.goto('/groups/301/events/new');
			await page.getByRole('button', { name: 'Schedule event' }).click();
			await noHorizontalScroll(page);
			for (const control of await page.locator('.event-form button, .event-form a.button').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a18-event-new-${width}.png`, fullPage: true });
		}
	});
});
