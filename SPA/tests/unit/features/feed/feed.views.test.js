import { describe, expect, test } from 'vitest';
import { renderFeedView } from '../../../../features/feed/feed.views.js';

describe('renderFeedView', () => {
	const markup = renderFeedView('Latest discussions');

	test('renders the feed screen scaffold with filters, posts output, and pagination', () => {
		expect(markup).toContain('data-screen="feed"');
		expect(markup).toContain('id="categoryFilter"');
		expect(markup).toContain('id="perPageSelect"');
		expect(markup).toContain('id="posts-output"');
		expect(markup).toContain('id="posts-empty"');
		expect(markup).toContain('id="pagination"');
	});

	test('exposes the accessible screen title from the provided argument', () => {
		expect(markup).toContain('Latest discussions');
		expect(markup).toContain('id="screen-feed-title"');
	});

	// B02 — comments must never render in the feed; they belong only to post detail.
	test('does not render any comment affordances in the feed (B02 regression)', () => {
		expect(markup).not.toContain('data-comments');
		expect(markup).not.toContain('comment-form');
		expect(markup).not.toContain('name="body"');
		expect(markup).not.toMatch(/<textarea/i);
		expect(markup.toLowerCase()).not.toContain('post comment');
	});
});
