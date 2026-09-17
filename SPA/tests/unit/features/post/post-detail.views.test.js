import { describe, expect, test } from 'vitest';
import { IMAGE_ACCEPT_ATTR } from '../../../../core/shared/utils.js';
import { renderPostDetailView } from '../../../../features/post/post-detail.views.js';

describe('renderPostDetailView', () => {
	test('renders the post-detail screen with title, author profile link, and body', () => {
		const markup = renderPostDetailView({
			id: 42,
			title: 'Hello world',
			body: 'A body',
			user_id: 7,
			username: 'alex',
			created_at: '2026-06-12T10:00:00Z',
		});

		expect(markup).toContain('data-screen="post-detail"');
		expect(markup).toContain('data-post-id="42"');
		expect(markup).toContain('Hello world');
		expect(markup).toContain('A body');
		expect(markup).toContain('href="/profile/7"');
		expect(markup).toContain('alex');
	});

	// B02/B03 — comments render only on post detail, never in the feed.
	test('renders the comment region and composer that the feed must not have (B03 regression)', () => {
		const markup = renderPostDetailView({ id: 1, title: 'T', body: 'B' });

		expect(markup).toContain('data-comments');
		expect(markup).toContain('id="comment-form"');
		expect(markup).toContain('name="body"');
		expect(markup).toContain('Post comment');
	});

	test('exposes a comment image-upload input constrained to the shared accept list', () => {
		const markup = renderPostDetailView({ id: 1, title: 'T', body: 'B' });

		expect(markup).toContain('class="comment-image-input"');
		expect(markup).toContain('type="file"');
		expect(markup).toContain(`accept="${IMAGE_ACCEPT_ATTR}"`);
		expect(markup).toContain('comment-image-preview');
	});

	test('escapes attacker-controlled title and body to prevent injection', () => {
		const markup = renderPostDetailView({
			id: 1,
			title: '<script>alert(1)</script>',
			body: '<img src=x onerror=1>',
			username: '<b>x</b>',
		});

		expect(markup).not.toContain('<script>alert(1)</script>');
		expect(markup).toContain('&lt;script&gt;');
		expect(markup).not.toContain('<img src=x onerror=1>');
		expect(markup).toContain('&lt;b&gt;x&lt;/b&gt;');
	});

	test('falls back to safe defaults when no post fields are provided', () => {
		const markup = renderPostDetailView();

		expect(markup).toContain('Post Detail');
		expect(markup).toContain('data-screen="post-detail"');
	});
});
