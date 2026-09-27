import { createApp } from 'vue';

import App from './app/App.vue';
import { createAppRouter } from './app/router.js';
import { createSessionState, sessionKey } from './features/auth/session-state.js';
import './styles/main.css';
import './styles/registration.css';

const session = createSessionState();
const router = createAppRouter(undefined, session);

createApp(App).provide(sessionKey, session).use(router).mount('#app');
