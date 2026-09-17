// SPA/tests/e2e/chat.test.js
//
// Two-context chat E2E coverage (issue #68).
//
// The existing `tickets.test.js` suite only exercises Track A, so nothing
// verified the chat feature end-to-end in a real browser. These specs drive
// independent browser contexts — real second/third users, not a mocked socket —
// and cover the five behaviours the ticket calls out:
//
//   E2E-01  real-time DM delivery (no reload on the recipient)
//   E2E-02  presence transition (online -> offline when a peer disconnects)
//   E2E-03  roster reorder (an incoming DM lifts that peer to the top)
//   E2E-04  offline-composer disable
//   E2E-08  the OPEN conversation follows presence live (issue #50)
//   E2E-05  throttled history scroll (incremental paging, rate-limited)
//
// plus two that guard the roster contract the ticket also touches:
//
//   E2E-06  the username opens the DM; the profile link opens the profile
//   E2E-07  a fresh form login restores conversation history
//
// Auth always goes through the rendered forms rather than `page.request.post`,
// so the SPA's own submit path, session cookie, and post-login boot are part of
// what is under test.

import { expect, test } from '@playwright/test';

const PASSWORD = 'password123';

// Chat history pages in batches of 10 (see chat.conversation.api.js), and the
// scroll handler is throttled to 200ms with an 80px top threshold.
const HISTORY_PAGE_SIZE = 10;
const SCROLL_THROTTLE_MS = 200;

function createCredentials(prefix) {
	const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
		.toString(36)
		.padStart(2, '0')}`;
	const maxPrefixLength = Math.max(3, 30 - suffix.length - 1);
	const username = `${prefix.slice(0, maxPrefixLength)}_${suffix}`;
	return {
		username,
		email: `${username}@example.com`,
		password: PASSWORD,
		firstName: 'First',
		lastName: 'Last',
		age: 25,
		gender: 'other',
	};
}

// --- auth via the rendered forms -------------------------------------------

async function registerViaForm(page, credentials) {
	await page.goto('/register');
	await expect(page.locator('[data-screen="register"]')).toBeVisible();

	await page.fill('#reg-first-name', credentials.firstName);
	await page.fill('#reg-last-name', credentials.lastName);
	await page.fill('#reg-age', String(credentials.age));
	await page.selectOption('#reg-gender', credentials.gender);
	await page.fill('#reg-username', credentials.username);
	await page.fill('#reg-email', credentials.email);
	await page.fill('#reg-password', credentials.password);

	await page.click('#register-form button[type="submit"]');

	// A successful register creates the session and replaces into the shell.
	await expect.poll(() => new URL(page.url()).pathname).toBe('/');
	await expect(page.locator('[data-chat-roster]')).toBeVisible();
}

async function loginViaForm(page, credentials) {
	await page.goto('/login');
	await expect(page.locator('[data-screen="login"]')).toBeVisible();

	await page.fill('#login-identifier', credentials.username);
	await page.fill('#login-password', credentials.password);
	await page.click('#login-form button[type="submit"]');

	await expect.poll(() => new URL(page.url()).pathname).toBe('/');
	await expect(page.locator('[data-chat-roster]')).toBeVisible();
}

// --- roster / conversation helpers ------------------------------------------

function rosterRow(page, username) {
	return page.locator(`[data-roster-username="${username}"]`);
}

// Clicks the USERNAME TEXT, not the row's centre. This matters: the regression
// that motivated this suite only fires when the click lands on the username
// itself (a nested `a[data-link]` there is claimed by the global router handler
// as well as the roster's, so the DM opened and then routed away to /profile).
// Clicking the row's empty space misses that path entirely and passes either
// way, so always drive the roster through the name.
async function openConversationWith(page, username) {
	const row = rosterRow(page, username);
	await expect(row).toBeVisible({ timeout: 15000 });
	await row.locator('.chat-roster__name').click();

	await expect(page.locator('[data-conversation-view]')).toBeVisible();
	await expect(page.locator('.chat-conversation__title')).toHaveText(username);
	// Opening a conversation must not navigate away from the shell.
	expect(new URL(page.url()).pathname).toBe('/');
}

async function sendMessage(page, body) {
	const input = page.locator('[data-conversation-input]');
	await expect(input).toBeEnabled();
	await input.fill(body);
	await page.locator('[data-conversation-send]').click();
	// The composer clears once the frame is published.
	await expect(input).toHaveValue('');
}

function messageBodies(page) {
	return page.locator('[data-conversation-messages] .chat-conversation__body');
}

async function rosterOrder(page) {
	return page
		.locator('.chat-roster [data-roster-username]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-roster-username')));
}

// Registers a user in their own context and returns the live page.
async function newUser(browser, prefix) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const credentials = createCredentials(prefix);
	await registerViaForm(page, credentials);
	return { context, page, credentials };
}

test.describe('Chat E2E (two contexts)', () => {
	test('D04-E2E-01: a DM is delivered to an open conversation in real time', async ({
		browser,
	}) => {
		const alice = await newUser(browser, 'alice');
		const bob = await newUser(browser, 'bob');

		try {
			// Alice registered before Bob existed, so refresh her roster.
			await alice.page.reload();

			await openConversationWith(alice.page, bob.credentials.username);
			await openConversationWith(bob.page, alice.credentials.username);

			const body = 'real-time hello';
			await sendMessage(alice.page, body);

			// Bob never reloads — the message must arrive over the socket.
			await expect(messageBodies(bob.page).last()).toHaveText(body, { timeout: 15000 });

			// And it is attributed to Alice, with a timestamp (audit Q15).
			const incoming = bob.page.locator('[data-conversation-messages] li').last();
			await expect(incoming.locator('.chat-conversation__sender')).toHaveText(
				alice.credentials.username,
			);
			await expect(incoming.locator('.chat-conversation__time')).not.toHaveText('');

			// Alice sees her own message rendered as outgoing.
			await expect(
				alice.page.locator('[data-conversation-messages] .chat-conversation__message--own'),
			).toHaveCount(1);
		} finally {
			await alice.context.close();
			await bob.context.close();
		}
	});

	test('D04-E2E-02: presence flips to offline when the peer disconnects', async ({ browser }) => {
		const alice = await newUser(browser, 'presa');
		const bob = await newUser(browser, 'presb');

		try {
			await alice.page.reload();

			const bobRow = rosterRow(alice.page, bob.credentials.username);
			await expect(bobRow).toHaveAttribute('data-roster-online', 'true', { timeout: 15000 });

			// Dropping Bob's context closes his socket; the hub broadcasts the
			// transition and Alice's roster must react without a reload.
			await bob.context.close();

			await expect(bobRow).toHaveAttribute('data-roster-online', 'false', { timeout: 15000 });
		} finally {
			await alice.context.close();
		}
	});

	test('D04-E2E-03: an incoming DM lifts that peer to the top of the roster', async ({
		browser,
	}) => {
		const alice = await newUser(browser, 'orda');
		const bob = await newUser(browser, 'ordb');
		const carol = await newUser(browser, 'ordc');

		try {
			await alice.page.reload();
			await expect(rosterRow(alice.page, carol.credentials.username)).toBeVisible({
				timeout: 15000,
			});

			const before = await rosterOrder(alice.page);
			expect(before).toContain(bob.credentials.username);
			expect(before).toContain(carol.credentials.username);

			// Carol messages Alice. Alice is on the feed and does not reload.
			await openConversationWith(carol.page, alice.credentials.username);
			await sendMessage(carol.page, 'bumping to the top');

			await expect
				.poll(async () => (await rosterOrder(alice.page))[0], { timeout: 15000 })
				.toBe(carol.credentials.username);
		} finally {
			await alice.context.close();
			await bob.context.close();
			await carol.context.close();
		}
	});

	test('D04-E2E-04: the composer is disabled for an offline peer', async ({ browser }) => {
		const alice = await newUser(browser, 'offa');
		const bob = await newUser(browser, 'offb');

		try {
			await alice.page.reload();
			const bobRow = rosterRow(alice.page, bob.credentials.username);
			await expect(bobRow).toHaveAttribute('data-roster-online', 'true', { timeout: 15000 });

			await bob.context.close();
			await expect(bobRow).toHaveAttribute('data-roster-online', 'false', { timeout: 15000 });

			await openConversationWith(alice.page, bob.credentials.username);

			await expect(alice.page.locator('[data-conversation-input]')).toBeDisabled();
			await expect(alice.page.locator('[data-conversation-send]')).toBeDisabled();
			await expect(alice.page.locator('[data-conversation-offline]')).toBeVisible();
		} finally {
			await alice.context.close();
		}
	});

	// Issue #50: the composer used to freeze at the presence the roster row had
	// when the conversation was opened. E2E-04 above only proves the disabled
	// state when the peer was ALREADY offline at open time; this one opens the
	// thread while the peer is online and never touches the roster again.
	test('D04-E2E-08: an open conversation follows presence without reselecting', async ({
		browser,
	}) => {
		const alice = await newUser(browser, 'liva');
		const bob = await newUser(browser, 'livb');

		try {
			await alice.page.reload();
			await openConversationWith(alice.page, bob.credentials.username);

			// Opened while Bob is online: the composer is usable.
			await expect(alice.page.locator('[data-conversation-input]')).toBeEnabled();
			await expect(alice.page.locator('[data-conversation-offline]')).toHaveCount(0);

			// Bob disconnects. Alice does not reload and does not re-click the row.
			await bob.context.close();

			await expect(alice.page.locator('[data-conversation-input]')).toBeDisabled({
				timeout: 15000,
			});
			await expect(alice.page.locator('[data-conversation-send]')).toBeDisabled();
			await expect(alice.page.locator('[data-conversation-offline]')).toBeVisible();
			await expect(alice.page.locator('[data-conversation-presence]')).toHaveText('offline');
		} finally {
			await alice.context.close();
		}
	});

	// A07 / D01: the profile must be reachable from the roster WITHOUT
	// cannibalising the row's own click. Both halves are asserted here because
	// the first regression shipped exactly by trading one for the other.
	test('D04-E2E-06: the roster opens a DM by name and the profile by its own link', async ({
		browser,
	}) => {
		const alice = await newUser(browser, 'lnka');
		const bob = await newUser(browser, 'lnkb');

		try {
			await alice.page.reload();

			// 1. The username opens the conversation and stays in the shell.
			await openConversationWith(alice.page, bob.credentials.username);
			await expect(rosterRow(alice.page, bob.credentials.username)).toHaveAttribute(
				'aria-pressed',
				'true',
			);

			// 2. The dedicated profile link routes to the profile.
			const row = rosterRow(alice.page, bob.credentials.username);
			const profileLink = row.locator('xpath=following-sibling::a[@data-roster-profile-link]');
			await expect(profileLink).toHaveCount(1);

			const href = await profileLink.getAttribute('href');
			expect(href).toMatch(/^\/profile\/\d+$/);

			await profileLink.click();
			await expect.poll(() => new URL(alice.page.url()).pathname).toBe(href);
			await expect(alice.page.locator('[data-screen="profile"]')).toBeVisible();
		} finally {
			await alice.context.close();
			await bob.context.close();
		}
	});

	// The ticket asks for auth through the rendered form specifically, so the
	// login path gets its own pass: a brand-new context signing in with the form
	// must land in the shell with its conversation history intact.
	test('D04-E2E-07: a fresh form login restores the conversation history', async ({ browser }) => {
		const alice = await newUser(browser, 'rela');
		const bob = await newUser(browser, 'relb');

		try {
			await alice.page.reload();
			await openConversationWith(alice.page, bob.credentials.username);
			await sendMessage(alice.page, 'message before signing out');
			await expect(messageBodies(alice.page).last()).toHaveText('message before signing out');

			// A clean context: no cookie, no in-memory state — only the form.
			const revisit = await browser.newContext();
			try {
				const page = await revisit.newPage();
				await loginViaForm(page, alice.credentials);

				await openConversationWith(page, bob.credentials.username);
				await expect(messageBodies(page).last()).toHaveText('message before signing out', {
					timeout: 15000,
				});
			} finally {
				await revisit.close();
			}
		} finally {
			await alice.context.close();
			await bob.context.close();
		}
	});

	// Audit Q16: "did the other user receive a notification?" The recipient here
	// is deliberately NOT reading the thread — that is the case the audit tests,
	// and the case that used to produce no visible signal at all.
	test('D04-E2E-09: a DM to a closed thread raises an unread badge', async ({ browser }) => {
		const alice = await newUser(browser, 'unra');
		const bob = await newUser(browser, 'unrb');

		try {
			await alice.page.reload();

			// Bob stays on the feed with no conversation open.
			await expect(bob.page.locator('[data-roster-unread-total]')).toHaveCount(0);

			await openConversationWith(alice.page, bob.credentials.username);
			await sendMessage(alice.page, 'you have mail');

			// Bob never reloads and never opens the thread.
			const aliceRow = rosterRow(bob.page, alice.credentials.username);
			await expect(aliceRow.locator('[data-roster-unread]')).toHaveText('1', { timeout: 15000 });
			await expect(aliceRow).toHaveClass(/chat-roster__item--unread/);

			// The roster-wide tally is what makes it visible when the row itself
			// is scrolled out of view.
			await expect(bob.page.locator('[data-roster-unread-total]')).toHaveText('1');

			await sendMessage(alice.page, 'and another');
			await expect(bob.page.locator('[data-roster-unread-total]')).toHaveText('2', {
				timeout: 15000,
			});

			// Opening the thread reads it.
			await openConversationWith(bob.page, alice.credentials.username);
			await expect(bob.page.locator('[data-roster-unread-total]')).toHaveCount(0);
			await expect(aliceRow.locator('[data-roster-unread]')).toHaveCount(0);

			// A message arriving in the thread Bob is reading is not news.
			await sendMessage(alice.page, 'read live');
			await expect(messageBodies(bob.page).last()).toHaveText('read live', { timeout: 15000 });
			await expect(bob.page.locator('[data-roster-unread-total]')).toHaveCount(0);
		} finally {
			await alice.context.close();
			await bob.context.close();
		}
	});

	test('D04-E2E-05: history pages in on scroll, throttled', async ({ browser }) => {
		test.slow();

		const alice = await newUser(browser, 'hista');
		const bob = await newUser(browser, 'histb');

		try {
			await alice.page.reload();
			await openConversationWith(alice.page, bob.credentials.username);
			await openConversationWith(bob.page, alice.credentials.username);

			// Seed more than one page so `has_more` is true. DMs are WebSocket-only
			// (there is no REST create endpoint), so these go through the composer.
			const total = HISTORY_PAGE_SIZE + 4;
			for (let i = 1; i <= total; i += 1) {
				await sendMessage(alice.page, `seeded message ${i}`);
			}
			await expect(messageBodies(alice.page)).toHaveCount(total, { timeout: 20000 });

			// Reload so only the newest page is present.
			await alice.page.reload();
			await openConversationWith(alice.page, bob.credentials.username);
			await expect(messageBodies(alice.page)).toHaveCount(HISTORY_PAGE_SIZE, { timeout: 15000 });

			// Count paging requests to prove the scroll handler is rate-limited.
			let historyRequests = 0;
			alice.page.on('request', (request) => {
				if (request.url().includes('before_id=')) {
					historyRequests += 1;
				}
			});

			// Burst of scrolls well inside one throttle window.
			const scroll = alice.page.locator('[data-conversation-scroll]');
			for (let i = 0; i < 8; i += 1) {
				await scroll.evaluate((el) => {
					el.scrollTop = 0;
					el.dispatchEvent(new Event('scroll'));
				});
			}

			// Older messages are prepended...
			await expect(messageBodies(alice.page)).toHaveCount(total, { timeout: 15000 });
			await expect(messageBodies(alice.page).first()).toHaveText('seeded message 1');

			// ...and the 8-scroll burst did not become 8 requests.
			await alice.page.waitForTimeout(SCROLL_THROTTLE_MS * 3);
			expect(historyRequests).toBeGreaterThan(0);
			expect(historyRequests).toBeLessThan(8);
		} finally {
			await alice.context.close();
			await bob.context.close();
		}
	});
});
