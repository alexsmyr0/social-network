import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const frontendPort = process.env.TEST_FRONTEND_PORT || '3301';
const backendPort = process.env.TEST_BACKEND_PORT || '18081';
const baseURL = `http://localhost:${frontendPort}`;
const backendURL = `http://localhost:${backendPort}`;

if (!process.env.TEST_RUNTIME_DIR) {
	throw new Error('Run make test-e2e (or bun run test:e2e) to isolate test data.');
}

export default defineConfig({
	testDir: './SPA/tests/e2e',
	testMatch: [
		'a03-shell.test.js',
		'a05-session.test.js',
		'a09-people.test.js',
		'a10-notifications.test.js',
		'a12-publishing.test.js',
		'a13-discussions.test.js',
		'a15-groups.test.js',
		'b07-transport.test.js',
		'b13-media.test.js',
	],
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: [['list'], ['html', { open: 'never' }]],
	use: { baseURL, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: path.resolve('forum-backend'),
			// Avoid loading the developer's .env into the disposable backend.
			cwd: process.env.TEST_RUNTIME_DIR,
			env: { LISTEN_ADDR: `127.0.0.1:${backendPort}`, FRONTEND_URL: baseURL },
			url: `${backendURL}/api/v1/health`,
			reuseExistingServer: false,
		},
		{
			command: './forum-frontend',
			env: { LISTEN_ADDR: `127.0.0.1:${frontendPort}`, BACKEND_URL: backendURL },
			url: `${baseURL}/healthz`,
			reuseExistingServer: false,
		},
	],
});
