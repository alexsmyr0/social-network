// SPA/core/app/create-app.js

import { initActivityPage } from '../../features/activity/activity.page.js';
import { canHandleAuthForm, handleAuthFormSubmit } from '../../features/auth/auth.handlers.js';
import {
	initChatConversation,
	SEND_MESSAGE_EVENT,
} from '../../features/chat/chat.conversation.page.js';
import { initChatRoster } from '../../features/chat/chat.roster.page.js';
import { initFeedPage } from '../../features/feed/feed.page.js';
import { createNotificationCenter } from '../../features/notification/notification.page.js';
import { initPostDetailPage, initPostFormPage } from '../../features/post/post.page.js';
import { initProfilePage } from '../../features/profile/profile.page.js';
import { renderAuthenticatedShell } from '../../features/shell/shell.views.js';
import { createChatSocket } from '../realtime/chat-socket.js';
import { renderTemplate } from '../router/render-template.js';
import { matchRoute, normalizePathname } from '../router/routes.js';
import { clearSession, isAuthenticated, setAuthenticated } from '../state/session.js';

const AUTH_SHELL_SELECTOR = '[data-auth-shell]';
const AUTH_OUTLET_SELECTOR = '.app-shell__outlet';
const AUTH_OUTLET_OPENING_TAG = '<main class="app-shell__outlet" aria-label="Page content">';

function hideLoadingOverlay(documentRef, setTimeoutRef) {
	const overlay = documentRef.getElementById('loading-overlay');
	if (!overlay) {
		return;
	}

	overlay.style.opacity = '0';
	setTimeoutRef(() => overlay.remove(), 200);
}

async function resolveSession(fetchRef) {
	if (typeof fetchRef !== 'function') {
		return { isAuthenticated: false, status: 0 };
	}

	try {
		const response = await fetchRef('/api/v1/users/me', {
			method: 'GET',
			credentials: 'include',
			headers: {
				Accept: 'application/json',
			},
		});

		return { isAuthenticated: response.ok, status: response.status };
	} catch {
		return { isAuthenticated: false, status: 0 };
	}
}

function enforceRouteAccess(match, authenticated) {
	if (!match) {
		return {
			redirectTo: authenticated ? '/' : '/login',
			match: null,
		};
	}

	if (match.route.access === 'protected' && !authenticated) {
		return { redirectTo: '/login', match: null };
	}

	if (match.route.access === 'public-only' && authenticated) {
		return { redirectTo: '/', match: null };
	}

	return { redirectTo: null, match };
}

function replaceProtectedOutletMarkup(shellMarkup, outletMarkup) {
	const outletStartMarkerIndex = shellMarkup.indexOf(AUTH_OUTLET_OPENING_TAG);
	if (outletStartMarkerIndex === -1) {
		return null;
	}

	const outletContentStart = outletStartMarkerIndex + AUTH_OUTLET_OPENING_TAG.length;
	const outletEndMarkerIndex = shellMarkup.indexOf('</main>', outletContentStart);
	if (outletEndMarkerIndex === -1) {
		return null;
	}

	return `${shellMarkup.slice(0, outletContentStart)}${outletMarkup}${shellMarkup.slice(outletEndMarkerIndex)}`;
}

export function createApp(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const fetchRef = options.fetchRef ?? (typeof fetch === 'function' ? fetch : null);

	const appFetch = async (input, init) => {
		if (typeof fetchRef !== 'function') {
			throw new TypeError('fetchRef is not a function');
		}
		const response = await fetchRef(input, init);
		if (response.status === 401) {
			onUnauthorized();
		}
		return response;
	};

	if (!windowRef || !documentRef) {
		return null;
	}

	const mainContent = documentRef.getElementById('main-content');
	const setTimeoutRef =
		typeof options.setTimeoutRef === 'function'
			? options.setTimeoutRef
			: windowRef.setTimeout.bind(windowRef);

	// `isAuthenticated` and the signed-in user id live in the global session
	// slice (`core/state/session.js`, issue #76) rather than in this closure, so
	// the chat slices read the same identity instead of resolving their own.
	const state = {
		activePath: normalizePathname(windowRef.location.pathname || '/'),
		authShellRoot: null,
		authShellOutlet: null,
	};

	function onUnauthorized() {
		if (!isAuthenticated()) {
			return;
		}
		clearSession();
		stopNotifications();
		stopChat();
		goTo('/login', true);
	}

	const notificationCenter =
		options.notificationCenter ??
		createNotificationCenter({
			windowRef,
			documentRef,
			fetchRef: appFetch,
			navigate: (path, navigationOptions) => navigate(path, navigationOptions),
		});

	function startNotifications() {
		notificationCenter?.start?.();
	}

	function stopNotifications() {
		notificationCenter?.stop?.();
	}

	// The chat socket lives at the app shell level so a single connection serves
	// the roster and conversation slices across route changes. Inbound frames are
	// re-published as DOM events the slices subscribe to (see chat-socket.js).
	const chatSocket = options.chatSocket ?? createChatSocket({ windowRef, documentRef });

	function startChat() {
		chatSocket?.open?.();
	}

	function stopChat() {
		chatSocket?.close?.();
	}

	// Builds the dm.send payload from a composer submission, or null when the
	// submission carries nothing worth sending.
	//
	// D08 (bonus): an optional pre-uploaded DM image URL travels with the frame.
	// A message may carry just text, just an image, or both — only a frame with
	// neither is dropped.
	function buildSendPayload(detail) {
		const recipientId = Number(detail?.recipientId ?? 0);
		const body = String(detail?.body ?? '').trim();
		const imageUrl = typeof detail?.imageUrl === 'string' ? detail.imageUrl.trim() : '';

		if (!recipientId || (!body && !imageUrl)) {
			return null;
		}

		const payload = { recipient_id: recipientId, body };
		if (imageUrl) {
			payload.image_url = imageUrl;
		}
		return payload;
	}

	function reportSendFailure() {
		if (typeof CustomEvent !== 'function') {
			return;
		}
		documentRef.dispatchEvent?.(
			new CustomEvent('chat:error', {
				detail: { code: 'NOT_CONNECTED', message: 'Not connected. Your message was not sent.' },
			}),
		);
	}

	// Forwards a composer submission to the backend as a dm.send frame. A closed
	// socket surfaces a chat.error so the conversation panel can show it.
	function onSendMessage(event) {
		const detail = event?.detail;
		const payload = buildSendPayload(detail);
		if (!payload) {
			return;
		}

		if (chatSocket?.send?.('dm.send', payload) === false) {
			reportSendFailure();
			return;
		}

		// Tells the composer the frame left the client, so it knows whether it is
		// safe to clear what the user typed. This listener runs synchronously
		// during dispatchEvent, so the flag is set before the composer reads it.
		if (detail && typeof detail === 'object') {
			detail.accepted = true;
		}
	}

	function cacheAuthShellNodes() {
		if (typeof mainContent.querySelector !== 'function') {
			state.authShellRoot = null;
			state.authShellOutlet = null;
			return;
		}

		state.authShellRoot = mainContent.querySelector(AUTH_SHELL_SELECTOR);
		state.authShellOutlet = state.authShellRoot?.querySelector?.(AUTH_OUTLET_SELECTOR) ?? null;
	}

	function renderProtectedRoute(routeMarkup) {
		if (typeof mainContent.querySelector === 'function') {
			if (!state.authShellRoot || !state.authShellOutlet) {
				cacheAuthShellNodes();
			}

			if (!state.authShellRoot || !state.authShellOutlet) {
				mainContent.innerHTML = renderAuthenticatedShell(routeMarkup);
				cacheAuthShellNodes();
				return;
			}

			state.authShellOutlet.innerHTML = routeMarkup;
			return;
		}

		const currentMarkup = typeof mainContent.innerHTML === 'string' ? mainContent.innerHTML : '';
		if (!currentMarkup.includes('data-auth-shell')) {
			mainContent.innerHTML = renderAuthenticatedShell(routeMarkup);
			return;
		}

		const updatedMarkup = replaceProtectedOutletMarkup(currentMarkup, routeMarkup);
		mainContent.innerHTML = updatedMarkup ?? renderAuthenticatedShell(routeMarkup);
	}

	function renderPublicRoute(routeMarkup) {
		state.authShellRoot = null;
		state.authShellOutlet = null;
		mainContent.innerHTML = routeMarkup;
	}

	function renderRoute(match) {
		if (!mainContent) {
			return;
		}

		const routeMarkup = renderTemplate(match);

		if (match.route.access === 'protected') {
			renderProtectedRoute(routeMarkup);
			runRouteInitializer(match);
			return;
		}

		renderPublicRoute(routeMarkup);
		runRouteInitializer(match);
	}

	function runRouteInitializer(match) {
		if (match?.route?.access === 'protected') {
			initChatRoster({ windowRef, documentRef, fetchRef: appFetch });
			initChatConversation({ windowRef, documentRef, fetchRef: appFetch });
		}

		if (match?.route?.id === 'feed') {
			initFeedPage({ windowRef, documentRef, fetchRef: appFetch });
			return;
		}

		if (match?.route?.id === 'create-post' || match?.route?.id === 'edit-post') {
			void initPostFormPage({ windowRef, documentRef, fetchRef: appFetch, navigate });
			return;
		}

		if (match?.route?.id === 'profile') {
			initProfilePage({ windowRef, documentRef, fetchRef: appFetch });
			return;
		}

		if (match?.route?.id === 'post-detail') {
			void initPostDetailPage({ windowRef, documentRef, fetchRef: appFetch });
			return;
		}

		if (match?.route?.id === 'activity') {
			initActivityPage({ windowRef, documentRef, fetchRef: appFetch });
		}
	}

	function goTo(pathname, replace = false) {
		const normalizedTarget = normalizePathname(pathname);
		const currentPath = normalizePathname(windowRef.location.pathname || '/');

		if (replace) {
			windowRef.history.replaceState({}, '', normalizedTarget);
		} else if (normalizedTarget !== currentPath) {
			windowRef.history.pushState({}, '', normalizedTarget);
		}

		state.activePath = normalizedTarget;
		handleLocationChange();
	}

	function navigate(pathname, navigationOptions = {}) {
		goTo(pathname, Boolean(navigationOptions.replace));
	}

	function handleLocationChange() {
		const normalizedPath = normalizePathname(windowRef.location.pathname || '/');

		if (normalizedPath !== windowRef.location.pathname) {
			windowRef.history.replaceState({}, '', normalizedPath);
		}

		const match = matchRoute(normalizedPath);
		const access = enforceRouteAccess(match, isAuthenticated());

		if (access.redirectTo) {
			const normalizedRedirect = normalizePathname(access.redirectTo);
			if (normalizedRedirect !== normalizedPath) {
				goTo(normalizedRedirect, true);
				return;
			}
		}

		if (!access.match) {
			return;
		}

		state.activePath = normalizedPath;
		renderRoute(access.match);
	}

	function shouldFinalizeLogout(response) {
		return Boolean(response?.ok) || response?.status === 401;
	}

	async function performLogout() {
		if (typeof fetchRef !== 'function') {
			return;
		}

		try {
			const response = await fetchRef('/api/v1/users/logout', {
				method: 'POST',
				credentials: 'include',
				headers: {
					Accept: 'application/json',
				},
			});

			if (!shouldFinalizeLogout(response)) {
				return;
			}
		} catch {
			return;
		}

		clearSession();
		stopNotifications();
		stopChat();
		goTo('/login', true);
	}

	function onDocumentClick(event) {
		if (event.defaultPrevented || event.button !== 0) {
			return;
		}

		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}

		const logoutButton = event.target?.closest?.('[data-action="logout"]');
		if (logoutButton) {
			event.preventDefault();
			void performLogout();
			return;
		}

		const anchor = event.target?.closest?.('a[data-link]');
		if (!anchor) {
			return;
		}

		const href = anchor.getAttribute('href');
		if (!href || href.startsWith('http') || href.startsWith('mailto:')) {
			return;
		}

		event.preventDefault();
		goTo(href, false);
	}

	function onDocumentSubmit(event) {
		const form = event.target?.closest?.('form');
		if (!form || !canHandleAuthForm(form)) {
			return;
		}

		event.preventDefault();

		void handleAuthFormSubmit({
			form,
			fetchRef,
			navigate,
			onSuccess() {
				setAuthenticated(true);
				startNotifications();
				startChat();
			},
		});
	}

	function onPopState() {
		handleLocationChange();
	}

	async function boot() {
		const session = await resolveSession(fetchRef);
		setAuthenticated(session.isAuthenticated);

		handleLocationChange();
		hideLoadingOverlay(documentRef, setTimeoutRef);

		if (isAuthenticated()) {
			startNotifications();
			startChat();
		}
	}

	function start() {
		documentRef.addEventListener('click', onDocumentClick);
		documentRef.addEventListener('submit', onDocumentSubmit);
		documentRef.addEventListener(SEND_MESSAGE_EVENT, onSendMessage);
		windowRef.addEventListener('popstate', onPopState);
		return boot();
	}

	function stop() {
		documentRef.removeEventListener('click', onDocumentClick);
		documentRef.removeEventListener('submit', onDocumentSubmit);
		documentRef.removeEventListener(SEND_MESSAGE_EVENT, onSendMessage);
		windowRef.removeEventListener('popstate', onPopState);
		stopNotifications();
		stopChat();
	}

	return {
		boot: start,
		stop,
		navigate,
		handleLocationChange,
		getState: () => ({ ...state, isAuthenticated: isAuthenticated() }),
	};
}
