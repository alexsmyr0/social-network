import { getCurrentUser, postReaction } from './post.reactions.api.js';
import {
	applyReactionSelection,
	getOppositeReactionType,
	getReactionCounts,
	getReactionRequest,
} from './post.reactions.logic.js';

let reactionsInitialized = false;

function getReactionButton(target) {
	if (!(target instanceof Element)) {
		return null;
	}

	return target.closest('[data-reaction]');
}

function isPressed(button) {
	return button?.getAttribute('aria-pressed') === 'true';
}

function setPressed(button, pressed) {
	if (button) {
		button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
	}
}

function restorePressed(states) {
	for (const { button, pressed } of states) {
		setPressed(button, pressed);
	}
}

// Resolves the reaction target from the container element rather than the
// <button>. The reaction buttons intentionally carry no id attribute (so they
// never collide with the unique [data-post-id] container selector), so the id
// is read from the nearest [data-post-id]/[data-comment-id] ancestor. The
// .reactions wrapper's data-reaction-scope hook picks which container to find:
// posts live under [data-post-id] (<article> in the feed/activity, <section> on
// the detail route), comments under .comment / .activity-comment.
function resolveReactionTarget(button) {
	const wrapper = button.closest('[data-reaction-scope]');
	const scope = wrapper?.dataset.reactionScope;

	if (scope === 'comment') {
		const container = button.closest('[data-comment-id]');
		return { container, wrapper, postId: null, commentId: container?.dataset.commentId ?? null };
	}

	const container = button.closest('[data-post-id]');
	return { container, wrapper, postId: container?.dataset.postId ?? null, commentId: null };
}

function applyReactionCountsToDom(scope, payload) {
	const { likesCount, dislikesCount } = getReactionCounts(payload);
	const likeCount = scope?.querySelector('[data-like-count]');
	const dislikeCount = scope?.querySelector('[data-dislike-count]');

	if (likeCount) {
		likeCount.textContent = String(likesCount);
	}

	if (dislikeCount) {
		dislikeCount.textContent = String(dislikesCount);
	}
}

async function handleReactionClick(fetchRef, event) {
	const button = getReactionButton(event.target);
	if (!button) {
		return;
	}

	event.stopPropagation();

	const { container: scope, wrapper, postId, commentId } = resolveReactionTarget(button);
	if (!scope || !wrapper || wrapper.dataset.reactionPending === 'true') {
		return;
	}

	const reaction = getReactionRequest({
		type: button.dataset.reaction,
		postId,
		commentId,
	});

	const wasActive = isPressed(button);
	const nextSelection = applyReactionSelection(wasActive ? reaction.type : null, reaction.type);
	const oppositeType = getOppositeReactionType(reaction.type);
	const opposite = wrapper.querySelector(`[data-reaction="${oppositeType}"]`);
	const previousPressed = [
		{ button, pressed: wasActive },
		{ button: opposite, pressed: isPressed(opposite) },
	];
	wrapper.dataset.reactionPending = 'true';
	setPressed(button, nextSelection === reaction.type);
	setPressed(opposite, false);

	try {
		const currentUser = await getCurrentUser(fetchRef);
		if (!currentUser) {
			restorePressed(previousPressed);
			return;
		}

		const response = await postReaction(fetchRef, reaction);
		if (!response?.ok) {
			restorePressed(previousPressed);
			return;
		}

		applyReactionCountsToDom(wrapper, await response.json());
	} catch {
		restorePressed(previousPressed);
	} finally {
		delete wrapper.dataset.reactionPending;
	}
}

export function initReactionBindings({
	documentRef = typeof document !== 'undefined' ? document : null,
	fetchRef = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
} = {}) {
	if (
		reactionsInitialized ||
		!documentRef ||
		typeof documentRef.addEventListener !== 'function' ||
		typeof fetchRef !== 'function'
	) {
		return;
	}

	documentRef.addEventListener('click', (event) => {
		void handleReactionClick(fetchRef, event);
	});

	reactionsInitialized = true;
}
