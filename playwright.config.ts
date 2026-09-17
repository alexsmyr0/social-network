import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './SPA/tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: 'html',
	use: {
		baseURL: 'http://localhost:3000',
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: [
		{
			command: 'make run-backend',
			url: 'http://localhost:8080/api/v1/users/me',
			// Never attach to a pre-existing process: a leaked/stale server would
			// otherwise be reused and the suite would run against the wrong app.
			// `make test-e2e` frees these ports first, so a fresh server always starts.
			reuseExistingServer: false,
		},
		{
			command: 'make run-frontend',
			url: 'http://localhost:3000',
			// Never attach to a pre-existing process: a leaked/stale server would
			// otherwise be reused and the suite would run against the wrong app.
			// `make test-e2e` frees these ports first, so a fresh server always starts.
			reuseExistingServer: false,
		},
	],
});
