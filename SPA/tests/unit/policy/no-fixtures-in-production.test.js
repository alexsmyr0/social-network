// SN-A09/A10/A12 develop against owner-approved contract fixtures. Production code
// must never import them or ship their data: a fixture response would look
// like real authorization.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(testDir, '../../../src');

async function sourceFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? sourceFiles(full) : [full];
		}),
	);
	return nested.flat();
}

describe('production sources stay free of fixtures', () => {
	test('nothing under SPA/src references test fixtures or contract fixture data', async () => {
		const offenders = [];
		for (const file of await sourceFiles(srcRoot)) {
			const text = await readFile(file, 'utf8');
			if (
				/tests\/fixtures|phase-[23]-contract|fixture-backend|content-backend|@vitest|vi\.stubGlobal/u.test(
					text,
				)
			) {
				offenders.push(path.relative(srcRoot, file));
			}
			if (/ada@example\.com|alex@example\.com|outsider@example\.com/u.test(text)) {
				offenders.push(`${path.relative(srcRoot, file)} (fixture identity)`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test.each([
		'api/social.js',
		'api/content.js',
	])('%s only talks to the versioned same-origin API', async (file) => {
		const text = await readFile(path.join(srcRoot, file), 'utf8');
		expect(text).not.toMatch(/https?:\/\//u);
		expect(text).toContain("const API = '/api/v1';");
	});
});
