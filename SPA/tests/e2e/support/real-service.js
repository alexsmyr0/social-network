import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

// Shared by the SN-A21 journeys: real browsers, cookies, HTTP and sockets
// through the two isolated images. Nothing here mocks a route or a frame.
export const png = readFileSync('SPA/tests/fixtures/a07/avatar.png');
export const password = 'correct horse battery';
const writeHeaders = (baseURL) => ({ Origin: baseURL, 'X-Requested-With': 'XMLHttpRequest' });
export const uuid = () => randomUUID();

export async function http(actor, method, path, data, expected = 200) {
	const response = await actor.context.request[method](path, data === undefined ? {} : { data });
	expect(response.status(), `${actor.role} ${method} ${path}`).toBe(expected);
	expect(response.headers()['cache-control'], path).toContain('no-store');
	return expected === 204 ? null : response.json();
}
export async function errorCode(actor, method, path, data, status) {
	const body = await http(actor, method, path, data, status);
	return body.error.code;
}
export const conflict = async (actor, method, path, data, code) =>
	expect(await errorCode(actor, method, path, data, 409), `${actor.role} ${method} ${path}`).toBe(
		code,
	);

export async function actors(browser, baseURL, roles, prefix = 'A21') {
	const suffix = uuid().slice(0, 8);
	const all = [];
	try {
		for (const role of roles) {
			const context = await browser.newContext({
				baseURL,
				extraHTTPHeaders: writeHeaders(baseURL),
			});
			const actor = {
				context,
				role,
				name: `${prefix} ${role} ${suffix}`,
				email: `${prefix.toLowerCase()}-${role.toLowerCase()}-${suffix}@example.com`,
			};
			all.push(actor);
			const response = await context.request.post('/api/v1/users/register', {
				data: {
					email: actor.email,
					password,
					first_name: role,
					last_name: 'Acceptance',
					date_of_birth: '1998-03-14',
					nickname: actor.name,
					about_me: `Protected biography ${suffix}`,
				},
			});
			expect(response.status()).toBe(201);
			actor.account = (await response.json()).data;
			actor.page = await context.newPage();
		}
		return all;
	} catch (error) {
		await dispose(all);
		throw error;
	}
}
export const dispose = (all) => Promise.all(all.map((actor) => actor.context.close()));

export async function privacy(actor, visibility) {
	const current = (await http(actor, 'get', `/api/v1/users/${actor.account.id}/profile`)).data;
	await http(actor, 'patch', '/api/v1/users/me/privacy', {
		visibility,
		expected_version: current.profile.version,
	});
}
// `from` follows `to`; accepted immediately for a public account, otherwise
// the target accepts the pending request.
export async function follow(from, to, { accept = true } = {}) {
	const response = await from.context.request.post('/api/v1/follows', {
		data: { user_id: to.account.id },
	});
	expect([200, 201]).toContain(response.status());
	const request = (await response.json()).data;
	if (request.state === 'pending' && accept)
		await http(to, 'patch', `/api/v1/follow-requests/${request.id}`, { decision: 'accept' });
	return request;
}
// Unfollow (or cancel a pending request) with the follow's own ID.
export async function unfollow(follower, followed, followId) {
	await http(follower, 'delete', `/api/v1/follows/${followId}`, undefined, 204);
	expect(followed.account.id).toBeGreaterThan(0);
}

export async function createGroup(creator, title = `A21 Group ${uuid().slice(0, 8)}`) {
	return (
		await http(creator, 'post', '/api/v1/groups', { title, description: 'Real acceptance' }, 201)
	).data;
}
export async function admit(creator, group, member) {
	const request = (
		await http(member, 'post', `/api/v1/groups/${group.id}/join-requests`, undefined, 201)
	).data;
	await http(creator, 'patch', `/api/v1/group-join-requests/${request.id}`, {
		decision: 'accept',
	});
	return membership(member, group);
}
export async function membership(actor, group) {
	const viewer = (await http(actor, 'get', `/api/v1/groups/${group.id}`)).data.viewer;
	return viewer.membership_id === null ? null : { id: viewer.membership_id, role: viewer.role };
}
export const remove = (creator, mem) =>
	http(creator, 'delete', `/api/v1/group-memberships/${mem.id}`, undefined, 204);
export const leave = (actor, mem) =>
	http(actor, 'delete', `/api/v1/group-memberships/${mem.id}`, undefined, 204);

export async function notices(actor) {
	return (await http(actor, 'get', '/api/v1/notifications?per_page=50')).data.notifications;
}
export const eventNotices = async (actor, eventId) =>
	(await notices(actor)).filter(
		(n) => n.target.kind === 'group_event' && n.target.event_id === eventId,
	);

export const noOverflow = async (page) =>
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		),
	).toBeLessThanOrEqual(1);
export const trigger = (page) => page.getByRole('button', { name: /^Notifications/u });
export const indicator = (page) => page.getByTestId('message-indicator');

export function compose(...args) {
	if (!/^sn-b07-test-\d+$/u.test(process.env.COMPOSE_PROJECT_NAME || ''))
		throw new Error('Requires isolated B07 stack');
	return execFileSync(
		'docker',
		['compose', '--env-file', '/dev/null', '-f', 'compose.yaml', ...args],
		{
			stdio: 'pipe',
			timeout: 120000,
		},
	);
}
export function recreate() {
	compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'backend', 'frontend');
}
