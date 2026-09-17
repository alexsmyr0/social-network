export function getReactionRequest({ type, postId, commentId }) {
	return {
		type,
		postId: postId || null,
		commentId: commentId || null,
	};
}

export function getOppositeReactionType(type) {
	return type === 'like' ? 'dislike' : 'like';
}

export function applyReactionSelection(currentReaction, nextReaction) {
	return currentReaction === nextReaction ? null : nextReaction;
}

export function getReactionCounts(payload) {
	return {
		likesCount: payload?.data?.likes_count ?? 0,
		dislikesCount: payload?.data?.dislikes_count ?? 0,
	};
}

// Normalizes a post/comment record into a canonical reaction shape, tolerating
// both the GET list/detail shape (`likes`/`dislikes`/`my_reaction` as an int)
// and the reaction POST response shape (`likes_count`/`dislikes_count`/`reaction`).
// `userReaction` is exposed as the string 'like' | 'dislike' | '' so templates
// can drive `checked` state uniformly.
export function normalizeReactionState(item = {}) {
	const likeCount = Number(item.likes ?? item.likes_count) || 0;
	const dislikeCount = Number(item.dislikes ?? item.dislikes_count) || 0;

	return {
		likeCount,
		dislikeCount,
		userReaction: resolveUserReaction(item),
	};
}

function resolveUserReaction(item) {
	const raw = item.my_reaction ?? item.reaction ?? item.current_user_reaction;

	if (raw === 'like' || raw === 'dislike') {
		return raw;
	}

	const numeric = Number(raw);
	if (numeric === 1) {
		return 'like';
	}
	if (numeric === -1) {
		return 'dislike';
	}

	return '';
}
