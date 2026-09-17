// SPA/tests/unit/features/post/post.reactions.bindings.test.js

import { beforeEach, describe, expect, test, vi } from 'vitest';

// The reaction handler gates on `target instanceof Element`; the node test
// environment has no DOM globals, so expose a base Element the fake nodes
// extend. Must be installed before the bindings module reads `Element`.
class Element {}
globalThis.Element = Element;

// Minimal element shim supporting the DOM surface the reaction bindings use:
// closest(), querySelector() against an explicit registry, get/setAttribute for
// the aria-pressed active-state hook, and the textContent the handler writes.
class FakeNode extends Element {
	constructor({ tag = 'div', className = '', dataset = {}, attributes = {} } = {}) {
		super();
		this.tag = tag.toUpperCase();
		this.className = className;
		this.dataset = { ...dataset };
		this.attributes = { ...attributes };
		this.parentElement = null;
		this.children = [];
		this.textContent = '';
		this._bySelector = new Map();
	}

	append(child) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	register(selector, node) {
		this._bySelector.set(selector, node);
	}

	getAttribute(name) {
		return this.attributes[name] ?? null;
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	matches(selector) {
		// Handles `.class`, `tag[data-x]`, `[data-x]`, and comma-separated lists.
		return selector.split(',').some((part) => {
			const trimmed = part.trim();
			const attrMatch = trimmed.match(/^([a-z]*)\[data-([a-z-]+)\]$/i);
			if (attrMatch) {
				const [, tag, attr] = attrMatch;
				const key = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
				const tagOk = !tag || this.tag === tag.toUpperCase();
				return tagOk && this.dataset[key] !== undefined;
			}
			if (trimmed.startsWith('.')) {
				return this.className.split(/\s+/).includes(trimmed.slice(1));
			}
			return false;
		});
	}

	closest(selector) {
		let node = this;
		while (node) {
			if (node.matches(selector)) {
				return node;
			}
			node = node.parentElement;
		}
		return null;
	}

	querySelector(selector) {
		return this._bySelector.get(selector) ?? null;
	}
}

function reactionButton(type, active) {
	return new FakeNode({
		tag: 'button',
		className: `reaction-toggle reaction-toggle--${type}`,
		dataset: { reaction: type },
		attributes: { 'aria-pressed': active ? 'true' : 'false' },
	});
}

// Builds a post-reaction fixture mirroring the real SPA markup: a container
// carrying data-post-id wraps a .reactions[data-reaction-scope="post"] element,
// which holds the reaction buttons. The buttons carry NO id of their own — the
// listener resolves the post id from the container via the data-reaction-scope
// hook. `rootTag` exercises both <article data-post-id> (feed/activity) and
// <section data-post-id> (post detail).
function buildPostFixture({ rootTag = 'article', initialReaction = '' } = {}) {
	const root = new FakeNode({ tag: rootTag, className: 'post', dataset: { postId: '42' } });
	const reactions = new FakeNode({
		tag: 'div',
		className: 'reactions',
		dataset: { reactionScope: 'post' },
	});
	root.append(reactions);

	const likeButton = reactionButton('like', initialReaction === 'like');
	const dislikeButton = reactionButton('dislike', initialReaction === 'dislike');
	reactions.append(likeButton);
	reactions.append(dislikeButton);

	const likeCount = new FakeNode({ tag: 'span', dataset: { likeCount: '' } });
	const dislikeCount = new FakeNode({ tag: 'span', dataset: { dislikeCount: '' } });
	root.register('[data-like-count]', likeCount);
	root.register('[data-dislike-count]', dislikeCount);
	root.register('[data-reaction="like"]', likeButton);
	root.register('[data-reaction="dislike"]', dislikeButton);
	reactions.register('[data-like-count]', likeCount);
	reactions.register('[data-dislike-count]', dislikeCount);
	reactions.register('[data-reaction="like"]', likeButton);
	reactions.register('[data-reaction="dislike"]', dislikeButton);

	return { root, likeButton, dislikeButton, likeCount, dislikeCount };
}

// Builds a comment-reaction fixture mirroring the post-detail comment markup:
// an <article class="comment" data-comment-id> container wraps a
// .reactions[data-reaction-scope="comment"] element holding the buttons. The
// buttons carry no id; the listener resolves the comment id from the container
// via the data-reaction-scope hook.
function buildCommentFixture({ initialReaction = '' } = {}) {
	const root = new FakeNode({ tag: 'article', className: 'comment', dataset: { commentId: '7' } });
	const reactions = new FakeNode({
		tag: 'div',
		className: 'reactions',
		dataset: { reactionScope: 'comment' },
	});
	root.append(reactions);

	const likeButton = reactionButton('like', initialReaction === 'like');
	const dislikeButton = reactionButton('dislike', initialReaction === 'dislike');
	reactions.append(likeButton);
	reactions.append(dislikeButton);

	const likeCount = new FakeNode({ tag: 'span', dataset: { likeCount: '' } });
	const dislikeCount = new FakeNode({ tag: 'span', dataset: { dislikeCount: '' } });
	root.register('[data-like-count]', likeCount);
	root.register('[data-dislike-count]', dislikeCount);
	root.register('[data-reaction="like"]', likeButton);
	root.register('[data-reaction="dislike"]', dislikeButton);
	reactions.register('[data-like-count]', likeCount);
	reactions.register('[data-dislike-count]', dislikeCount);
	reactions.register('[data-reaction="like"]', likeButton);
	reactions.register('[data-reaction="dislike"]', dislikeButton);

	return { root, likeButton, dislikeButton, likeCount, dislikeCount };
}

function reactionResponse(likes, dislikes) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: { likes_count: likes, dislikes_count: dislikes } }),
	};
}

describe('reaction bindings on post-detail and feed scopes', () => {
	let clickHandler;
	let fetchRef;

	beforeEach(async () => {
		clickHandler = null;
		const documentRef = {
			addEventListener: (type, handler) => {
				if (type === 'click') {
					clickHandler = handler;
				}
			},
		};
		// The bindings module guards init with a module-level flag, so reset the
		// module registry per test to get a fresh, un-initialized instance and
		// capture the freshly registered click handler.
		vi.resetModules();
		const { initReactionBindings } = await import(
			'../../../../features/post/post.reactions.bindings.js'
		);
		fetchRef = vi.fn();
		initReactionBindings({ documentRef, fetchRef });

		// /users/me gate returns an authenticated user for every test by default.
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve(reactionResponse(1, 0));
		});
	});

	async function click(button) {
		// Buttons are not auto-toggled by the browser; the handler reads the
		// current aria-pressed state and writes the next one only on success. The
		// registered listener fires `void handleReactionClick(...)` and returns
		// synchronously, so await the async chain it starts by yielding to the
		// event loop until it settles.
		clickHandler({ target: button, stopPropagation() {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	test.each([
		['article'],
		['section'],
	])('like works inside <%s data-post-id> scope', async (rootTag) => {
		const fx = buildPostFixture({ rootTag });
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve(reactionResponse(1, 0));
		});

		await click(fx.likeButton);

		expect(fetchRef).toHaveBeenCalledWith(
			expect.stringContaining('/posts/42/like'),
			expect.objectContaining({ method: 'POST' }),
		);
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('false');
		expect(fx.likeCount.textContent).toBe('1');
		expect(fx.dislikeCount.textContent).toBe('0');
	});

	test('dislike works on the detail section scope', async () => {
		const fx = buildPostFixture({ rootTag: 'section' });
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve(reactionResponse(0, 1));
		});

		await click(fx.dislikeButton);

		expect(fetchRef).toHaveBeenCalledWith(
			expect.stringContaining('/posts/42/dislike'),
			expect.objectContaining({ method: 'POST' }),
		);
		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('false');
		expect(fx.dislikeCount.textContent).toBe('1');
	});

	test('switching from like to dislike clears the opposite', async () => {
		const fx = buildPostFixture({ rootTag: 'section', initialReaction: 'like' });
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve(reactionResponse(0, 1));
		});

		await click(fx.dislikeButton);

		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('false');
		expect(fx.likeCount.textContent).toBe('0');
		expect(fx.dislikeCount.textContent).toBe('1');
	});

	test('clearing the active reaction leaves it intact on a failed request', async () => {
		const fx = buildPostFixture({ rootTag: 'section', initialReaction: 'like' });
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
		});

		await click(fx.likeButton);

		// Request failed → state is never mutated, so the existing reaction stays.
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.likeCount.textContent).toBe('');
	});

	test('unauthenticated user does not post a reaction or change state', async () => {
		const fx = buildPostFixture({ rootTag: 'section' });
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
			}
			return Promise.resolve(reactionResponse(1, 0));
		});

		await click(fx.likeButton);

		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('false');
		expect(fetchRef).not.toHaveBeenCalledWith(
			expect.stringContaining('/posts/42/like'),
			expect.anything(),
		);
	});

	test('rapid clicks while a reaction is in flight only send one mutation', async () => {
		const fx = buildPostFixture({ rootTag: 'section' });
		let resolveReaction;
		const reactionDone = new Promise((resolve) => {
			resolveReaction = resolve;
		});
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return reactionDone;
		});

		clickHandler({ target: fx.likeButton, stopPropagation() {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
		clickHandler({ target: fx.likeButton, stopPropagation() {} });
		await Promise.resolve();

		expect(fetchRef.mock.calls.filter(([url]) => url.includes('/posts/42/like'))).toHaveLength(1);

		resolveReaction(reactionResponse(1, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.likeCount.textContent).toBe('1');
	});

	test('opposite lookup is scoped to the current reaction wrapper', async () => {
		const fx = buildPostFixture({ rootTag: 'section', initialReaction: 'like' });
		const unrelatedDislike = reactionButton('dislike', true);
		fx.root.register('[data-reaction="dislike"]', unrelatedDislike);
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve(reactionResponse(0, 1));
		});

		await click(fx.dislikeButton);

		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('false');
		expect(unrelatedDislike.getAttribute('aria-pressed')).toBe('true');
	});
});

describe('reaction bindings on post-detail comment scope', () => {
	let clickHandler;
	let fetchRef;

	beforeEach(async () => {
		clickHandler = null;
		const documentRef = {
			addEventListener: (type, handler) => {
				if (type === 'click') {
					clickHandler = handler;
				}
			},
		};
		vi.resetModules();
		const { initReactionBindings } = await import(
			'../../../../features/post/post.reactions.bindings.js'
		);
		fetchRef = vi.fn();
		initReactionBindings({ documentRef, fetchRef });
	});

	async function click(button) {
		clickHandler({ target: button, stopPropagation() {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	function authedFetch(reactionResp) {
		fetchRef.mockImplementation((url) => {
			if (url.includes('/users/me')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: { id: 1 } }) });
			}
			return Promise.resolve(reactionResp);
		});
	}

	test('comment like posts to the comment endpoint and updates count', async () => {
		const fx = buildCommentFixture();
		authedFetch(reactionResponse(1, 0));

		await click(fx.likeButton);

		expect(fetchRef).toHaveBeenCalledWith(
			expect.stringContaining('/comments/7/like'),
			expect.objectContaining({ method: 'POST' }),
		);
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('false');
		expect(fx.likeCount.textContent).toBe('1');
	});

	test('comment dislike posts to the comment endpoint and updates count', async () => {
		const fx = buildCommentFixture();
		authedFetch(reactionResponse(0, 1));

		await click(fx.dislikeButton);

		expect(fetchRef).toHaveBeenCalledWith(
			expect.stringContaining('/comments/7/dislike'),
			expect.objectContaining({ method: 'POST' }),
		);
		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.dislikeCount.textContent).toBe('1');
	});

	test('switching comment reaction clears the opposite', async () => {
		const fx = buildCommentFixture({ initialReaction: 'like' });
		authedFetch(reactionResponse(0, 1));

		await click(fx.dislikeButton);

		expect(fx.dislikeButton.getAttribute('aria-pressed')).toBe('true');
		expect(fx.likeButton.getAttribute('aria-pressed')).toBe('false');
		expect(fx.dislikeCount.textContent).toBe('1');
	});

	test('re-rendered comments still react via the delegated listener', async () => {
		authedFetch(reactionResponse(1, 0));

		// First render: react successfully.
		const first = buildCommentFixture();
		await click(first.likeButton);
		expect(first.likeButton.getAttribute('aria-pressed')).toBe('true');

		// Simulate reloadComments() replacing the markup with a fresh comment node.
		// The listener is delegated at the document level, so no re-binding occurs
		// and the new node reacts without a duplicate listener being attached.
		const second = buildCommentFixture();
		await click(second.likeButton);

		expect(second.likeButton.getAttribute('aria-pressed')).toBe('true');
		expect(second.likeCount.textContent).toBe('1');
	});
});
