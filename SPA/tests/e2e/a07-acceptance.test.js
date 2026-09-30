import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const fixtures = resolve('SPA/tests/fixtures/a07');
const password = 'correct horse battery';
const account = (prefix) => ({
	email: `a07-${prefix}-${randomUUID()}@example.com`,
	password,
	firstName: 'Ada',
	lastName: 'Lovelace',
	dateOfBirth: '1998-03-14',
});

async function fillRegistration(page, user, options = {}) {
	await page.goto('/register');
	await page.getByLabel('Email').fill(user.email);
	await page.getByLabel('Password').fill(user.password);
	await page.getByLabel('First name').fill(user.firstName);
	await page.getByLabel('Last name').fill(user.lastName);
	await page.getByLabel('Date of birth').fill(user.dateOfBirth);
	if (options.nickname) await page.getByLabel('Nickname').fill(options.nickname);
	if (options.aboutMe) await page.getByLabel('About me').fill(options.aboutMe);
	if (options.avatar) await page.locator('input[name="avatar"]').setInputFiles(options.avatar);
}

async function createAccount(page, user, options = {}) {
	await fillRegistration(page, user, options);
	await page.getByRole('button', { name: 'Create my account' }).click();
	await expect(page.locator('.registration-success')).toContainText(
		`Welcome, ${options.nickname || 'Ada Lovelace'}.`,
	);
	await page.getByRole('link', { name: 'Continue home' }).click();
	await expect(page.locator('[data-screen="home"]')).toContainText(
		options.nickname || 'Ada Lovelace',
	);
}

async function currentAccount(page) {
	const response = await page.evaluate(async () => {
		const result = await fetch('/api/v1/users/me', { credentials: 'include' });
		return { status: result.status, body: await result.json() };
	});
	expect(response.status).toBe(200);
	return response.body.data;
}

async function signOut(page) {
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.locator('[data-screen="home"]')).toHaveCount(0);
}

test('required-only registration, invalid and valid login, protected entry and logout replay', async ({
	page,
	context,
	request,
}) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await expect(page.locator('[data-screen="home"]')).toHaveCount(0);

	const user = account('required');
	await createAccount(page, { ...user, email: user.email.toUpperCase() });
	const profile = await currentAccount(page);
	expect(profile).toMatchObject({
		email: user.email,
		nickname: null,
		about_me: null,
		display_name: 'Ada Lovelace',
		avatar_url: null,
	});
	const cookie = (await context.cookies()).find(({ name }) => name === 'session_token');
	expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false, path: '/' });
	expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 399 * 24 * 60 * 60);
	await page.goto('/?from=protected');
	await expect(page.locator('[data-screen="home"]')).toBeVisible();
	await signOut(page);
	await page.goBack();
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await expect(page.locator('[data-screen="home"]')).toHaveCount(0);
	await page.goto('/');
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await expect(page.locator('[data-screen="home"]')).toHaveCount(0);
	expect(
		(
			await request.get('/api/v1/users/me', {
				headers: { Cookie: `session_token=${cookie.value}` },
			})
		).status(),
	).toBe(401);

	await page.getByLabel('Email').fill(user.email);
	await page.getByLabel('Password').fill('wrong-password');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toContainText('wasn’t recognized');
	await page.getByLabel('Password').fill(user.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.locator('[data-screen="home"]')).toContainText('Ada Lovelace');
	await signOut(page);
});

for (const [extension, contentType] of [
	['jpg', 'image/jpeg'],
	['png', 'image/png'],
	['gif', 'image/gif'],
]) {
	test(`full registration stores a private ${extension.toUpperCase()} avatar`, async ({
		page,
		context,
		request,
	}) => {
		const user = account(extension);
		await createAccount(page, user, {
			nickname: 'Ada A',
			aboutMe: 'A real account',
			avatar: join(fixtures, `avatar.${extension}`),
		});
		const profile = await currentAccount(page);
		expect(profile).toMatchObject({
			email: user.email,
			nickname: 'Ada A',
			about_me: 'A real account',
			display_name: 'Ada A',
		});
		expect(profile.avatar_url).toMatch(/^\/api\/v1\/users\/\d+\/avatar$/);
		const avatar = await context.request.get(profile.avatar_url);
		expect(avatar.status()).toBe(200);
		expect(avatar.headers()['content-type']).toContain(contentType);
		expect(await avatar.body()).toEqual(readFileSync(join(fixtures, `avatar.${extension}`)));
		await signOut(page);
		expect((await request.get(profile.avatar_url)).status()).toBe(401);
		if (extension === 'png') {
			await createAccount(page, account('other-owner'));
			expect((await context.request.get(profile.avatar_url)).status()).toBe(404);
		}
	});
}

test('invalid avatar and duplicate email leave the first account intact', async ({ page }) => {
	const invalid = account('invalid-avatar');
	await fillRegistration(page, invalid);
	await page.locator('input[name="avatar"]').setInputFiles({
		name: 'invalid.png',
		mimeType: 'image/png',
		buffer: Buffer.from('not an image'),
	});
	await page.getByRole('button', { name: 'Create my account' }).click();
	await expect(page.locator('#avatar-error')).toContainText('valid JPEG, PNG or GIF');
	await expect(page.locator('[data-screen="register"]')).toBeVisible();
	await page.getByRole('button', { name: 'Clear image selection' }).click();
	await page.getByRole('button', { name: 'Create my account' }).click();
	await expect(page.locator('.registration-success')).toContainText('Welcome, Ada Lovelace.');
	await page.getByRole('link', { name: 'Continue home' }).click();
	await signOut(page);

	await fillRegistration(page, { ...invalid, email: invalid.email.toUpperCase() });
	await page.getByRole('button', { name: 'Create my account' }).click();
	await expect(page.getByRole('alert')).toContainText('Email is already registered');
	await page.goto('/login');
	await page.getByLabel('Email').fill(invalid.email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.locator('[data-screen="home"]')).toBeVisible();
});

test('persistent browser profile, backend recreation, avatar and repeated startup', async ({
	baseURL,
}) => {
	test.setTimeout(120000);
	if (!/^sn-b07-test-\d+$/u.test(process.env.COMPOSE_PROJECT_NAME || '')) {
		throw new Error('A07 container recreation requires the isolated make test-browser stack');
	}
	const profileDir = mkdtempSync(join(tmpdir(), 'sn-a07-browser-'));
	const user = account('reopen');
	let browserContext;
	try {
		browserContext = await chromium.launchPersistentContext(profileDir, { headless: true });
		let page = await browserContext.newPage();
		await createAccount(page, user, { avatar: join(fixtures, 'avatar.png') });
		const saved = await currentAccount(page);
		await browserContext.close();
		browserContext = null;

		browserContext = await chromium.launchPersistentContext(profileDir, { headless: true });
		page = await browserContext.newPage();
		await page.goto(baseURL);
		await expect(page.locator('[data-screen="home"]')).toContainText('Ada Lovelace');
		expect((await currentAccount(page)).id).toBe(saved.id);

		for (let restart = 0; restart < 2; restart += 1) {
			execFileSync(
				'docker',
				[
					'compose',
					'--env-file',
					'/dev/null',
					'-f',
					'compose.yaml',
					'up',
					'-d',
					'--no-deps',
					'--force-recreate',
					'--wait',
					'backend',
				],
				{ stdio: 'pipe', timeout: 120000 },
			);
			await page.reload();
			await expect(page.locator('[data-screen="home"]')).toContainText('Ada Lovelace');
			const restored = await currentAccount(page);
			expect(restored.id).toBe(saved.id);
			const avatar = await browserContext.request.get(restored.avatar_url);
			expect(avatar.status()).toBe(200);
			expect(avatar.headers()['content-type']).toContain('image/png');
			expect(await avatar.body()).toEqual(readFileSync(join(fixtures, 'avatar.png')));
		}
		await signOut(page);
	} finally {
		await browserContext?.close();
		rmSync(profileDir, { recursive: true, force: true });
	}
});

test('mobile keyboard path keeps registration usable with real services', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 800 });
	const user = account('mobile');
	await fillRegistration(page, user);
	await page.getByLabel('Email').focus();
	await expect(page.getByLabel('Email')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByLabel('Password')).toBeFocused();
	const size = await page.evaluate(() => ({
		client: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth,
	}));
	expect(size.scroll).toBeLessThanOrEqual(size.client);
	await page.getByRole('button', { name: 'Create my account' }).click();
	await expect(page.locator('.registration-success')).toContainText('Welcome, Ada Lovelace.');
	await page.getByRole('link', { name: 'Continue home' }).click();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
