// SPA/tests/unit/policy/csp-conformance.test.js
//
// Guards the frontend Content-Security-Policy contract from the SPA side
// (issue #57). `cmd/frontend/server_test.go` pins the header the server emits;
// these tests pin the other half — that the shipped markup can actually live
// under that header.
//
// The regression that motivated this: the auth screens rendered testimonial
// avatars from `https://i.pravatar.cc`, which the strict `img-src` blocks. Both
// Go and JS suites plus all Playwright specs stayed green while the images
// silently failed to load, because nothing asserted the origins the SPA
// references.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const spaRoot = path.resolve(testDir, '../../../');
const testsDir = path.join(spaRoot, 'tests');
const distDir = path.join(spaRoot, 'dist');

const SCANNED_EXTENSIONS = ['.js', '.css', '.html'];

// Hosts the CSP actually permits, plus the XML namespace URIs that appear in
// inline SVG markup and are never fetched.
const ALLOWED_HOSTS = new Set([
	'fonts.googleapis.com', // style-src
	'fonts.gstatic.com', // font-src
	'www.w3.org', // SVG/XML namespace identifier, not a network fetch
	'forum.local', // `new URL()` parsing sentinel for relative paths, never fetched
]);

const ABSOLUTE_URL_PATTERN = /\bhttps?:\/\/([^\s"'`)>\\]+)/g;

// Matches an inline event-handler attribute (onclick=, onerror=, ...) as it
// would appear in rendered markup. `script-src 'self'` blocks these.
const INLINE_HANDLER_PATTERN = /\son[a-z]+\s*=\s*["'][^"']*["']/gi;

async function collectSourceFiles(rootDir) {
	const entries = await readdir(rootDir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const absolutePath = path.join(rootDir, entry.name);

			if (entry.isDirectory()) {
				// The test tree legitimately references throwaway origins
				// (https://example.test, http://localhost:3000) as fetch stubs.
				if (
					absolutePath === testsDir ||
					absolutePath === distDir ||
					entry.name === 'node_modules'
				) {
					return [];
				}
				return collectSourceFiles(absolutePath);
			}

			if (!entry.isFile() || !SCANNED_EXTENSIONS.includes(path.extname(absolutePath))) {
				return [];
			}

			return [absolutePath];
		}),
	);

	return nested.flat();
}

async function findDisallowedOrigins() {
	const files = await collectSourceFiles(spaRoot);
	const offenders = [];

	for (const filePath of files) {
		const source = await readFile(filePath, 'utf8');

		for (const match of source.matchAll(ABSOLUTE_URL_PATTERN)) {
			const host = (match[1] ?? '').split('/')[0].split(':')[0];
			if (ALLOWED_HOSTS.has(host)) {
				continue;
			}

			offenders.push({ file: path.relative(spaRoot, filePath), host });
		}
	}

	return offenders;
}

async function findInlineHandlers() {
	const files = await collectSourceFiles(spaRoot);
	const offenders = [];

	for (const filePath of files) {
		const source = await readFile(filePath, 'utf8');

		for (const match of source.matchAll(INLINE_HANDLER_PATTERN)) {
			offenders.push({ file: path.relative(spaRoot, filePath), snippet: match[0].trim() });
		}
	}

	return offenders;
}

describe('SPA conforms to the frontend CSP', () => {
	test('references no third-party origin beyond the CSP allowlist', async () => {
		const offenders = await findDisallowedOrigins();

		expect(offenders).toEqual([]);
	});

	test('ships no inline event handlers, which `script-src self` blocks', async () => {
		const offenders = await findInlineHandlers();

		expect(offenders).toEqual([]);
	});

	test('the HTML shell carries no inline script body', async () => {
		const shell = await readFile(path.join(spaRoot, 'index.html'), 'utf8');
		const inlineScripts = [...shell.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
			([, , body]) => body.trim() !== '',
		);

		expect(inlineScripts).toEqual([]);
	});
});
