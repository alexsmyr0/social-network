// SPA/main.js

import { createApp } from './core/app/create-app.js';
import { initGlobalErrorHandlers } from './core/errors/error-handler.js';
import { matchRoute, normalizePathname } from './core/router/routes.js';

export { createApp, initGlobalErrorHandlers, matchRoute, normalizePathname };

initGlobalErrorHandlers();

const app = createApp();

if (app) {
	if (document.readyState === 'loading') {
		document.addEventListener(
			'DOMContentLoaded',
			() => {
				void app.boot();
			},
			{ once: true },
		);
	} else {
		void app.boot();
	}
}
