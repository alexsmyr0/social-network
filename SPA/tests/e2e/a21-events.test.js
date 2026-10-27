import { expect, test } from '@playwright/test';
import {
	actors,
	admit,
	conflict,
	createGroup,
	dispose,
	errorCode,
	eventNotices,
	http,
	leave,
	membership,
	notices,
	remove,
	trigger,
} from './support/real-service.js';

// SN-A21: events, responses and event notices across real services. Group
// membership decides every outcome; follows and profile privacy do not.
const choice = (page, value) => page.locator(`.event-choice[data-choice="${value}"]`);
const status = (page) => page.locator('.event-response__status');
const future = (days) => new Date(Date.now() + days * 864e5).toISOString().replace(/\.\d+Z$/u, 'Z');

async function eventRoutes(actor, group, event, expected) {
	const base = `/api/v1/groups/${group.id}/events`;
	for (const path of [base, `${base}/${event.id}`, `${base}/${event.id}/responses`])
		await http(actor, 'get', path, undefined, expected);
}

test.describe('SN-A21 real events and event notices', () => {
	test.setTimeout(240000);

	test('creation notifies exactly the current members, responses persist and change, membership gates every surface', async ({
		browser,
		baseURL,
	}) => {
		const all = await actors(browser, baseURL, [
			'Creator',
			'Alice',
			'Bob',
			'Invitee',
			'Requester',
			'Outsider',
		]);
		const [creator, alice, bob, invitee, requester, outsider] = all;
		try {
			const group = await createGroup(creator);
			const aliceMem = await admit(creator, group, alice);
			const bobMem = await admit(creator, group, bob);
			const creatorMem = await membership(creator, group);
			// An invitation and a pending request are not membership.
			await http(
				creator,
				'post',
				`/api/v1/groups/${group.id}/invitations`,
				{ user_id: invitee.account.id },
				201,
			);
			await http(requester, 'post', `/api/v1/groups/${group.id}/join-requests`, undefined, 201);
			const before = {
				invitee: (await notices(invitee)).length,
				requester: (await notices(requester)).length,
				outsider: (await notices(outsider)).length,
			};

			// Members have the page open, so the notice must arrive live.
			await alice.page.goto(`/groups/${group.id}`);
			await expect(trigger(alice.page)).toBeVisible();
			const aliceBefore = (await notices(alice)).length;

			// The creator schedules with the keyboard.
			await creator.page.goto(`/groups/${group.id}/events`);
			await creator.page.getByRole('link', { name: 'Schedule an event' }).focus();
			await creator.page.keyboard.press('Enter');
			await expect(creator.page).toHaveURL(/\/events\/new$/u);
			await creator.page.getByLabel('Title').fill('Simul night');
			await creator.page.getByLabel('Description').fill('Ten boards, bring a clock.');
			await creator.page.getByLabel('Day and time').fill('2099-11-05T19:30');
			await creator.page.getByRole('button', { name: 'Schedule event' }).focus();
			await creator.page.keyboard.press('Enter');
			await expect(creator.page).toHaveURL(/\/events\/\d+$/u);
			const eventId = Number(new URL(creator.page.url()).pathname.split('/').at(-1));
			await expect(creator.page.getByRole('heading', { level: 1 })).toHaveText('Simul night');
			await expect(
				creator.page.getByText('Simul night is scheduled. Other members have been notified.'),
			).toBeVisible();

			// Exactly the other current members got one notice each; nobody else did.
			expect(await eventNotices(alice, eventId)).toHaveLength(1);
			expect(await eventNotices(bob, eventId)).toHaveLength(1);
			expect(await eventNotices(creator, eventId)).toHaveLength(0);
			expect((await notices(invitee)).length).toBe(before.invitee);
			expect((await notices(requester)).length).toBe(before.requester);
			expect((await notices(outsider)).length).toBe(before.outsider);
			const stored = (await http(alice, 'get', `/api/v1/groups/${group.id}/events/${eventId}`))
				.data;
			expect(stored).toMatchObject({
				title: 'Simul night',
				starts_at: new Date('2099-11-05T19:30').toISOString().replace('.000Z', 'Z'),
				counts: { going: 0, not_going: 0 },
				viewer_response: null,
			});
			expect(stored.options).toEqual(['going', 'not_going']);

			// Alice's open page showed the notice without a reload; she follows it.
			await expect(trigger(alice.page)).toContainText(String(aliceBefore + 1));
			await trigger(alice.page).click();
			const noticeRow = alice.page
				.locator('#notification-panel [data-notice-id]')
				.filter({ hasText: 'Scheduled an event' })
				.first();
			await expect(noticeRow).toContainText(creator.name);
			await noticeRow.getByRole('link', { name: /^See the event in / }).click();
			await expect(alice.page).toHaveURL(new RegExp(`/groups/${group.id}/events/${eventId}$`, 'u'));
			await expect(alice.page.getByRole('heading', { level: 1 })).toHaveText('Simul night');

			// Alice answers from the keyboard and changes her mind; Bob answers over HTTP.
			await choice(alice.page, 'going').focus();
			await alice.page.keyboard.press('Space');
			await expect(status(alice.page)).toHaveText('Your answer is saved: Going.');
			await alice.page.keyboard.press('Tab');
			await expect(choice(alice.page, 'not_going')).toBeFocused();
			await alice.page.keyboard.press('Enter');
			await expect(status(alice.page)).toHaveText('Your answer is saved: Not going.');
			await expect(alice.page.getByText('0 going · 1 not going')).toBeVisible();
			const own = (await http(alice, 'get', `/api/v1/groups/${group.id}/events/${eventId}`)).data;
			expect(own.viewer_response).toEqual({ choice: 'not_going', version: 2 });

			// Bob's answer reaches Alice's open page without a reload.
			await http(
				bob,
				'put',
				`/api/v1/groups/${group.id}/events/${eventId}/response`,
				{ membership_id: bobMem.id, choice: 'going', expected_version: 0 },
				200,
			);
			await expect(alice.page.getByText('1 going · 1 not going')).toBeVisible();
			await expect(alice.page.locator('.event-responses__item')).toHaveCount(2);
			// A response writes no notice.
			expect(await eventNotices(alice, eventId)).toHaveLength(1);

			// A stale version is refused even when it repeats the same choice; a wrong
			// generation for a current member is refused; nothing is written either way.
			await conflict(
				bob,
				'put',
				`/api/v1/groups/${group.id}/events/${eventId}/response`,
				{ membership_id: bobMem.id, choice: 'going', expected_version: 0 },
				'STALE_EVENT_RESPONSE',
			);
			await conflict(
				bob,
				'put',
				`/api/v1/groups/${group.id}/events/${eventId}/response`,
				{ membership_id: bobMem.id + 999, choice: 'going', expected_version: 1 },
				'STALE_MEMBERSHIP',
			);
			expect(
				(await http(bob, 'get', `/api/v1/groups/${group.id}/events/${eventId}`)).data
					.viewer_response,
			).toEqual({ choice: 'going', version: 1 });
			expect(
				await errorCode(
					alice,
					'put',
					`/api/v1/groups/${group.id}/events/${eventId}/response`,
					{ membership_id: aliceMem.id, choice: 'maybe', expected_version: 2 },
					400,
				),
			).toBe('VALIDATION_ERROR');

			// Events are immutable and a past event stays readable and answerable.
			for (const method of ['patch', 'put', 'delete'])
				await http(creator, method, `/api/v1/groups/${group.id}/events/${eventId}`, {}, 405);
			const past = (
				await http(
					creator,
					'post',
					`/api/v1/groups/${group.id}/events`,
					{
						membership_id: creatorMem.id,
						title: 'Last year',
						description: 'Already over',
						starts_at: '2020-01-01T10:00:00Z',
					},
					201,
				)
			).data;
			await http(
				alice,
				'put',
				`/api/v1/groups/${group.id}/events/${past.id}/response`,
				{ membership_id: aliceMem.id, choice: 'going', expected_version: 0 },
				200,
			);
			// Creation has no replay guarantee: a repeat is a distinct event with new notices.
			const twin = (
				await http(
					creator,
					'post',
					`/api/v1/groups/${group.id}/events`,
					{
						membership_id: creatorMem.id,
						title: 'Last year',
						description: 'Already over',
						starts_at: '2020-01-01T10:00:00Z',
					},
					201,
				)
			).data;
			expect(twin.id).not.toBe(past.id);
			expect(await eventNotices(bob, twin.id)).toHaveLength(1);
			const list = (
				await http(alice, 'get', `/api/v1/groups/${group.id}/events?per_page=50`)
			).data.map((event) => event.id);
			expect(list).toEqual([past.id, twin.id, eventId]);

			// Everyone who is not a current member gets 404 on every event route.
			for (const actor of [invitee, requester, outsider]) {
				await eventRoutes(actor, group, stored, 404);
				await http(
					actor,
					'post',
					`/api/v1/groups/${group.id}/events`,
					{ membership_id: 1, title: 'x', description: 'x', starts_at: future(3) },
					404,
				);
				await http(
					actor,
					'put',
					`/api/v1/groups/${group.id}/events/${eventId}/response`,
					{ membership_id: 1, choice: 'going', expected_version: 0 },
					404,
				);
			}
			await outsider.page.goto(`/groups/${group.id}/events/${eventId}`);
			await expect(outsider.page.getByText('Only members can see group events.')).toBeVisible();
			await expect(outsider.page.locator('main')).not.toContainText('Simul night');
			// Notices do not leak either.
			expect((await notices(outsider)).filter((n) => n.target.kind === 'group_event')).toHaveLength(
				0,
			);

			// Removal: Alice's open page clears at once and her routes become 404.
			await remove(creator, aliceMem);
			await expect(alice.page.getByText('Only members can see group events.')).toBeVisible();
			await expect(alice.page.locator('main')).not.toContainText('Simul night');
			await eventRoutes(alice, group, stored, 404);
			expect(await eventNotices(alice, eventId)).toHaveLength(0);
			await http(
				alice,
				'put',
				`/api/v1/groups/${group.id}/events/${eventId}/response`,
				{ membership_id: aliceMem.id, choice: 'going', expected_version: 2 },
				404,
			);
			// Her stored answer is hidden from the members' counts and roster.
			const bobView = (await http(bob, 'get', `/api/v1/groups/${group.id}/events/${eventId}`)).data;
			expect(bobView.counts).toEqual({ going: 1, not_going: 0 });
			const roster = (
				await http(bob, 'get', `/api/v1/groups/${group.id}/events/${eventId}/responses`)
			).data;
			expect(roster.map((entry) => entry.user.id)).toEqual([bob.account.id]);

			// A member who joins later has the events but no retroactive notice.
			const late = (await actors(browser, baseURL, ['Late']))[0];
			all.push(late);
			await admit(creator, group, late);
			expect(
				(await http(late, 'get', `/api/v1/groups/${group.id}/events?per_page=50`)).data,
			).toHaveLength(3);
			expect((await notices(late)).filter((n) => n.target.kind === 'group_event')).toHaveLength(0);

			// Readmission: a fresh generation, the same notice back (not duplicated),
			// and the old answer does not return.
			const fresh = await admit(creator, group, alice);
			expect(fresh.id).not.toBe(aliceMem.id);
			expect(await eventNotices(alice, eventId)).toHaveLength(1);
			const back = (await http(alice, 'get', `/api/v1/groups/${group.id}/events/${eventId}`)).data;
			expect(back.viewer_response).toBeNull();
			expect(back.counts).toEqual({ going: 1, not_going: 0 });
			await conflict(
				alice,
				'put',
				`/api/v1/groups/${group.id}/events/${eventId}/response`,
				{ membership_id: aliceMem.id, choice: 'going', expected_version: 0 },
				'STALE_MEMBERSHIP',
			);
			await http(
				alice,
				'put',
				`/api/v1/groups/${group.id}/events/${eventId}/response`,
				{ membership_id: fresh.id, choice: 'going', expected_version: 0 },
				200,
			);

			// A departed event author's events stay for members; the author cannot read them.
			await leave(bob, bobMem);
			await eventRoutes(bob, group, stored, 404);
			expect(
				(await http(alice, 'get', `/api/v1/groups/${group.id}/events?per_page=50`)).data,
			).toHaveLength(3);
			expect(await eventNotices(bob, eventId)).toHaveLength(0);
		} finally {
			await dispose(all);
		}
	});
});
