import { describe, expect, test } from 'vitest';
import { getPageWindow, nextPage, previousPage } from '../../../../core/ui/pagination.js';

describe('pagination headless helpers', () => {
	test('builds a compact page window with ellipses', () => {
		expect(getPageWindow(5, 10)).toEqual([
			{ type: 'page', value: 1, active: false },
			{ type: 'ellipsis' },
			{ type: 'page', value: 4, active: false },
			{ type: 'page', value: 5, active: true },
			{ type: 'page', value: 6, active: false },
			{ type: 'ellipsis' },
			{ type: 'page', value: 10, active: false },
		]);
	});

	test('clamps previous and next page navigation', () => {
		expect(previousPage(1, 10)).toBe(1);
		expect(nextPage(10, 10)).toBe(10);
		expect(nextPage(4, 10)).toBe(5);
	});
});
