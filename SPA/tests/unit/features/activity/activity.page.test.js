import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

var deleteActivityComment;
var deleteActivityPost;
var getActivityQueryState;
var getCurrentUserID;
var loadActivity;
var setActivityPostStatus;
var setActivityQueryState;
var updateActivityComment;
var setupImagePicker;
var initReactionBindings;

const OriginalElement = globalThis.Element;
const OriginalHTMLElement = globalThis.HTMLElement;

vi.mock('../../../../features/activity/activity.api.js', () => {
	deleteActivityComment = vi.fn();
	deleteActivityPost = vi.fn();
	getActivityQueryState = vi.fn(() => ({ page: 1, perPage: 10, status: 'all' }));
	getCurrentUserID = vi.fn(async () => 0);
	loadActivity = vi.fn();
	setActivityPostStatus = vi.fn();
	setActivityQueryState = vi.fn();
	updateActivityComment = vi.fn();

	return {
		deleteActivityComment,
		deleteActivityPost,
		getActivityQueryState,
		getCurrentUserID,
		loadActivity,
		setActivityPostStatus,
		setActivityQueryState,
		updateActivityComment,
	};
});

vi.mock('../../../../core/shared/image-picker.js', () => {
	setupImagePicker = vi.fn(() => ({
		getFile: () => null,
		clearSelectedFile: vi.fn(),
		destroy: vi.fn(),
	}));

	return { setupImagePicker };
});

vi.mock('../../../../features/post/post.reactions.bindings.js', () => {
	initReactionBindings = vi.fn();

	return { initReactionBindings };
});

vi.mock('../../../../core/ui/pagination.js', () => ({
	clampPage: (page) => page,
	getPageWindow: () => [],
	nextPage: (page) => page + 1,
	previousPage: (page) => Math.max(1, page - 1),
}));

import { initActivityPage } from '../../../../features/activity/activity.page.js';

// Minimal DOM node modelling the subset of the API the controller touches.
class FakeNode {
	constructor(tag = 'div') {
		this.tag = tag;
		this.dataset = {};
		this.attributes = new Map();
		this.children = [];
		this.listeners = new Map();
		this.hidden = false;
		this._innerHTML = '';
		this.textContent = '';
		this.disabled = false;
		this.value = '';
		this.type = '';
		this.files = [];
		this.parentNode = null;
		this.ownerDocument = null;
		this._classes = new Set();
		this.classList = {
			add: (...names) => {
				for (const name of names) this._classes.add(name);
			},
			remove: (...names) => {
				for (const name of names) this._classes.delete(name);
			},
			contains: (name) => this._classes.has(name),
		};
	}

	set innerHTML(value) {
		this._innerHTML = value;
		if (value === '') this.children = [];
	}

	get innerHTML() {
		return this._innerHTML;
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	addEventListener(type, handler, capture) {
		this.listeners.set(`${type}:${capture ? 'capture' : 'bubble'}`, handler);
	}

	appendChild(child) {
		this.children.push(child);
		child.parentNode = this;
		return child;
	}

	closest(selector) {
		// selector is one of '[data-action]' or '.activity-comment'
		let node = this;
		while (node) {
			if (selector === '[data-action]' && node.dataset.action) return node;
			if (selector === '.activity-comment' && node._classes.has('activity-comment')) {
				return node;
			}
			node = node.parentNode;
		}
		return null;
	}

	querySelector() {
		return null;
	}

	querySelectorAll() {
		return [];
	}

	dispatchClick(target) {
		const handler = this.listeners.get('click:capture') ?? this.listeners.get('click:bubble');
		const event = { target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
		handler?.(event);
		return event;
	}
}

function createActivityDom() {
	const elementsById = new Map();

	const root = new FakeNode('section');
	root._classes.add('activity-screen');

	const documentRef = {
		querySelector(selector) {
			if (selector === '[data-screen="activity"]') return root;
			return null;
		},
		getElementById(id) {
			return elementsById.get(id) ?? null;
		},
		createElement(tag) {
			const node = new FakeNode(tag);
			node.ownerDocument = documentRef;
			return node;
		},
	};

	root.ownerDocument = documentRef;

	// The controller queries a handful of optional controls; default them to null
	// so it walks the "no control present" branches cleanly.
	root.querySelector = () => null;
	root.querySelectorAll = () => [];

	return { documentRef, root, elementsById };
}

const ACTIVITY_DATA = {
	created_posts: { items: [], pagination: { total: 0, total_pages: 1 } },
	comments: { items: [], pagination: { total: 0, total_pages: 1 } },
	liked_posts: { items: [], pagination: { total: 0, total_pages: 1 } },
	disliked_posts: { items: [], pagination: { total: 0, total_pages: 1 } },
};

// Drain enough microtask turns for the init IIFE and the runAction chain
// (getCurrentUserID -> refresh -> loadActivity, each awaited) to settle.
async function flush() {
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	deleteActivityComment.mockReset().mockResolvedValue({ ok: true, status: 200 });
	deleteActivityPost.mockReset().mockResolvedValue({ ok: true, status: 200 });
	getActivityQueryState.mockReset().mockReturnValue({ page: 1, perPage: 10, status: 'all' });
	getCurrentUserID.mockReset().mockResolvedValue(0);
	loadActivity.mockReset().mockResolvedValue({ ok: true, status: 200, data: ACTIVITY_DATA });
	setActivityPostStatus.mockReset().mockResolvedValue({ ok: true, status: 200 });
	setActivityQueryState.mockReset();
	updateActivityComment.mockReset().mockResolvedValue({ ok: true, status: 200 });
	setupImagePicker.mockClear();
	initReactionBindings.mockClear();

	globalThis.Element = FakeNode;
	globalThis.HTMLElement = FakeNode;
});

afterEach(() => {
	globalThis.Element = OriginalElement;
	globalThis.HTMLElement = OriginalHTMLElement;
});

describe('initActivityPage', () => {
	test('bails out without a window/document/fetch trio', () => {
		expect(initActivityPage({ windowRef: null, documentRef: null, fetchRef: null })).toBeNull();
	});

	test('returns null when the activity screen root is absent', () => {
		const windowRef = { location: { pathname: '/activity', search: '' } };
		const documentRef = { querySelector: () => null };
		expect(initActivityPage({ windowRef, documentRef, fetchRef: vi.fn() })).toBeNull();
	});

	test('does not re-bind an already-bound root', () => {
		const { documentRef, root } = createActivityDom();
		root.setAttribute('data-activity-bound', 'true');
		const windowRef = { location: { pathname: '/activity', search: '' } };

		const result = initActivityPage({ windowRef, documentRef, fetchRef: vi.fn() });

		expect(result).toBeNull();
		expect(loadActivity).not.toHaveBeenCalled();
	});

	test('loads the current user and activity data on init', async () => {
		const { documentRef, root } = createActivityDom();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/activity', search: '' } };

		const controller = initActivityPage({ windowRef, documentRef, fetchRef });
		await flush();

		expect(controller).not.toBeNull();
		expect(root.getAttribute('data-activity-bound')).toBe('true');
		expect(getCurrentUserID).toHaveBeenCalledWith(fetchRef);
		expect(loadActivity).toHaveBeenCalledWith(fetchRef, windowRef, controller.state);
		expect(initReactionBindings).toHaveBeenCalledWith({ documentRef, fetchRef });
	});

	test('surfaces an error message when activity loading fails', async () => {
		const { documentRef, root, elementsById } = createActivityDom();
		const feedback = new FakeNode();
		root.querySelector = (selector) => (selector === '[data-activity-feedback]' ? feedback : null);
		void elementsById;
		loadActivity.mockResolvedValue({ ok: false, status: 500, data: null });
		const windowRef = { location: { pathname: '/activity', search: '' } };

		initActivityPage({ windowRef, documentRef, fetchRef: vi.fn() });
		await flush();

		expect(feedback.textContent).toBe('Failed to load activity.');
		expect(feedback.getAttribute('role')).toBe('alert');
	});

	describe('data-action dispatch', () => {
		test('status toggle PATCHes the flipped status and refreshes', async () => {
			const { documentRef, root } = createActivityDom();
			const fetchRef = vi.fn();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			initActivityPage({ windowRef, documentRef, fetchRef });
			await flush();
			loadActivity.mockClear();

			const button = new FakeNode('button');
			button.dataset.action = 'status-toggle';
			button.dataset.postId = '42';
			button.dataset.currentStatus = 'draft';

			root.dispatchClick(button);
			await flush();
			await flush();

			expect(setActivityPostStatus).toHaveBeenCalledWith(fetchRef, '42', 'published');
			expect(loadActivity).toHaveBeenCalledTimes(1);
			expect(button.disabled).toBe(false);
		});

		test('status toggle flips published back to draft', async () => {
			const { documentRef, root } = createActivityDom();
			const fetchRef = vi.fn();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			initActivityPage({ windowRef, documentRef, fetchRef });
			await flush();

			const button = new FakeNode('button');
			button.dataset.action = 'status-toggle';
			button.dataset.postId = '7';
			button.dataset.currentStatus = 'published';

			root.dispatchClick(button);
			await flush();

			expect(setActivityPostStatus).toHaveBeenCalledWith(fetchRef, '7', 'draft');
		});

		test('does not refresh when the status mutation fails', async () => {
			const { documentRef, root } = createActivityDom();
			const fetchRef = vi.fn();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			setActivityPostStatus.mockResolvedValue({ ok: false, status: 403 });

			initActivityPage({ windowRef, documentRef, fetchRef });
			await flush();
			loadActivity.mockClear();

			const button = new FakeNode('button');
			button.dataset.action = 'status-toggle';
			button.dataset.postId = '42';
			button.dataset.currentStatus = 'draft';

			root.dispatchClick(button);
			await flush();
			await flush();

			expect(setActivityPostStatus).toHaveBeenCalled();
			expect(loadActivity).not.toHaveBeenCalled();
			expect(button.disabled).toBe(false);
		});

		test('delete post DELETEs by id and refreshes', async () => {
			const { documentRef, root } = createActivityDom();
			const fetchRef = vi.fn();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			initActivityPage({ windowRef, documentRef, fetchRef });
			await flush();
			loadActivity.mockClear();

			const button = new FakeNode('button');
			button.dataset.action = 'delete-post';
			button.dataset.postId = '99';

			root.dispatchClick(button);
			await flush();
			await flush();

			expect(deleteActivityPost).toHaveBeenCalledWith(fetchRef, '99');
			expect(loadActivity).toHaveBeenCalledTimes(1);
		});

		test('delete comment DELETEs by id and refreshes', async () => {
			const { documentRef, root } = createActivityDom();
			const fetchRef = vi.fn();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			initActivityPage({ windowRef, documentRef, fetchRef });
			await flush();
			loadActivity.mockClear();

			const button = new FakeNode('button');
			button.dataset.action = 'delete-comment';
			button.dataset.commentId = '13';

			root.dispatchClick(button);
			await flush();
			await flush();

			expect(deleteActivityComment).toHaveBeenCalledWith(fetchRef, '13');
			expect(loadActivity).toHaveBeenCalledTimes(1);
		});

		test('ignores clicks without a data-action target', async () => {
			const { documentRef, root } = createActivityDom();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			initActivityPage({ windowRef, documentRef, fetchRef: vi.fn() });
			await flush();
			loadActivity.mockClear();

			const plain = new FakeNode('span');
			root.dispatchClick(plain);
			await flush();

			expect(setActivityPostStatus).not.toHaveBeenCalled();
			expect(deleteActivityPost).not.toHaveBeenCalled();
			expect(deleteActivityComment).not.toHaveBeenCalled();
			expect(loadActivity).not.toHaveBeenCalled();
		});

		test('status toggle is a no-op when the post id is missing', async () => {
			const { documentRef, root } = createActivityDom();
			const windowRef = { location: { pathname: '/activity', search: '' } };

			initActivityPage({ windowRef, documentRef, fetchRef: vi.fn() });
			await flush();

			const button = new FakeNode('button');
			button.dataset.action = 'status-toggle';
			button.dataset.currentStatus = 'draft';

			root.dispatchClick(button);
			await flush();

			expect(setActivityPostStatus).not.toHaveBeenCalled();
		});
	});
});
