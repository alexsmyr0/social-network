import { createApp } from 'vue';

import App from './app/App.vue';
import { createAppRouter } from './app/router.js';
import { createSessionState, sessionKey } from './features/auth/session-state.js';
import {
	createNotificationState,
	notificationsKey,
} from './features/notifications/notification-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
	socialKey,
} from './features/social/social-state.js';
import './styles/notifications.css';
import './styles/main.css';
import './styles/registration.css';
import './styles/social.css';

const logoutChannel =
	typeof BroadcastChannel === 'function' ? new BroadcastChannel('commonplace-session') : null;
const session = createSessionState({
	onLogout: () => logoutChannel?.postMessage('logged-out'),
});
const router = createAppRouter(undefined, session);
const social = createSocialState({
	session,
	onUnauthenticated: createUnauthenticatedHandler({ session, router }),
});

const notifications = createNotificationState({ session, social });

logoutChannel?.addEventListener('message', (event) => {
	if (event.data !== 'logged-out') return;
	session.clearAuthenticatedState();
	void router.replace({ name: 'login' });
});

const app = createApp(App);
app.onUnmount(() => {
	notifications.dispose();
	logoutChannel?.close();
});
app
	.provide(sessionKey, session)
	.provide(socialKey, social)
	.provide(notificationsKey, notifications)
	.use(router)
	.mount('#app');
