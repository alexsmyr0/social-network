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

		// And the code agrees: the interval is a safety net, not the delivery path.
		const page = readDoc('SPA/features/notification/notification.page.js');
		expect(page).toContain('const POLL_INTERVAL_MS = 60000;');
		expect(page).toContain('WS_EVENTS.NOTIFICATION');
	});

	test('the documented socket reconnect is backed by real code', () => {
		expect(readDoc('architecture.md')).toContain('exponential backoff');

		const socket = readDoc('SPA/core/realtime/chat-socket.js');
		expect(socket).toContain('scheduleReconnect');
		expect(socket).toContain('RECONNECT_MAX_MS');
		// The old "reconnect is out of scope" note must not outlive the feature.
		expect(socket).not.toContain('intentionally out of\n// scope for D04');
	});

	test('the README no longer advertises unfinished waves', () => {
		expect(readDoc('README.md')).not.toContain('Active Development (Wave 3)');
	});
});

// Issue #76: `core/state/` was `.gitkeep`-only while the README advertised
// "Proxy-driven state", so #65 had settled the contradiction by deleting the
// claim from SDS § 7.0. The layer now exists, so these assertions pin the claim
// to the code that backs it — a doc-only reversal would fail the last test.
describe('core/state matches its documentation (#76)', () => {
	test('SDS §7.0 documents the implemented Proxy store', () => {
		const sds = readDoc('docs/SDS.md');
		expect(sds).not.toContain('no `Proxy` layer is implemented');
		expect(sds).toContain('Proxy-based reactive global state');
		expect(sds).toContain('state/store.js');
	});

	test('README keeps its Proxy-driven state claim', () => {
		const readme = readDoc('README.md');
		expect(readme).toContain('Proxy-driven state');
	});

	test('the claim is backed by a real Proxy in core/state', () => {
		const store = readDoc('SPA/core/state/store.js');
		expect(store).toContain('new Proxy(');
		expect(store).toContain('export function createStore');

		// The slices the SDS names must actually exist and read the shared store.
		for (const slice of ['SPA/core/state/session.js', 'SPA/core/state/presence.js']) {
			expect(readDoc(slice)).toContain("from './app-state.js'");
		}
	});
});
