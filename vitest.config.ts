import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['**/*.test.{js,mjs,ts}'],
		exclude: ['SPA/tests/e2e/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text-summary', 'lcov'],
			reportsDirectory: '.tmp/coverage',
			// Only the shipped SPA. The test tree, the Playwright specs and the
			// legacy `web/` surface would otherwise dilute the numbers.
			include: [
				'SPA/core/**/*.js',
				'SPA/features/**/*.js',
				'SPA/components/**/*.js',
				'SPA/main.js',
			],
			// Thresholds are a ratchet, not an aspiration: they sit a couple of
			// points under the suite's actual numbers so ordinary churn does not
			// turn CI red, while a real drop in coverage does. Raise them when the
			// measured figures rise; never lower them to make a build pass.
			thresholds: {
				statements: 75,
				branches: 73,
				functions: 78,
				lines: 75,
			},
		},
	},
});
