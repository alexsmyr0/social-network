import { defineConfig, devices } from '@playwright/test';

if (!process.env.PLAYWRIGHT_BASE_URL || !process.env.A21_UPGRADE_STATE) {
	throw new Error('Run make test-upgrade to start the isolated legacy-to-current stack.');
}

// SN-A21: one phase per invocation. `seed` runs against the legacy backend
// image; `verify` runs after the current images start on the same volume.
export default defineConfig({
	testDir: './SPA/tests/upgrade',
	testMatch: [`${process.env.A21_PHASE ?? 'seed'}.test.js`],
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	outputDir: 'test-results/upgrade',
	reporter: [['list'], ['html', { outputFolder: 'playwright-report/upgrade', open: 'never' }]],
	use: { baseURL: process.env.PLAYWRIGHT_BASE_URL, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
