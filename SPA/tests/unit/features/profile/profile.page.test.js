// SPA/tests/unit/features/profile/profile.page.test.js

import { describe, expect, test, vi } from 'vitest';
import { initProfilePage } from '../../../../features/profile/profile.page.js';

describe('Profile page error state and navigation', () => {
	test('renders not-found state without inline onclick and handles back button click', async () => {
		const mockHistory = { back: vi.fn() };
		const windowRef = { history: mockHistory };

		let contentInnerHTML = '';
		const contentClassList = new Set(['skeleton-content']);
		const contentEl = {
			set innerHTML(val) {
				contentInnerHTML = val;
			},
			get innerHTML() {
				return contentInnerHTML;
			},
			classList: {
				remove: (cls) => contentClassList.delete(cls),
				contains: (cls) => contentClassList.has(cls),
			},
		};

		let clickListener = null;
		const root = {
			getAttribute: (name) => {
				if (name === 'data-user-id') return '999999';
				return null;
			},
			setAttribute: vi.fn(),
			querySelector: (sel) => {
				if (sel === '#profile-content') return contentEl;
				return null;
			},
			addEventListener: (event, handler) => {
				if (event === 'click') clickListener = handler;
			},
		};

		const documentRef = {
			querySelector: (sel) => {
				if (sel === '[data-screen="profile"]') return root;
				return null;
			},
		};

		const fetchRef = vi.fn(async () => ({ ok: false, status: 404 }));

		const res = initProfilePage({ windowRef, documentRef, fetchRef });
		expect(res).not.toBeNull();

		// Wait for renderProfileData to resolve
		await Promise.resolve();
		await Promise.resolve();

		expect(contentInnerHTML).toContain('User not found');
		expect(contentInnerHTML).not.toContain('onclick=');
		expect(contentInnerHTML).toContain('data-action="back"');

		// Verify back button event listener
		expect(clickListener).toBeTypeOf('function');
		const fakeButton = {
			closest: (sel) => (sel === '[data-action="back"]' ? fakeButton : null),
		};
		const fakeEvent = {
			target: fakeButton,
			preventDefault: vi.fn(),
		};
		clickListener(fakeEvent);

		expect(fakeEvent.preventDefault).toHaveBeenCalled();
		expect(mockHistory.back).toHaveBeenCalledTimes(1);
	});
});
