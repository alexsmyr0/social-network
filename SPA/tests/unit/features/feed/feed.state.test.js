import { describe, expect, test } from 'vitest';
import {
	buildFeedUrl,
	coercePerPage,
	getFeedQueryState,
	setFeedQueryState,
} from '../../../../features/feed/feed.state.js';

function createWindowRef(href = 'https://example.test/') {
	const url = new URL(href);
	return {
		location: {
			href: url.toString(),
			pathname: url.pathname,
			search: url.search,
		},
		history: {
			pushState(_state, _title, nextPath) {
				const nextUrl = new URL(nextPath, 'https://example.test');
				windowRef.location.href = nextUrl.toString();
				windowRef.location.pathname = nextUrl.pathname;
				windowRef.location.search = nextUrl.search;
			},
		},
	};
}

let windowRef;

describe('feed query state', () => {
	test('restores feed state from URL query params', () => {
		windowRef = createWindowRef('https://example.test/?page=2&per_page=20&category_id=7');

		expect(getFeedQueryState(windowRef)).toEqual({
			page: 2,
			perPage: 20,
			categoryId: '7',
		});
	});

	test('updates URL when feed state changes', () => {
		windowRef = createWindowRef('https://example.test/');
		setFeedQueryState(windowRef, {
			page: 3,
			perPage: 20,
			categoryId: '9',
		});

		expect(windowRef.location.search).toBe('?page=3&per_page=20&category_id=9');
		expect(
			buildFeedUrl(windowRef, {
				page: 1,
				perPage: 10,
				categoryId: '',
			}),
		).toBe('/');
	});

	test('coerces unsupported per-page values back to default', () => {
		expect(coercePerPage(20)).toBe(20);
		expect(coercePerPage(999)).toBe(10);
	});
});
