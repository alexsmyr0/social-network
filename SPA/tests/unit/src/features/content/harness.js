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
import {
	createNotificationState,
	notificationsKey,
} from '../../../../../src/features/notifications/notification-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
	socialKey,
} from '../../../../../src/features/social/social-state.js';
import { createContentFetch, pngBytes } from '../../../../fixtures/phase3/content-backend.js';

const mounted = [];
const retained = [];

export function cleanupMounted() {
	for (const release of retained.splice(0)) release();
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
	document.body.innerHTML = '';
}

// Mounts the real shell, router and shared states against the stateful
// Phase 3 model. Session, social, notification and content requests all go
// through one stubbed fetch, so 401 handling and redirects behave as in the
// browser. `sockets` collects the fake notification sockets for signals.
export async function mountContentApp(path, { backend, viewerId = 42, before, after } = {}) {
	const current = { viewerId };
	const fetchRef = createContentFetch(backend, { viewer: () => current.viewerId, before, after });
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
				[contentKey]: content,
			},
		},
	});
	mounted.push(wrapper);
	await settle();
	return { wrapper, router, session, social, content, fetchRef, current, backend, sockets };
}

export function contentCalls(fetchRef, { method, path } = {}) {
	return fetchRef.calls.filter(
		(call) =>
			/\/api\/v1\/(posts|categories|media)/u.test(call.url) &&
			(!method || call.method === method) &&
			(!path || path.test(call.url)),
	);
}

export function deferred() {
	let release;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

export async function settle() {
	for (let round = 0; round < 4; round += 1) await flushPromises();
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
