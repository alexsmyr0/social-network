import { createApp } from 'vue';

import App from './app/App.vue';
import { createAppRouter } from './app/router.js';
import { createSessionState, sessionKey } from './features/auth/session-state.js';
import './styles/main.css';
import './styles/registration.css';

const logoutChannel =
	typeof BroadcastChannel === 'function' ? new BroadcastChannel('commonplace-session') : null;
const session = createSessionState({
	onLogout: () => logoutChannel?.postMessage('logged-out'),
});
const router = createAppRouter(undefined, session);

logoutChannel?.addEventListener('message', (event) => {
	if (event.data !== 'logged-out') return;
	session.clearAuthenticatedState();
	void router.replace({ name: 'login' });
});

createApp(App).provide(sessionKey, session).use(router).mount('#app');
