import { describe, expect, test, vi } from 'vitest';
import { renderPostCard } from '../../../../features/post/post-card.views.js';

class FakeElement {
	constructor(tagName = 'article') {
		this.tagName = tagName.toUpperCase();
		this.className = '';
		this.dataset = {};
		this.innerHTML = '';
		this.listeners = new Map();
	}

	addEventListener(type, handler) {
		this.listeners.set(type, handler);
	}

	querySelectorAll() {
		return [];
	}
}

function createDocumentRef() {
	return {
		createElement: vi.fn((tagName) => new FakeElement(tagName)),
	};
}

describe('renderPostCard image rendering', () => {
	test('renders upload-backed images in CSS url and img contexts', () => {
		const card = renderPostCard(createDocumentRef(), {
			id: 1,
			title: 'Safe image',
			body: 'Body',
			image_url: '/static/uploads/photo.png',
		});

		expect(card.innerHTML).toContain("background-image: url('/static/uploads/photo.png')");
		expect(card.innerHTML).toContain('src="/static/uploads/photo.png"');
	});

	test('does not render non-upload image URLs into the CSS url context', () => {
		const card = renderPostCard(createDocumentRef(), {
			id: 1,
			title: 'Unsafe image',
			body: 'Body',
			image_url: "javascript:alert('x')",
		});

		expect(card.innerHTML).not.toContain('background-image');
		expect(card.innerHTML).not.toContain('javascript:alert');
	});
});
