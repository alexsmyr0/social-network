// E2E harness hardening — free local dev/test ports before Playwright runs.
//
// Background: Playwright's webServer used `reuseExistingServer` locally, so a
// leaked frontend/backend process squatting on a port would be reused instead
// of the current build — causing the E2E suite to run against a stale app and
// report false failures (see "E2E Harness Hardening" issue). Killing by port is
// more reliable than `pkill -f name`, because the leaked process may be a
// go-build cache binary whose name does not match the expected binary name.
//
// Usage: `node ./scripts/free-ports.mjs [port...]` (defaults: 3000 8080 — the
// frontend dev server and the Go backend respectively).
// Best-effort and idempotent: missing tooling or no listener is not an error.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_PORTS = [3000, 8080];

const ports = process.argv.slice(2).length
	? process.argv
			.slice(2)
			.map((p) => Number.parseInt(p, 10))
			.filter((p) => Number.isInteger(p) && p > 0)
	: DEFAULT_PORTS;

function run(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return '';
	}
}

// Resolve PIDs listening on a TCP port. Tries lsof, then ss, then fuser —
// whichever is available on the host. Returns a de-duplicated array of PIDs.
// Note: if none of these tools exist, every probe returns empty and cleanup
// becomes a silent no-op (preferable to silently reusing a stale server).
function pidsOnPort(port) {
	const pids = new Set();

	// lsof: most portable (Linux + macOS).
	for (const line of run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n')) {
		const pid = Number.parseInt(line.trim(), 10);
		if (Number.isInteger(pid)) pids.add(pid);
	}

	if (pids.size === 0) {
		// ss: Linux fallback. Extract `pid=NNN` from the process column.
		const out = run('ss', ['-ltnp', `( sport = :${port} )`]);
		for (const match of out.matchAll(/pid=(\d+)/g)) {
			pids.add(Number.parseInt(match[1], 10));
		}
	}

	if (pids.size === 0) {
		// fuser: last-resort Linux fallback. Prints whitespace-separated PIDs.
		for (const tok of run('fuser', [`${port}/tcp`]).split(/\s+/)) {
			const pid = Number.parseInt(tok.trim(), 10);
			if (Number.isInteger(pid)) pids.add(pid);
		}
	}

	return [...pids];
}

let killed = 0;
for (const port of ports) {
	for (const pid of pidsOnPort(port)) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			/* already gone */
		}
		// Re-check immediately; if SIGTERM didn't free the port, escalate to
		// SIGKILL. (No deliberate delay: a process that already released the
		// port won't show up here, and one that's still listening is killed
		// outright rather than waited on.)
		const stillThere = pidsOnPort(port).includes(pid);
		if (stillThere) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				/* already gone */
			}
		}
		console.log(`free-ports: cleared pid ${pid} on port ${port}`);
		killed += 1;
	}
}

if (killed === 0) {
	console.log(`free-ports: no listeners on ${ports.join(', ')} — nothing to clean`);
}

process.exit(0);
