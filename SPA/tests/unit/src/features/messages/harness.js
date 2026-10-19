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
import { createEventState, eventsKey } from '../../../../../src/features/events/event-state.js';
import { createGroupState, groupsKey } from '../../../../../src/features/groups/group-state.js';
import { createImageCache } from '../../../../../src/features/messages/message-images.js';
import {
	createMessageState,
	messagesKey,
} from '../../../../../src/features/messages/message-state.js';
import {
	createNotificationState,
	notificationsKey,
} from '../../../../../src/features/notifications/notification-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
	socialKey,
} from '../../../../../src/features/social/social-state.js';
import { ChatBackend, createChatFetch } from '../../../../fixtures/phase5/chat-backend.js';

const mounted = [];
const retained = [];

export function cleanupMounted() {
	for (const release of retained.splice(0)) release();
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
	document.body.innerHTML = '';
}

// Mounts the real shell, router and shared states against the stateful
// private-message model. Every request goes through one stubbed fetch; the
// fake notification socket records frames, and `deliver` forwards the model's
// committed signals to it exactly as the real socket would (a payload for
// message frames, none for invalidation). Object URLs are counted so a test
// can prove they are revoked.
export async function mountMessagesApp(
	path,
	{ backend = new ChatBackend(), viewerId = 42, before, after, open = true } = {},
) {
	const current = { viewerId };
	const objectUrls = { created: [], revoked: [] };
	const fetchRef = createChatFetch(backend, {
		viewer: () => current.viewerId,
		before,
		onLogout: () => {
			current.viewerId = null;
		},
		after: async (entry, result) => {
			await after?.(entry, result);
			// Committed signals reach the open page just after the response.
			setTimeout(() => deliver(), 0);
		},
	});
	vi.stubGlobal('fetch', fetchRef);
	vi.stubGlobal('scrollTo', vi.fn());

	const session = createSessionState();
	const router = createAppRouter(createMemoryHistory(), session);
	const social = createSocialState({
		session,
		onUnauthenticated: createUnauthenticatedHandler({ session, router }),
	});
	const groups = createGroupState({ session, social });
	const events = createEventState({ session, social });
	const content = createContentState({ session, social });
	await router.push(path);
	await router.isReady();
	const sockets = [];
	const notifications = createNotificationState({
		session,
		social,
		socketFactory: () => {
			const socket = { close: vi.fn() };
			sockets.push(socket);
			return socket;
		},
	});
	const images = createImageCache({
		fetchImage: (url) => messages.api.fetchImage(url, fetchRef),
		createUrl: (blob) => {
			const url = `blob:test/${objectUrls.created.length + 1}`;
			objectUrls.created.push({ url, size: blob.size });
			return url;
		},
		revokeUrl: (url) => objectUrls.revoked.push(url),
	});
	const messages = createMessageState({ session, social, notifications, images });
	retained.push(() => {
		messages.dispose();
		notifications.dispose();
	});

	// The server's committed signals as socket frames for the signed-in viewer.
	function deliver() {
		const frames = backend.signals.splice(0);
		const socket = sockets.at(-1);
		if (!socket?.onmessage || current.viewerId === null) return;
		for (const frame of frames) {
			const reaches =
				frame.recipients === 'all_authenticated' || frame.recipients.includes(current.viewerId);
			if (!reaches) continue;
			const wire =
				frame.payload === undefined
					? { type: frame.type }
					: { type: frame.type, payload: frame.payload };
			socket.onmessage({ data: JSON.stringify(wire) });
		}
	}

	const wrapper = mount(App, {
		attachTo: document.body,
		global: {
			plugins: [router],
			provide: {
				[sessionKey]: session,
				[socialKey]: social,
				[notificationsKey]: notifications,
				[messagesKey]: messages,
				[groupsKey]: groups,
				[eventsKey]: events,
				[contentKey]: content,
			},
		},
	});
	mounted.push(wrapper);
	await settle();
	const app = {
		wrapper,
		router,
		session,
		social,
		notifications,
		messages,
		fetchRef,
		current,
		backend,
		sockets,
		objectUrls,
		deliver,
	};
	if (open) await connect(app);
	return app;
}

// The socket opens: the server's presence snapshot follows, as on a real
// connection, and the lists refetch.
export async function connect(app) {
	const socket = app.sockets.at(-1);
	socket.onopen?.();
	frame(app, {
		type: 'presence.snapshot',
		payload: app.backend.presenceSnapshot(app.current.viewerId),
	});
	await settle();
}

export function frame(app, value) {
	app.sockets.at(-1).onmessage({ data: JSON.stringify(value) });
}

export async function deliverFrames(app) {
	app.deliver();
	await settle();
}

export function chatCalls(fetchRef, { method, path } = {}) {
	return fetchRef.calls.filter(
		(call) =>
			/\/api\/v1\/chats/u.test(call.url) &&
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
	for (let round = 0; round < 6; round += 1) {
		await flushPromises();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

export const textOf = (wrapper) => wrapper.text().replace(/\s+/gu, ' ');

// Types into the real textarea so the same handler a person triggers runs.
export async function type(wrapper, text) {
	const field = wrapper.get('#message-body');
	await field.setValue(text);
	return field;
}
