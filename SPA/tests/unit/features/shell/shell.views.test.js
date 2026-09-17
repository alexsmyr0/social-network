import { describe, expect, test } from 'vitest';
import { renderAuthenticatedShell } from '../../../../features/shell/shell.views.js';

describe('renderAuthenticatedShell', () => {
	const markup = renderAuthenticatedShell('<section data-screen="feed"></section>');

	// A06/D05 — logout must be visible on every authenticated route.
	test('always renders the logout control inside the authenticated shell', () => {
		expect(markup).toContain('data-action="logout"');
		expect(markup).toContain('app-shell__logout');
		expect(markup.toLowerCase()).toContain('logout');
	});

	test('renders the persistent forum navigation', () => {
		expect(markup).toContain('href="/"');
		expect(markup).toContain('href="/create-post"');
		expect(markup).toContain('href="/activity"');
	});

	test('reserves the chat roster and active-conversation regions in the shell', () => {
		expect(markup).toContain('data-chat-roster');
		expect(markup).toContain('data-chat-active');
		expect(markup).toContain('id="roster-list"');
	});

	test('renders the notification bell and injects the provided page content', () => {
		expect(markup).toContain('data-auth-shell');
		expect(markup).toContain('<section data-screen="feed"></section>');
	});
});
