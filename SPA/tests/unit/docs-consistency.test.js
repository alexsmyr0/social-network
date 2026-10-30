import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = join(__dirname, '..', '..', '..');

function readDoc(relPath) {
	const raw = readFileSync(join(repoRoot, relPath), 'utf8');
	return raw.replace(/\r\n/g, '\n');
}

// Issue #65: docs/architecture claim states the code does not match. These
// assertions pin the resolved (post-fix) wording so the stale claims cannot
// silently return.
describe('docs reflect implemented reality (#65)', () => {
	test('README no longer claims chat is In Progress / Proxy ready', () => {
		const readme = readDoc('README.md');
		expect(readme).not.toContain('Proxy ready');
		expect(readme).not.toMatch(/Real-Time Chat[^\n]*In Progress/);
		expect(readme).toMatch(/Real-Time Chat[^\n]*Complete/);
	});

	test('architecture.md no longer lists chat as in active development', () => {
		const arch = readDoc('architecture.md');
		expect(arch).not.toContain('Chat and messaging areas are in active development');
	});
});

// The audit dry run found architecture.md describing code that had been
// deleted: OAuth helpers in `internal/auth/`, and `web/templates/`. Neither
// directory exists. These pin the corrected text so the claims cannot creep
// back in, and check the code side rather than trusting the prose.
describe('architecture.md describes code that exists', () => {
	test('no OAuth claim survives — the package and the schema table are gone', () => {
		const arch = readDoc('architecture.md');
		expect(arch).not.toContain('internal/auth/');
		expect(arch.toLowerCase()).not.toContain('oauth');

		// The dead `oauth_users` table went with it.
		const schema = readDoc('internal/db/forum_schema.sql');
		expect(schema.toLowerCase()).not.toContain('oauth');
	});

	test('the deleted legacy template directory is not documented', () => {
		expect(readDoc('architecture.md')).not.toContain('web/templates');
	});

	test('the notification section describes push, not the old 5s poll', () => {
		const arch = readDoc('architecture.md');
		expect(arch).not.toContain('5s polling lifecycle');
		expect(arch).toContain('notification.new');
	});

	test('the documented socket reconnect is backed by real code', () => {
		expect(readDoc('architecture.md')).toContain('exponential backoff');

		const socket = readDoc('SPA/src/features/notifications/notification-state.js');
		expect(socket).toContain('function reconnect(');
		expect(socket).toContain('retryDelay = Math.min(retryDelay * 2,');
	});

	test('the README no longer advertises unfinished waves', () => {
		expect(readDoc('README.md')).not.toContain('Active Development (Wave 3)');
	});
});
