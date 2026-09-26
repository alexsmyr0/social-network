import { createApp } from 'vue';

import App from './app/App.vue';
import { createAppRouter } from './app/router.js';
import './styles/main.css';
import './styles/registration.css';

const router = createAppRouter();

createApp(App).use(router).mount('#app');
