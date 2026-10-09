import { defineConfig, devices } from '@playwright/test';

if (!process.env.PLAYWRIGHT_BASE_URL) {
	throw new Error('Run make test-browser to start an isolated two-image stack.');
}

export default defineConfig({
	testDir: './SPA/tests/e2e',
	// SN-A07 adds a07-*.test.js here without replacing the stack harness.
	testMatch: [
		'b07-transport.test.js',
		'b13-media.test.js',
		'a07-*.test.js',
		'a11-*.test.js',
		'a14-*.test.js',
	],
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	outputDir: 'test-results/integration',
	reporter: [['list'], ['html', { outputFolder: 'playwright-report/integration', open: 'never' }]],
	use: { baseURL: process.env.PLAYWRIGHT_BASE_URL, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
