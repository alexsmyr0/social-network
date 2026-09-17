// SPA/tests/unit/features/profile/profile.views.test.js

import { describe, expect, test } from 'vitest';
import {
	renderProfileAvatar,
	renderProfileContent,
} from '../../../../features/profile/profile.views.js';

describe('Profile views', () => {
	const mockProfile = {
		user_id: 42,
		username: 'testuser',
		first_name: 'Test',
		last_name: 'User',
		age: 25,
		gender: 'other',
	};

	test('renderProfileContent displays all required fields', () => {
		const html = renderProfileContent(mockProfile);
		expect(html).toContain('Test User');
		expect(html).toContain('@testuser');
		expect(html).toContain('25');
		expect(html).toContain('Other'); // Capitalized
		expect(html).toContain('#42');
	});

	test('renderProfileAvatar uses first letter of username', () => {
		const html = renderProfileAvatar(mockProfile);
		expect(html).toContain('T');
	});

	test('renderProfileAvatar falls back to U if username is missing', () => {
		const html = renderProfileAvatar({});
		expect(html).toContain('U');
	});

	test('renderProfileContent escapes HTML to prevent XSS', () => {
		const maliciousProfile = {
			...mockProfile,
			first_name: '<script>alert("xss")</script>',
			last_name: '<b>Doe</b>',
		};
		const html = renderProfileContent(maliciousProfile);
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<b>');
		expect(html).toContain('&lt;b&gt;');
	});
});
