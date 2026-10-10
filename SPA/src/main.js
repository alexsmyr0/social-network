import { createApp } from 'vue';

import App from './app/App.vue';
import { createAppRouter } from './app/router.js';
import { createSessionState, sessionKey } from './features/auth/session-state.js';
import { contentKey, createContentState } from './features/content/content-state.js';
import { createGroupState, groupsKey } from './features/groups/group-state.js';
import {
	createNotificationState,
	notificationsKey,
} from './features/notifications/notification-state.js';
import {
	createSocialState,
	createUnauthenticatedHandler,
	socialKey,
} from './features/social/social-state.js';
import './styles/content.css';
import './styles/groups.css';
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
const content = createContentState({ session, social });
const groups = createGroupState({ session, social });

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
	.provide(contentKey, content)
	.provide(groupsKey, groups)
	.use(router)
	.mount('#app');
