// Stateful stand-in for the SN-B10 contract, used only by tests. It models the
// follow state machine, privacy switching, redaction and pagination instead of
// returning one canned success, so UI tests exercise real transitions. It is
// never imported by `SPA/src` (a policy test enforces that).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOCK = '2026-10-02T12:00:00Z';
const MAX_ID = Number.MAX_SAFE_INTEGER;
const NO_STORE = { 'Cache-Control': 'no-store' };
const FIXTURE_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../docs/social-network/fixtures/phase-2-contract.json',
);

export function loadContractFixtures() {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

export function contractUsers() {
	return loadContractFixtures().actors.map((actor) => ({ ...actor, active: true }));
}

export function makeUser(id, overrides = {}) {
	const first = overrides.first_name ?? `Person${id}`;
	const last = overrides.last_name ?? 'Example';
	const nickname = overrides.nickname ?? null;
	return {
		id,
		email: `person${id}@example.com`,
		first_name: first,
		last_name: last,
		date_of_birth: '1990-01-15',
		nickname,
		about_me: null,
		display_name: nickname || `${first} ${last}`,
		avatar_url: null,
		visibility: 'public',
		version: 1,
		active: true,
		...overrides,
	};
}

function reply(status, body = null, headers = {}) {
	return { status, headers: { ...NO_STORE, ...headers }, body };
}

function failure(status, code, fields) {
	const error = { code, message: 'Fixture error; clients branch on code' };
	if (fields) error.fields = fields;
	return reply(status, { error });
}

function parseId(text) {
	if (!/^[1-9]\d*$/u.test(text)) return null;
	const id = Number(text);
	return id <= MAX_ID ? id : null;
}

function normalizeName(name) {
	return name.toLowerCase();
}

function parseCount(params, key, fallback, min, max) {
	const values = params.getAll(key);
	if (values.length === 0) return fallback;
	if (values.length > 1 || !/^[1-9]\d*$/u.test(values[0])) return null;
	const value = Number(values[0]);
	return value >= min && value <= max ? value : null;
}

function matchRoute(pathname) {
	const patterns = [
		['health', /^\/api\/v1\/health$/u],
		['users', /^\/api\/v1\/users$/u],
		['me', /^\/api\/v1\/users\/me$/u],
		['requests', /^\/api\/v1\/users\/me\/follow-requests$/u],
		['privacy', /^\/api\/v1\/users\/me\/privacy$/u],
		['profile', /^\/api\/v1\/users\/([^/]+)\/profile$/u],
		['followers', /^\/api\/v1\/users\/([^/]+)\/followers$/u],
		['following', /^\/api\/v1\/users\/([^/]+)\/following$/u],
		['avatar', /^\/api\/v1\/users\/([^/]+)\/avatar$/u],
		['follows', /^\/api\/v1\/follows$/u],
		['follow', /^\/api\/v1\/follows\/([^/]+)$/u],
		['decision', /^\/api\/v1\/follow-requests\/([^/]+)$/u],
	];
	for (const [name, pattern] of patterns) {
		const match = pattern.exec(pathname);
		if (match) return { name, param: match[1] };
	}
	return null;
}

const ALLOWED_METHODS = {
	health: 'GET',
	users: 'GET',
	me: 'GET',
	requests: 'GET',
	privacy: 'PATCH',
	profile: 'GET',
	followers: 'GET',
	following: 'GET',
	avatar: 'GET',
	follows: 'POST',
	follow: 'DELETE',
	decision: 'PATCH',
};

export class FixtureBackend {
	constructor({ users = contractUsers(), follows = [], removedFollowIds = [] } = {}) {
		this.users = new Map(users.map((user) => [user.id, { ...user }]));
		this.follows = follows.map((follow) => ({ ...follow }));
		const ids = [...this.follows, ...removedFollowIds.map((id) => ({ id }))].map((f) => f.id);
		this.nextFollowId = Math.max(200, ...ids) + 1;
		this.log = [];
	}

	user(id) {
		const user = this.users.get(id);
		return user?.active ? user : null;
	}

	relation(viewerId, subjectId) {
		if (viewerId === subjectId) return { state: 'self', follow_id: null };
		const follow = this.follows.find(
			(item) => item.follower_id === viewerId && item.followed_id === subjectId,
		);
		return follow
			? { state: follow.state, follow_id: follow.id }
			: { state: 'none', follow_id: null };
	}

	canView(viewerId, subject) {
		if (viewerId === subject.id || subject.visibility === 'public') return true;
		return this.relation(viewerId, subject.id).state === 'accepted';
	}

	entry(viewerId, subject) {
		const base = {
			id: subject.id,
			display_name: subject.display_name,
			access: this.canView(viewerId, subject) ? 'full' : 'teaser',
			relationship: this.relation(viewerId, subject.id),
		};
		return base.access === 'full' ? { ...base, avatar_url: subject.avatar_url } : base;
	}

	count(subjectId, side) {
		const other = side === 'followers' ? 'follower_id' : 'followed_id';
		const own = side === 'followers' ? 'followed_id' : 'follower_id';
		return this.follows.filter(
			(f) => f.state === 'accepted' && f[own] === subjectId && this.user(f[other]),
		).length;
	}

	profile(viewerId, subject) {
		const entry = this.entry(viewerId, subject);
		if (entry.access === 'teaser') return entry;
		const { avatar_url: avatarUrl, ...identity } = entry;
		const profile = {
			email: subject.email,
			first_name: subject.first_name,
			last_name: subject.last_name,
			date_of_birth: subject.date_of_birth,
			nickname: subject.nickname,
			about_me: subject.about_me,
			avatar_url: avatarUrl,
			visibility: subject.visibility,
			followers_count: this.count(subject.id, 'followers'),
			following_count: this.count(subject.id, 'following'),
		};
		if (viewerId === subject.id) profile.version = subject.version;
		return { ...identity, profile };
	}

	page(items, params) {
		const page = parseCount(params, 'page', 1, 1, 1000000);
		const perPage = parseCount(params, 'per_page', 20, 1, 50);
		if (page === null || perPage === null) return null;
		const total = items.length;
		const start = (page - 1) * perPage;
		return {
			items: items.slice(start, start + perPage),
			pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) },
		};
	}

	sortedUsers(users) {
		return [...users].sort(
			(a, b) =>
				normalizeName(a.display_name).localeCompare(normalizeName(b.display_name), 'en') ||
				a.id - b.id,
		);
	}

	// Handle one request as `viewerId` (null = no session). `json` is the parsed
	// body for JSON writes.
	request(viewerId, method, url, { json } = {}) {
		const target = new URL(url, 'http://fixture.test');
		const route = matchRoute(target.pathname);
		this.log.push({ viewerId, method, path: `${target.pathname}${target.search}`, json });
		if (!route) return failure(404, 'NOT_FOUND');
		if (ALLOWED_METHODS[route.name] !== method) {
			return failure(405, 'METHOD_NOT_ALLOWED');
		}
		if (route.name === 'health') return reply(200, { data: { status: 'ok' } });
		if (viewerId === null) return failure(401, 'UNAUTHORIZED');
		const viewer = this.user(viewerId);
		if (!viewer) return failure(401, 'UNAUTHORIZED');
		return this.dispatch(viewer, route, target, json);
	}

	dispatch(viewer, route, target, json) {
		const params = target.searchParams;
		switch (route.name) {
			case 'me':
				return reply(200, { data: this.account(viewer) });
			case 'users':
				return this.directory(viewer, params);
			case 'profile':
				return this.readProfile(viewer, route.param);
			case 'followers':
			case 'following':
				return this.readList(viewer, route, params);
			case 'avatar':
				return this.readAvatar(viewer, route.param);
			case 'requests':
				return this.readRequests(viewer, params);
			case 'follows':
				return this.createFollow(viewer, json);
			case 'follow':
				return this.removeFollow(viewer, route.param);
			case 'decision':
				return this.decide(viewer, route.param, json);
			default:
				return this.changePrivacy(viewer, json);
		}
	}

	account(viewer) {
		const { active: _active, version: _version, visibility: _visibility, ...account } = viewer;
		return account;
	}

	directory(viewer, params) {
		for (const key of params.keys()) {
			if (!['q', 'page', 'per_page'].includes(key)) return failure(400, 'BAD_REQUEST');
		}
		if (params.getAll('q').length > 1) return failure(400, 'BAD_REQUEST');
		const q = (params.get('q') ?? '').trim();
		if ([...q].length > 100) return failure(400, 'VALIDATION_ERROR', { q: 'TOO_LONG' });
		if (/\p{Cc}/u.test(q)) return failure(400, 'VALIDATION_ERROR', { q: 'INVALID_TEXT' });
		const needle = normalizeName(q);
		const matches = [...this.users.values()].filter(
			(user) => user.active && normalizeName(user.display_name).includes(needle),
		);
		return this.listReply(viewer, this.sortedUsers(matches), params);
	}

	listReply(viewer, users, params) {
		const paged = this.page(users, params);
		if (!paged) return failure(400, 'BAD_REQUEST');
		return reply(200, {
			data: paged.items.map((user) => this.entry(viewer.id, user)),
			meta: { pagination: paged.pagination },
		});
	}

	readProfile(viewer, rawId) {
		const id = parseId(rawId);
		if (!id) return failure(400, 'BAD_REQUEST');
		const subject = this.user(id);
		if (!subject) return failure(404, 'NOT_FOUND');
		return reply(200, { data: this.profile(viewer.id, subject) });
	}

	readList(viewer, route, params) {
		const id = parseId(route.param);
		if (!id) return failure(400, 'BAD_REQUEST');
		const subject = this.user(id);
		if (!subject || !this.canView(viewer.id, subject)) return failure(404, 'NOT_FOUND');
		const followers = route.name === 'followers';
		const members = this.follows
			.filter((f) => f.state === 'accepted' && f[followers ? 'followed_id' : 'follower_id'] === id)
			.map((f) => this.user(f[followers ? 'follower_id' : 'followed_id']))
			.filter(Boolean);
		return this.listReply(viewer, this.sortedUsers(members), params);
	}

	readAvatar(viewer, rawId) {
		const id = parseId(rawId);
		if (!id) return failure(400, 'BAD_REQUEST');
		const subject = this.user(id);
		if (!subject?.avatar_url || !this.canView(viewer.id, subject)) {
			return failure(404, 'NOT_FOUND');
		}
		return reply(200, null, { 'Content-Type': 'image/png' });
	}

	readRequests(viewer, params) {
		const pending = this.follows
			.filter((f) => f.state === 'pending' && f.followed_id === viewer.id)
			.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
		const paged = this.page(pending, params);
		if (!paged) return failure(400, 'BAD_REQUEST');
		return reply(200, {
			data: paged.items.map((follow) => ({
				id: follow.id,
				created_at: follow.created_at,
				requester: this.entry(viewer.id, this.user(follow.follower_id)),
			})),
			meta: { pagination: paged.pagination },
		});
	}

	createFollow(viewer, json) {
		const keys = json && typeof json === 'object' ? Object.keys(json) : [];
		if (keys.some((key) => key !== 'user_id')) return failure(400, 'BAD_REQUEST');
		if (json?.user_id === undefined)
			return failure(400, 'VALIDATION_ERROR', { user_id: 'REQUIRED' });
		const targetId = json.user_id;
		if (!Number.isSafeInteger(targetId) || targetId <= 0) {
			return failure(400, 'VALIDATION_ERROR', { user_id: 'INVALID_ID' });
		}
		if (targetId === viewer.id) return failure(400, 'SELF_FOLLOW', { user_id: 'SELF_FOLLOW' });
		const target = this.user(targetId);
		if (!target) return failure(404, 'NOT_FOUND');
		const existing = this.follows.find(
			(f) => f.follower_id === viewer.id && f.followed_id === targetId,
		);
		if (existing) return reply(200, { data: { ...existing } });
		const accepted = target.visibility === 'public';
		const follow = {
			id: this.nextFollowId++,
			follower_id: viewer.id,
			followed_id: targetId,
			state: accepted ? 'accepted' : 'pending',
			created_at: CLOCK,
			accepted_at: accepted ? CLOCK : null,
		};
		this.follows.push(follow);
		return reply(201, { data: { ...follow } });
	}

	removeFollow(viewer, rawId) {
		const id = parseId(rawId);
		if (!id) return failure(400, 'BAD_REQUEST');
		const index = this.follows.findIndex((f) => f.id === id);
		if (index < 0) return failure(409, 'STALE_FOLLOW');
		if (this.follows[index].follower_id !== viewer.id) return failure(404, 'NOT_FOUND');
		this.follows.splice(index, 1);
		return reply(204);
	}

	decide(viewer, rawId, json) {
		const id = parseId(rawId);
		if (!id) return failure(400, 'BAD_REQUEST');
		const decision = json?.decision;
		if (decision === undefined) return failure(400, 'VALIDATION_ERROR', { decision: 'REQUIRED' });
		if (decision !== 'accept' && decision !== 'decline') {
			return failure(400, 'VALIDATION_ERROR', { decision: 'INVALID_CHOICE' });
		}
		const index = this.follows.findIndex((f) => f.id === id);
		if (index < 0) return failure(409, 'STALE_FOLLOW');
		const follow = this.follows[index];
		if (follow.followed_id !== viewer.id) return failure(404, 'NOT_FOUND');
		if (decision === 'decline') {
			if (follow.state !== 'pending') return failure(409, 'STALE_FOLLOW');
			this.follows.splice(index, 1);
			return reply(204);
		}
		if (follow.state === 'pending') {
			follow.state = 'accepted';
			follow.accepted_at = CLOCK;
		}
		return reply(200, { data: { ...follow } });
	}

	privacyFields(json) {
		const choice = json?.visibility;
		if (choice === undefined) return { visibility: 'REQUIRED' };
		if (choice !== 'public' && choice !== 'private') return { visibility: 'INVALID_CHOICE' };
		const version = json.expected_version;
		if (version === undefined) return { expected_version: 'REQUIRED' };
		if (!Number.isSafeInteger(version) || version < 1) {
			return { expected_version: 'INVALID_VERSION' };
		}
		return null;
	}

	changePrivacy(viewer, json) {
		const fields = this.privacyFields(json);
		if (fields) return failure(400, 'VALIDATION_ERROR', fields);
		if (json.expected_version !== viewer.version) return failure(409, 'STALE_PROFILE');
		if (json.visibility !== viewer.visibility) {
			viewer.visibility = json.visibility;
			viewer.version += 1;
			if (json.visibility === 'public') this.acceptPendingFor(viewer.id);
		}
		return reply(200, { data: this.profile(viewer.id, viewer) });
	}

	acceptPendingFor(userId) {
		for (const follow of this.follows) {
			if (follow.followed_id === userId && follow.state === 'pending') {
				follow.state = 'accepted';
				follow.accepted_at = CLOCK;
			}
		}
	}
}

// fetch-compatible adapter. `viewer` is read per call so tests can switch
// sessions; `before(request)` may await to hold a response or throw to simulate
// a lost connection.
export function createFixtureFetch(backend, { viewer = () => 7, before } = {}) {
	const calls = [];
	async function fetchRef(url, init = {}) {
		const method = init.method ?? 'GET';
		const json = init.body ? JSON.parse(init.body) : undefined;
		const entry = { url, method, json, headers: init.headers ?? {} };
		calls.push(entry);
		if (before) await before(entry);
		const result = backend.request(viewer(), method, url, { json });
		return {
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			headers: result.headers,
			json: async () => {
				if (result.body === null) throw new SyntaxError('empty body');
				return JSON.parse(JSON.stringify(result.body));
			},
		};
	}
	fetchRef.calls = calls;
	return fetchRef;
}
