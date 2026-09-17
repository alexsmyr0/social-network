// SPA/tests/unit/features/post/comment-highlight.test.js

import { describe, expect, test, vi } from 'vitest';
import { highlightCommentFromQuery } from '../../../../features/post/comment-highlight.js';

class FakeClassList {
	constructor() {
		this.set = new Set();
	}
	add(...names) {
		for (const name of names) this.set.add(name);
	}
	contains(name) {
		return this.set.has(name);
	}
}

function makeComment(id) {
	return {
		dataset: { commentId: String(id) },
		classList: new FakeClassList(),
		scrollIntoView: vi.fn(),
		getAttribute: (name) => (name === 'data-comment-id' ? String(id) : null),
	};
}

// Root that resolves comments by data-comment-id and .comment, and can be told
// to "render" comments after N polls to simulate async loading.
function makeRoot(comments, { availableAfter = 0 } = {}) {
	let polls = 0;
	return {
		querySelector(selector) {
			if (polls < availableAfter) return null;
			const match = /\[data-comment-id="(\d+)"\]/.exec(selector);
			if (!match) return null;
			return comments.find((c) => c.dataset.commentId === match[1]) ?? null;
		},
		querySelectorAll(selector) {
			if (selector !== '.comment') return [];
			if (polls < availableAfter) return [];
			return comments;
		},
		notePoll() {
			polls += 1;
		},
	};
}

function windowWith(search) {
	return {
		location: { search },
		setTimeout: (fn) => {
			fn();
			return 1;
		},
	};
}

const immediateWait = () => Promise.resolve();

describe('highlightCommentFromQuery', () => {
	test('no highlight param is a no-op', async () => {
		const result = await highlightCommentFromQuery({
			windowRef: windowWith(''),
			root: makeRoot([makeComment(1)]),
			waitRef: immediateWait,
		});
		expect(result).toBeNull();
	});

	test('highlights a specific comment by id (SPA data-comment-id selector)', async () => {
		const comment = makeComment(42);
		const result = await highlightCommentFromQuery({
			windowRef: windowWith('?highlight=42'),
			root: makeRoot([makeComment(1), comment]),
			waitRef: immediateWait,
		});

		expect(result).toBe(comment);
		expect(comment.classList.contains('highlight-comment')).toBe(true);
		expect(comment.classList.contains('fade-out')).toBe(true);
		expect(comment.scrollIntoView).toHaveBeenCalled();
	});

	test('highlight=last targets the final comment', async () => {
		const last = makeComment(9);
		const result = await highlightCommentFromQuery({
			windowRef: windowWith('?highlight=last'),
			root: makeRoot([makeComment(7), makeComment(8), last]),
			waitRef: immediateWait,
		});

		expect(result).toBe(last);
		expect(last.classList.contains('highlight-comment')).toBe(true);
	});

	test('retries until async-rendered comments appear', async () => {
		const comment = makeComment(5);
		const root = makeRoot([comment], { availableAfter: 3 });
		const waitRef = vi.fn(async () => {
			root.notePoll();
		});

		const result = await highlightCommentFromQuery({
			windowRef: windowWith('?highlight=5'),
			root,
			waitRef,
		});

		expect(result).toBe(comment);
		expect(waitRef).toHaveBeenCalledTimes(3);
	});

	test('gives up after max attempts when the comment never renders', async () => {
		const root = makeRoot([makeComment(1)], { availableAfter: 999 });
		const waitRef = vi.fn(async () => root.notePoll());

		const result = await highlightCommentFromQuery({
			windowRef: windowWith('?highlight=1'),
			root,
			waitRef,
			maxAttempts: 4,
		});

		expect(result).toBeNull();
		expect(waitRef).toHaveBeenCalledTimes(4);
	});
});
