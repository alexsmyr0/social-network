import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import App from '../../../../../src/app/App.vue';
import { createAppRouter } from '../../../../../src/app/router.js';
import { createSessionState, sessionKey } from '../../../../../src/features/auth/session-state.js';
import {
	contentKey,
	createContentState,
} from '../../../../../src/features/content/content-state.js';
import { createGroupState, groupsKey } from '../../../../../src/features/groups/group-state.js';
import {
	createNotificationState,
	notificationsKey,
} from '../../../../../src/features/notifications/notification-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
	socialKey,
} from '../../../../../src/features/social/social-state.js';
import {
	createGroupContentFetch,
	GroupContentBackend,
	pngBytes,
} from '../../../../fixtures/phase4/group-content-backend.js';

const mounted = [];
const retained = [];

export function cleanupMounted() {
	for (const release of retained.splice(0)) release();
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
	document.body.innerHTML = '';
}

// Mounts the real shell, router and shared states against the stateful
// Phase 4 content model. Session, social, notification, group and content
// requests share one stubbed fetch, so 401 handling, redirects and membership
// changes behave as in the browser. `sockets` collects the fake notification
// sockets for signals.
export async function mountGroupContentApp(
	path,
	{ backend = new GroupContentBackend(), viewerId = 42, before, after } = {},
) {
	const current = { viewerId };
	const fetchRef = createGroupContentFetch(backend, {
		viewer: () => current.viewerId,
		before,
		after,
	});
	vi.stubGlobal('fetch', fetchRef);
	vi.stubGlobal('scrollTo', vi.fn());
	let previews = 0;
	vi.stubGlobal(
		'URL',
		Object.assign(globalThis.URL, {
			createObjectURL: vi.fn(() => `blob:preview-${++previews}`),
			revokeObjectURL: vi.fn(),
		}),
	);

	const session = createSessionState();
	const router = createAppRouter(createMemoryHistory(), session);
	const social = createSocialState({
		session,
		onUnauthenticated: createUnauthenticatedHandler({ session, router }),
	});
	const groups = createGroupState({ session, social });
	const content = createContentState({ session, social });
	await router.push(path);
	await router.isReady();
	const sockets = [];
	const notifications = createNotificationState({
		session,
		social,
		socketFactory: () => {
			const socket = { close() {} };
			sockets.push(socket);
			return socket;
		},
	});
	retained.push(notifications.dispose);

	const wrapper = mount(App, {
		attachTo: document.body,
		global: {
			plugins: [router],
			provide: {
				[sessionKey]: session,
				[socialKey]: social,
				[notificationsKey]: notifications,
				[groupsKey]: groups,
				[contentKey]: content,
			},
		},
	});
	mounted.push(wrapper);
	await settle();
	return { wrapper, router, session, social, groups, content, fetchRef, current, backend, sockets };
}

const CONTENT_URL =
	/\/api\/v1\/(posts|comments|categories|media|users\/(\d+\/(posts|comments)|activity))/u;

export function contentCalls(fetchRef, { method, path } = {}) {
	return fetchRef.calls.filter(
		(call) =>
			CONTENT_URL.test(call.url) &&
			(!method || call.method === method) &&
			(!path || path.test(call.url)),
	);
}

export const contentWrites = (fetchRef) =>
	contentCalls(fetchRef).filter((call) => call.method !== 'GET');

export function deferred() {
	let release;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

export async function settle() {
	for (let round = 0; round < 6; round += 1) await flushPromises();
}

export function textOf(wrapper) {
	return wrapper.text().replace(/\s+/gu, ' ');
}

export function pngFile(name = 'photo.png') {
	return new File([pngBytes()], name, { type: 'image/png' });
}

// jsdom cannot assign FileList; define it on the input and fire change.
export async function chooseFile(input, file) {
	Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
	await input.trigger('change');
}

// Sends a server signal through the session-owned socket.
export async function signal(sockets, type = 'social.invalidate') {
	const socket = sockets.at(-1);
	socket.onmessage?.({ data: JSON.stringify({ type }) });
	await settle();
}

export async function switchAccount(app, viewerId) {
	app.current.viewerId = viewerId;
	await app.session.restore({ force: true });
	await settle();
}

// Another user's committed write, then the signal their server would send.
export async function actAs(app, userId, method, path, json) {
	const result = app.backend.request(userId, method, `/api/v1${path}`, {
		json,
		headers: { 'X-Requested-With': 'XMLHttpRequest' },
	});
	await signal(app.sockets);
	return result;
}

export function removeMember(app, membershipId = 502) {
	return actAs(app, 42, 'DELETE', `/group-memberships/${membershipId}`);
}
