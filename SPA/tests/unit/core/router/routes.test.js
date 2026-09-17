// SPA/tests/unit/core/router/routes.test.js

import { describe, expect, test } from 'vitest';
import { matchRoute, normalizePathname } from '../../../../core/router/routes.js';

describe('SPA routing module', () => {
	test('normalizes and matches required routes', () => {
		expect(normalizePathname('')).toBe('/');
		expect(normalizePathname('/view-post/42')).toBe('/posts/42');
		expect(normalizePathname('/post/42')).toBe('/posts/42');
		expect(normalizePathname('/activity/')).toBe('/activity');

		expect(matchRoute('/')?.route.id).toBe('feed');
		expect(matchRoute('/posts/7')?.params.id).toBe('7');
		expect(matchRoute('/post/7')?.params.id).toBe('7');
		expect(matchRoute('/edit-post/15')?.params.id).toBe('15');
		expect(matchRoute('/does-not-exist')).toBeNull();
		// Regression: A03 Malformed URI should not crash
		expect(matchRoute('/post/%E0%A4%A')).toBeNull();
	});
});
