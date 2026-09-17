// SPA/features/post/comment-highlight.js

const HIGHLIGHT_CLASS = 'highlight-comment';
const FADE_OUT_CLASS = 'fade-out';
const MAX_ATTEMPTS = 20;
const ATTEMPT_DELAY_MS = 50;
const FADE_OUT_AFTER_MS = 2500;

function readHighlightParam(windowRef) {
	const search = windowRef?.location?.search;
	if (typeof search !== 'string' || !search) {
		return null;
	}
	const value = new URLSearchParams(search).get('highlight');
	return value || null;
}

// SPA comments render as <article class="comment" data-comment-id="{id}">, unlike
// the legacy "#comment-{id}" selector. Resolve both intents against the SPA markup.
function findCommentNode(root, highlight) {
	if (highlight === 'last') {
		const comments = root.querySelectorAll('.comment');
		return comments.length > 0 ? comments[comments.length - 1] : null;
	}

	const numericId = Number(highlight);
	if (!Number.isFinite(numericId) || numericId <= 0) {
		return null;
	}

	return root.querySelector(`[data-comment-id="${numericId}"]`);
}

function applyHighlight(node, setTimeoutRef) {
	if (typeof node.scrollIntoView === 'function') {
		node.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
	node.classList.add(HIGHLIGHT_CLASS);

	setTimeoutRef(() => {
		node.classList.add(FADE_OUT_CLASS);
	}, FADE_OUT_AFTER_MS);
}

// Comments load asynchronously after the post shell renders, so retry until the
// target node exists (mirrors the legacy retry loop) or attempts are exhausted.
export async function highlightCommentFromQuery(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const root = options.root ?? documentRef;

	if (!windowRef || !root || typeof root.querySelector !== 'function') {
		return null;
	}

	const highlight = readHighlightParam(windowRef);
	if (!highlight) {
		return null;
	}

	const setTimeoutRef =
		typeof options.setTimeoutRef === 'function'
			? options.setTimeoutRef
			: windowRef.setTimeout.bind(windowRef);
	const waitRef =
		typeof options.waitRef === 'function'
			? options.waitRef
			: (ms) => new Promise((resolve) => setTimeoutRef(resolve, ms));
	const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : MAX_ATTEMPTS;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const node = findCommentNode(root, highlight);
		if (node) {
			applyHighlight(node, setTimeoutRef);
			return node;
		}
		await waitRef(ATTEMPT_DELAY_MS);
	}

	return null;
}
