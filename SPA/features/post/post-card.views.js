import { escapeHTML } from '../../core/utils/html.js';
import { normalizeReactionState } from './post.reactions.logic.js';

// Thumbs-up / thumbs-down glyphs for the reaction buttons. The paths carry no
// fill, so the icon color comes from CSS (`.reaction-toggle svg`): a muted idle
// tone that switches to the like/dislike accent when the button is pressed.
// aria-hidden because the button's aria-label already names the control.
export const THUMB_UP_ICON = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M29.845,17.099l-2.489,8.725C26.989,27.105,25.804,28,24.473,28H11c-0.553,0-1-0.448-1-1V13c0-0.215,0.069-0.425,0.198-0.597l5.392-7.24C16.188,4.414,17.05,4,17.974,4C19.643,4,21,5.357,21,7.026V12h5.002c1.265,0,2.427,0.579,3.188,1.589C29.954,14.601,30.192,15.88,29.845,17.099z"/><path d="M7,12H3c-0.553,0-1,0.448-1,1v14c0,0.552,0.447,1,1,1h4c0.553,0,1-0.448,1-1V13C8,12.448,7.553,12,7,12z M5,25.5c-0.828,0-1.5-0.672-1.5-1.5c0-0.828,0.672-1.5,1.5-1.5c0.828,0,1.5,0.672,1.5,1.5C6.5,24.828,5.828,25.5,5,25.5z"/></svg>`;
export const THUMB_DOWN_ICON = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M2.156,14.901l2.489-8.725C5.012,4.895,6.197,4,7.528,4h13.473C21.554,4,22,4.448,22,5v14c0,0.215-0.068,0.425-0.197,0.597l-5.392,7.24C15.813,27.586,14.951,28,14.027,28c-1.669,0-3.026-1.357-3.026-3.026V20H5.999c-1.265,0-2.427-0.579-3.188-1.589C2.047,17.399,1.809,16.12,2.156,14.901z"/><path d="M25.001,20h4C29.554,20,30,19.552,30,19V5c0-0.552-0.446-1-0.999-1h-4c-0.553,0-1,0.448-1,1v14C24.001,19.552,24.448,20,25.001,20z M27.001,6.5c0.828,0,1.5,0.672,1.5,1.5c0,0.828-0.672,1.5-1.5,1.5c-0.828,0-1.5-0.672-1.5-1.5C25.501,7.172,26.173,6.5,27.001,6.5z"/></svg>`;

export function formatCreatedAt(iso) {
	if (!iso) {
		return '';
	}

	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return String(iso);
	}

	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	let hours = date.getHours();
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const suffix = hours >= 12 ? 'PM' : 'AM';
	hours %= 12;
	hours = hours === 0 ? 12 : hours;

	return `${year}-${month}-${day}, ${String(hours).padStart(2, '0')}:${minutes} ${suffix}`;
}

export function resolveUsername(post) {
	return post.username || post.author || (post.user_id ? `User ${post.user_id}` : 'User');
}

export function renderCategories(categories = []) {
	if (!Array.isArray(categories) || categories.length === 0) {
		return '';
	}

	return `
		<ul class="post-categories" aria-label="Post categories">
			${categories
				.map(
					(category) => `<li class="post-category">${escapeHTML(category.name ?? category)}</li>`,
				)
				.join('')}
		</ul>
	`;
}

// Shared reaction button markup for posts and comments. `scope` drives the
// data-reaction-scope hook the delegated reaction listener reads to resolve the
// target id from the container element (data-post-id for posts, data-comment-id
// for comments). The reaction <button> deliberately carries no id attribute of
// its own so it never collides with the unique [data-post-id] container
// selector the post-detail deep-link relies on. The persisted reaction is
// reflected via aria-pressed, which doubles as the active-state styling hook.
function renderReactions(item, scope) {
	const { likeCount, dislikeCount, userReaction } = normalizeReactionState(item);

	return `
		<div class="reactions" data-reaction-scope="${scope}">
			<div class="reaction">
				<button
					type="button"
					class="reaction-toggle reaction-toggle--like"
					data-reaction="like"
					aria-label="Like"
					aria-pressed="${userReaction === 'like' ? 'true' : 'false'}"
				>
					${THUMB_UP_ICON}
				</button>
				<span class="reaction-count" data-like-count>${likeCount}</span>
			</div>

			<div class="reaction">
				<button
					type="button"
					class="reaction-toggle reaction-toggle--dislike"
					data-reaction="dislike"
					aria-label="Dislike"
					aria-pressed="${userReaction === 'dislike' ? 'true' : 'false'}"
				>
					${THUMB_DOWN_ICON}
				</button>
				<span class="reaction-count" data-dislike-count>${dislikeCount}</span>
			</div>
		</div>
	`;
}

export function renderPostReactions(post) {
	return renderReactions(post, 'post');
}

export function renderCommentReactions(comment) {
	return renderReactions(comment, 'comment');
}

function normalizeUploadImageURL(value) {
	const url = typeof value === 'string' ? value.trim() : '';
	if (!url?.startsWith('/static/uploads/')) {
		return '';
	}

	try {
		const parsed = new URL(url, 'https://forum.local');
		if (
			parsed.origin !== 'https://forum.local' ||
			!parsed.pathname.startsWith('/static/uploads/')
		) {
			return '';
		}
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return '';
	}
}

function escapeCSSURL(value) {
	return String(value)
		.replaceAll('\\', '\\\\')
		.replaceAll("'", "\\'")
		.replaceAll('\n', '\\a ')
		.replaceAll('\r', '\\a ')
		.replaceAll('\f', '\\c ');
}

function renderCommentPreview(comment) {
	const body = typeof comment.body === 'string' ? comment.body.trim() : '';
	const previewBody = body ? `<p class="comment-text">${escapeHTML(body)}</p>` : '';

	return `
		<article class="comment" data-comment-id="${escapeHTML(comment.id)}">
			<div class="comment-meta muted">
				<strong><a data-link class="profile-link" href="/profile/${escapeHTML(comment.author_id || comment.user_id || '')}">${escapeHTML(resolveUsername(comment))}</a></strong>
				<span>${formatCreatedAt(comment.created_at)}</span>
			</div>
			<div class="comment-body">
				${previewBody}
			</div>
		</article>
	`;
}

function commentPreviewTemplate(previewComments = [], showCommentPreview = false) {
	if (!showCommentPreview) {
		return '';
	}

	if (!Array.isArray(previewComments) || previewComments.length === 0) {
		return `
			<section class="post-comments" data-comments-preview>
				<p class="muted">No comments yet.</p>
			</section>
		`;
	}

	return `
		<section class="post-comments" data-comments-preview>
			<div class="comments-scroll">
				${previewComments.map((comment) => renderCommentPreview(comment)).join('')}
			</div>
		</section>
	`;
}

export function renderPostCard(
	documentRef,
	post,
	{ clickable = true, onNavigate = null, previewComments = [], showCommentPreview = false } = {},
) {
	const article = documentRef.createElement('article');
	article.className = 'post card card-pad';
	article.dataset.postId = String(post.id);

	const imageUrl = normalizeUploadImageURL(post.image_url);
	const imageMarkup = imageUrl
		? `
			<div class="post-image">
				<div class="post-image-ambient" aria-hidden="true" style="background-image: url('${escapeCSSURL(imageUrl)}')"></div>
				<img
					src="${escapeHTML(imageUrl)}"
					alt="${escapeHTML(post.title)}"
					loading="lazy"
				/>
			</div>
		`
		: '';
	const bodyMarkup = post.body ? `<p>${escapeHTML(post.body)}</p>` : '';

	article.innerHTML = `
		<header class="post-header ${clickable ? 'clickable' : ''}">
			<div>
				${renderCategories(post.categories)}
				<h3 class="post-title">${escapeHTML(post.title)}</h3>
				<p class="muted">Author: <a data-link class="profile-link" href="/profile/${escapeHTML(post.author_id || post.user_id || '')}">${escapeHTML(resolveUsername(post))}</a></p>
			</div>

			<div class="post-header-right">
				<time class="muted">${formatCreatedAt(post.created_at)}</time>
			</div>
		</header>

		<section class="post-body ${clickable ? 'clickable' : ''}">
			${imageMarkup}
			${bodyMarkup}
		</section>

		<section class="post-actions">
			${renderPostReactions(post)}
		</section>

		${commentPreviewTemplate(previewComments, showCommentPreview)}
	`;

	if (clickable) {
		for (const element of article.querySelectorAll('.clickable')) {
			element.addEventListener('click', () => {
				if (typeof onNavigate === 'function') {
					onNavigate(post);
				}
			});
		}
	}

	return article;
}
