import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import App from '../../../../../src/app/App.vue';
import { createAppRouter } from '../../../../../src/app/router.js';
import { createSessionState, sessionKey } from '../../../../../src/features/auth/session-state.js';
import {
	createNotificationState,
	notificationsKey,
} from '../../../../../src/features/notifications/notification-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
	socialKey,
} from '../../../../../src/features/social/social-state.js';
import { createFixtureFetch } from '../../../../fixtures/phase2/fixture-backend.js';

const mounted = [];
const retained = [];

// Unmounts every app a test mounted so window listeners and timers from one
// test can never trigger reads inside the next.
export function cleanupMounted() {
	for (const release of retained.splice(0)) release();
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
	document.body.innerHTML = '';
}

// Mounts the real shell and router against the stateful contract model. The
// session lookup, social reads and writes all go through the same stubbed
// fetch, so 401 handling and redirects behave as they would in the browser.
export async function mountSocialApp(path, { backend, viewerId = 7, before } = {}) {
	const current = { viewerId };
	const fetchRef = createFixtureFetch(backend, { viewer: () => current.viewerId, before });
	vi.stubGlobal('fetch', fetchRef);
	vi.stubGlobal('scrollTo', vi.fn());

	const session = createSessionState();
	const router = createAppRouter(createMemoryHistory(), session);
	const social = createSocialState({
		session,
		onUnauthenticated: createUnauthenticatedHandler({ session, router }),
	});
	await router.push(path);
	await router.isReady();
	const notifications = createNotificationState({
		session,
		social,
		socketFactory: () => ({ close() {} }),
	});
	retained.push(notifications.dispose);

	const wrapper = mount(App, {
		attachTo: document.body,
		global: {
			plugins: [router],
			provide: { [sessionKey]: session, [socialKey]: social, [notificationsKey]: notifications },
		},
	});
	mounted.push(wrapper);
	await flushPromises();
	return { wrapper, router, session, social, fetchRef, current, backend, notifications };
}

export function socialCalls(fetchRef, { method } = {}) {
	return fetchRef.calls.filter(
		(call) =>
			!call.url.endsWith('/health') &&
			!call.url.endsWith('/users/me') &&
			(!method || call.method === method),
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
	await flushPromises();
	await flushPromises();
}

export function textOf(wrapper) {
	return wrapper.text().replace(/\s+/gu, ' ');
}
