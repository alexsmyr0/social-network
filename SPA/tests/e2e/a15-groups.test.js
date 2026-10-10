import { expect, test } from '@playwright/test';

import { installGroupFixtures } from '../fixtures/phase4/browser.js';
import { GroupBackend } from '../fixtures/phase4/group-backend.js';

// HTTP and WebSocket fixtures exercise the shipped Vue application against the
// approved SN-B17 model. SN-A17 owns real-service authorization, persistence
// and delivery.
const groupCard = (page, id) => page.locator(`[data-group-id="${id}"]`);
const feedback = (page) => page.locator('.group-feedback');
const memberRows = (page) => page.locator('[data-membership-id]');

async function noHorizontalScroll(page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(1);
}

test.describe('SN-A15 fixture group discovery and membership', () => {
	test('keyboard creation validates, recovers and opens the new group as creator', async ({
		page,
	}) => {
		const backend = new GroupBackend();
		await installGroupFixtures(page, backend, { id: 8 });
		await page.goto('/groups');
		await page.getByRole('link', { name: 'Start a group' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/new$/u);
		await page.getByRole('button', { name: 'Create group' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByLabel('Name')).toBeFocused();
		await expect(page.getByText('Give the group a name.')).toBeVisible();
		await page.keyboard.type('Go Club');
		await page.getByLabel('Description').focus();
		await page.keyboard.type('Gophers and goroutines.');
		await page.getByRole('button', { name: 'Create group' }).focus();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\/303$/u);
		await expect(page.getByText('Go Club is ready.')).toBeVisible();
		await expect(page.getByText('1 member', { exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Join requests' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Leave group' })).toHaveCount(0);
		expect(backend.groups.get(303)).toMatchObject({ creator_id: 8, title: 'Go Club' });
	});

	test('an outsider requests by keyboard and the creator admits them from the notice', async ({
		page,
	}) => {
		const backend = new GroupBackend();
		const { viewer } = await installGroupFixtures(page, backend, { id: 99 });
		await page.goto('/groups');
		await page.getByLabel('Search groups by name').fill('chess');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/groups\?q=chess$/u);
		await expect(page.locator('[data-group-id]')).toHaveCount(1);
		await expect(groupCard(page, 301)).not.toContainText('member');
		await groupCard(page, 301).getByRole('button', { name: 'Request to join Chess Club' }).focus();
		await page.keyboard.press('Enter');
		await expect(feedback(page)).toContainText('Request sent.');
		await expect(groupCard(page, 301)).toContainText('Join request pending');
		viewer.id = 42;
		await page.goto('/groups/301');
		await page.getByRole('button', { name: /^Notifications/u }).click();
		const notice = page.locator('[data-notice-id="803"]');
		await expect(notice).toContainText('Asked to join');
		await notice
			.getByRole('button', { name: 'Accept Robin Example’s request to join Chess Club' })
			.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#notification-panel')).toContainText(
			'Robin Example joined Chess Club.',
		);
		await expect(notice).toContainText('Join request accepted');
		await page.keyboard.press('Escape');
		await expect(page.getByText('3 members', { exact: true })).toBeVisible();
		expect(backend.membershipOf(301, 99)).toBeTruthy();
	});

	test('an invitee accepts once, a stale invitation shows no false success, and leaving closes lists', async ({
		page,
	}) => {
		const backend = new GroupBackend();
		backend.request(42, 'POST', '/api/v1/groups/301/invitations', {
			json: { user_id: 8 },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		await installGroupFixtures(page, backend, { id: 8 });
		await page.goto('/groups');
		const list = page.getByRole('list', { name: 'Pending group invitations' });
		await expect(list.locator('[data-invitation-id]')).toHaveCount(2);
		// Ada (the inviter of 601) leaves while the page is open and Sam misses
		// the signal, so the now-stale button is still on screen.
		backend.request(7, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		backend.signals.length = 0;
		await list
			.getByRole('button', { name: 'Accept invitation to Chess Club from Ada Lovelace' })
			.click();
		await expect(feedback(page)).toContainText('That invitation is no longer open.');
		await expect(feedback(page)).not.toContainText('joined');
		await expect(list.locator('[data-invitation-id]')).toHaveCount(1);
		await list
			.getByRole('button', { name: 'Accept invitation to Chess Club from Alex Example' })
			.dblclick();
		await expect(feedback(page)).toHaveText('You joined Chess Club.');
		expect(backend.log.filter((entry) => entry.method === 'PATCH')).toHaveLength(2);
		await page.goto('/groups/301/members');
		await expect(memberRows(page)).toHaveCount(2);
		await page.getByRole('link', { name: 'About' }).click();
		await page.getByRole('button', { name: 'Leave group' }).click();
		await page.getByRole('button', { name: 'Confirm leaving' }).click();
		await expect(feedback(page)).toContainText('You left Chess Club.');
		await page.goto('/groups/301/members');
		await expect(page.getByText('Only members can see who belongs.')).toBeVisible();
		await expect(memberRows(page)).toHaveCount(0);
	});

	test('creator removal signals the removed member, who returns only with a fresh request', async ({
		page,
	}) => {
		const backend = new GroupBackend();
		const { viewer, actAs } = await installGroupFixtures(page, backend, { id: 7 });
		await page.goto('/groups/301/members');
		await expect(memberRows(page)).toHaveCount(2);
		await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
		actAs(42, 'DELETE', '/group-memberships/502');
		await expect(page.getByText('Only members can see who belongs.')).toBeVisible();
		await expect(memberRows(page)).toHaveCount(0);
		await page.getByRole('link', { name: 'About this group' }).click();
		await page.getByRole('button', { name: 'Request to join Chess Club' }).click();
		await expect(page.getByText('Join request pending')).toBeVisible();
		viewer.id = 42;
		await page.goto('/groups/301/requests');
		await page.getByRole('button', { name: 'Accept join request from Ada Lovelace' }).click();
		await expect(feedback(page)).toHaveText('Ada Lovelace joined Chess Club.');
		await page.getByRole('link', { name: 'Members' }).click();
		await page.getByRole('button', { name: 'Remove Ada Lovelace from Chess Club' }).click();
		await page.getByRole('button', { name: 'Keep member' }).click();
		await expect(memberRows(page)).toHaveCount(2);
		const fresh = backend.membershipOf(301, 7).id;
		expect(fresh).not.toBe(502);
		expect(actAs(42, 'DELETE', '/group-memberships/502').status).toBe(409);
		await expect(memberRows(page)).toHaveCount(2);
	});

	test('direct routes and account switching disclose no member list or private details', async ({
		page,
	}) => {
		const backend = new GroupBackend();
		const { viewer } = await installGroupFixtures(page, backend, { id: 42 });
		await page.goto('/groups/301/members');
		await expect(page.locator('[data-membership-id="502"]')).toHaveAttribute(
			'data-access',
			'teaser',
		);
		await expect(page.locator('[data-membership-id="502"] img')).toHaveCount(0);
		await page.getByRole('button', { name: 'Sign out' }).click();
		await expect(page).toHaveURL(/\/login/u);
		viewer.id = 99;
		const before = backend.log.filter((entry) => entry.path.includes('/members')).length;
		await page.goto('/groups/301/members');
		await expect(page.getByText('Only members can see who belongs.')).toBeVisible();
		await expect(page.getByText('Ada Lovelace')).toHaveCount(0);
		await page.goto('/groups/301/requests');
		await expect(page.getByText('Only the creator reviews join requests.')).toBeVisible();
		expect(
			backend.log.filter(
				(entry) => entry.path.includes('/members') || entry.path.includes('/join-requests'),
			).length,
		).toBe(before);
	});

	test('outages show recoverable states and missed signals refetch on reconnect', async ({
		page,
	}) => {
		const backend = new GroupBackend();
		const { sockets } = await installGroupFixtures(page, backend, { id: 7 });
		backend.faults.push({ method: 'GET', path: /\/groups\/301$/u, repeat: true });
		await page.goto('/groups/301');
		await expect(page.getByText('We can’t load this group right now.')).toBeVisible();
		backend.faults.length = 0;
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(page.getByText('2 members', { exact: true })).toBeVisible();
		// The creator removes Ada while her socket is down; reconnect refetches.
		await expect.poll(() => sockets.length).toBeGreaterThan(0);
		backend.request(42, 'DELETE', '/api/v1/group-memberships/502', {
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		backend.signals.length = 0;
		await sockets.at(-1).close();
		await expect(page.getByRole('button', { name: 'Request to join Chess Club' })).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByRole('link', { name: 'Members' })).toHaveCount(0);
	});

	test('360px and desktop layouts wrap long names and keep 44px controls', async ({ page }) => {
		const backend = new GroupBackend();
		backend.groups.get(301).title = 'Chess'.repeat(20);
		backend.groups.get(301).description = 'Tactics'.repeat(140);
		backend.request(42, 'POST', '/api/v1/groups/301/invitations', {
			json: { user_id: 8 },
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		const { viewer } = await installGroupFixtures(page, backend, { id: 8 });
		for (const width of [360, 1280]) {
			await page.setViewportSize({ width, height: 900 });
			viewer.id = 8;
			await page.goto('/groups');
			await expect(groupCard(page, 301)).toBeVisible();
			await noHorizontalScroll(page);
			for (const control of await page.locator('.groups-view button, .groups-view a.button').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a15-groups-${width}.png`, fullPage: true });
			viewer.id = 42;
			await page.goto('/groups/301/members');
			await expect(memberRows(page)).toHaveCount(2);
			await page.getByRole('button', { name: /^Remove Ada/u }).click();
			await noHorizontalScroll(page);
			for (const control of await page.locator('.group-view button').all())
				expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
			await page.screenshot({ path: `.tmp/a15-group-${width}.png`, fullPage: true });
		}
	});
});
