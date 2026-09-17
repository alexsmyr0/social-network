// SPA/features/activity/activity.views.js

import { IMAGE_ACCEPT_ATTR } from '../../core/shared/utils.js';
import { escapeHTML } from '../../core/utils/html.js';
import { normalizeReactionState } from '../post/post.reactions.logic.js';
import {
	formatCreatedAt,
	renderCategories,
	resolveUsername,
	THUMB_DOWN_ICON,
	THUMB_UP_ICON,
} from '../post/post-card.views.js';

export function renderActivityView() {
	return `
		<section
			data-screen="activity"
			aria-labelledby="screen-activity-title"
		>
			<header class="activity-header">
				<h1 id="screen-activity-title">My Activity</h1>
			</header>

			<section class="filters activity-filters" aria-label="Activity filters">
				<div class="filter-group">
					<label for="activity-status-filter">Created Post Status</label>
					<select id="activity-status-filter" name="status">
						<option value="all">All</option>
						<option value="draft">Draft</option>
						<option value="published">Published</option>
					</select>
				</div>

				<div class="filter-group">
					<label for="activity-per-page">Items Per Section</label>
					<select id="activity-per-page" name="per_page">
						<option value="5">5</option>
						<option value="10">10</option>
						<option value="20">20</option>
						<option value="50">50</option>
					</select>
				</div>
			</section>

			<p class="activity-feedback muted" data-activity-feedback hidden></p>

			<section class="activity-sections">
				${renderActivitySection({
					title: 'My Posts',
					sectionId: 'activity-section-created',
					contentId: 'activity-created-content',
					outputId: 'activity-created-output',
					emptyId: 'activity-created-empty',
					countId: 'activity-created-count',
					emptyHeading: 'No created posts',
					emptyText: 'Your posts will appear here.',
				})}

				${renderActivitySection({
					title: 'My Comments',
					sectionId: 'activity-section-comments',
					contentId: 'activity-comments-content',
					outputId: 'activity-comments-output',
					emptyId: 'activity-comments-empty',
					countId: 'activity-comments-count',
					emptyHeading: 'No comments yet',
					emptyText: 'Comments you write will appear here.',
				})}

				${renderActivitySection({
					title: 'Liked Posts',
					sectionId: 'activity-section-liked',
					contentId: 'activity-liked-content',
					outputId: 'activity-liked-output',
					emptyId: 'activity-liked-empty',
					countId: 'activity-liked-count',
					emptyHeading: 'No liked posts',
					emptyText: 'Posts you liked will appear here.',
				})}

				${renderActivitySection({
					title: 'Disliked Posts',
					sectionId: 'activity-section-disliked',
					contentId: 'activity-disliked-content',
					outputId: 'activity-disliked-output',
					emptyId: 'activity-disliked-empty',
					countId: 'activity-disliked-count',
					emptyHeading: 'No disliked posts',
					emptyText: 'Posts you disliked will appear here.',
				})}
			</section>

			<nav class="pagination" id="activity-pagination" hidden aria-label="Activity pagination">
				<button class="btn" id="activity-prev-page" type="button">‹</button>
				<div id="activity-page-numbers" class="page-numbers"></div>
				<button class="btn" id="activity-next-page" type="button">›</button>
			</nav>
		</section>
	`;
}

function renderActivitySection({
	title,
	sectionId,
	contentId,
	outputId,
	emptyId,
	countId,
	emptyHeading,
	emptyText,
}) {
	return `
		<section class="activity-section card-pad" id="${sectionId}">
			<div class="activity-section-head">
				<button
					type="button"
					class="activity-toggle"
					data-activity-toggle
					aria-expanded="false"
					aria-controls="${contentId}"
				>
					<span class="activity-title">${escapeHTML(title)}</span>
					<span class="activity-caret" aria-hidden="true">^</span>
				</button>
				<span id="${countId}" class="activity-count">0</span>
			</div>
			<div id="${contentId}" class="activity-section-content" hidden>
				<div id="${outputId}" class="activity-posts-output"></div>
				<div id="${emptyId}" class="empty-state" hidden>
					<h3>${escapeHTML(emptyHeading)}</h3>
					<p>${escapeHTML(emptyText)}</p>
				</div>
			</div>
		</section>
	`;
}

// Reaction <button> elements carry no id attribute of their own; the delegated
// listener resolves the target id from the [data-post-id]/[data-comment-id]
// container via the data-reaction-scope hook. This keeps reaction buttons from
// colliding with the unique [data-post-id] container selector. The persisted
// reaction is reflected via aria-pressed, which also drives active styling.
function reactionButtonsMarkup({ scope, likeCount, dislikeCount, userReaction }) {
	const liked = userReaction === 'like';
	const disliked = userReaction === 'dislike';

	return `
		<div class="reactions" data-reaction-scope="${escapeHTML(scope)}">
			<div class="reaction">
				<button
					type="button"
					class="reaction-toggle reaction-toggle--like"
					data-reaction="like"
					aria-label="Like"
					aria-pressed="${liked ? 'true' : 'false'}"
				>
					${THUMB_UP_ICON}
				</button>
				<span class="reaction-count" data-like-count>${Number(likeCount) || 0}</span>
			</div>

			<div class="reaction">
				<button
					type="button"
					class="reaction-toggle reaction-toggle--dislike"
					data-reaction="dislike"
					aria-label="Dislike"
					aria-pressed="${disliked ? 'true' : 'false'}"
				>
					${THUMB_DOWN_ICON}
				</button>
				<span class="reaction-count" data-dislike-count>${Number(dislikeCount) || 0}</span>
			</div>
		</div>
	`;
}

function trimmedString(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function renderPostImageMarkup(imageUrl, title) {
	if (!imageUrl) return '';
	return `
		<div class="post-image">
			<img src="${escapeHTML(imageUrl)}" alt="${title}" loading="lazy" />
		</div>
	`;
}

function renderPostOwnerActions(postId, ownerStatus) {
	const isDraft = ownerStatus === 'draft';
	const statusLabel = isDraft ? 'Publish' : 'Draft';
	const statusIcon = isDraft ? 'publish' : 'draft';
	return `
		<button
			type="button"
			class="post-status-toggle"
			data-action="status-toggle"
			data-post-id="${postId}"
			data-current-status="${escapeHTML(ownerStatus)}"
			title="${isDraft ? 'Publish post' : 'Move to draft'}"
			aria-label="${statusLabel}"
		>
			<img class="owner-action__icon" src="/assets/img/${statusIcon}.png" alt="" aria-hidden="true" />
		</button>
		<a
			data-link
			class="post-edit"
			data-action="edit-post"
			data-post-id="${postId}"
			href="/edit-post/${postId}?next=%2Factivity"
			title="Edit post"
			aria-label="Edit"
		><img class="owner-action__icon" src="/assets/img/edit.png" alt="" aria-hidden="true" /></a>
		<button
			type="button"
			class="post-delete"
			data-action="delete-post"
			data-post-id="${postId}"
			title="Delete post"
			aria-label="Delete"
		><span class="owner-action__icon owner-action__icon--delete" aria-hidden="true"></span></button>
	`;
}

function getReactionMetrics(item) {
	return normalizeReactionState(item);
}

export function renderActivityPostCard(post, { showOwnerActions = false } = {}) {
	const postId = escapeHTML(String(post.id ?? ''));
	const title = post.title ? escapeHTML(post.title) : 'Untitled';
	const body = post.body ? escapeHTML(post.body) : '';
	const authorId = escapeHTML(String(post.author_id || post.user_id || ''));
	const authorName = escapeHTML(resolveUsername(post));
	const createdAt = formatCreatedAt(post.created_at);
	const createdAtMarkup = createdAt ? `<time class="muted">${escapeHTML(createdAt)}</time>` : '';
	const imageMarkup = renderPostImageMarkup(trimmedString(post.image_url), title);
	const bodyMarkup = body ? `<p>${body}</p>` : '';
	const ownerStatus = post.status === 'draft' ? 'draft' : 'published';
	const ownerActionsMarkup = showOwnerActions
		? `<div class="post-owner-actions">${renderPostOwnerActions(postId, ownerStatus)}</div>`
		: '';
	const { likeCount, dislikeCount, userReaction } = getReactionMetrics(post);

	return `
		<article
			class="post card card-pad"
			data-post-id="${postId}"
			data-activity-post
		>
			<header class="post-header">
				<div>
					${renderCategories(post.categories)}
					<h3 class="post-title">
						<a data-link href="/posts/${postId}">${title}</a>
					</h3>
					<p class="muted">
						Author:
						<a data-link class="profile-link" href="/profile/${authorId}">${authorName}</a>
					</p>
				</div>

				<div class="post-header-right">
					${createdAtMarkup}
					${ownerActionsMarkup}
				</div>
			</header>

			<section class="post-body">
				${imageMarkup}
				${bodyMarkup}
			</section>

			<section class="post-actions">
				${reactionButtonsMarkup({ scope: 'post', likeCount, dislikeCount, userReaction })}
			</section>
		</article>
	`;
}

function renderCommentImageMarkup(imageUrl, username) {
	if (!imageUrl) return '';
	return `
		<div class="activity-comment-image-wrap">
			<img
				class="activity-comment-image"
				src="${escapeHTML(imageUrl)}"
				alt="Comment image by ${username}"
				loading="lazy"
			/>
		</div>
	`;
}

function buildPostCardForComment(comment) {
	const post = comment?.post;
	if (!post) return '';

	return renderActivityPostCard({
		id: comment.post_id ?? post.id,
		title: post.title,
		body: post.body,
		image_url: post.image_url,
		author_id: post.author_id,
		author: post.author,
		username: post.username,
		created_at: post.created_at ?? comment.created_at,
		categories: post.categories ?? comment.categories,
		likes: post.likes ?? post.likes_count,
		dislikes: post.dislikes ?? post.dislikes_count,
		my_reaction: post.my_reaction,
	});
}

export function renderActivityCommentEntry(comment) {
	const commentId = Number(comment?.id) || 0;
	const commentIdStr = escapeHTML(String(commentId));
	const username = escapeHTML(resolveUsername(comment));
	const body = typeof comment.body === 'string' ? comment.body : '';
	const imageUrl = trimmedString(comment.image_url);
	const bodyMarkup = body.trim() ? `<p class="activity-comment-body">${escapeHTML(body)}</p>` : '';
	const imageMarkup = renderCommentImageMarkup(imageUrl, username);
	const createdAt = formatCreatedAt(comment.created_at);
	const createdAtMarkup = createdAt ? `<time class="muted">${escapeHTML(createdAt)}</time>` : '';
	const postCard = buildPostCardForComment(comment);
	const { likeCount, dislikeCount, userReaction } = getReactionMetrics(comment);

	return `
		<div class="activity-comment-entry">
			${postCard}
			<article
				class="activity-comment card-pad"
				data-comment-id="${commentIdStr}"
				data-comment-body="${escapeHTML(body)}"
				data-comment-image-url="${escapeHTML(imageUrl)}"
			>
				<header class="activity-comment-head">
					<p class="activity-comment-author muted">
						Author: ${username}
					</p>
					<div class="activity-comment-head-right">
						${createdAtMarkup}
						<button
							type="button"
							class="comment-edit"
							data-action="edit-comment"
							data-comment-id="${commentIdStr}"
							title="Edit comment"
							aria-label="Edit"
						><img class="comment-action__icon" src="/assets/img/edit.png" alt="" aria-hidden="true" /></button>
						<button
							type="button"
							class="comment-delete"
							data-action="delete-comment"
							data-comment-id="${commentIdStr}"
							title="Delete comment"
							aria-label="Delete"
						><span class="comment-action__icon comment-action__icon--delete" aria-hidden="true"></span></button>
					</div>
				</header>
				<div class="activity-comment-content">
					${bodyMarkup}
					${imageMarkup}
				</div>
				<div class="activity-comment-reactions comment">
					${reactionButtonsMarkup({
						scope: 'comment',
						likeCount,
						dislikeCount,
						userReaction,
					})}
				</div>
			</article>
		</div>
	`;
}

export function renderCommentEditorMarkup(initialBody = '') {
	return `
		<form class="comment-form activity-comment-edit-form" data-comment-edit-form novalidate>
			<div class="comment-textarea-wrap">
				<textarea rows="3">${escapeHTML(initialBody)}</textarea>
				<button type="button" class="comment-image-btn" aria-label="Attach image">
					Attach
				</button>
				<input
					type="file"
					class="comment-image-input"
					accept="${IMAGE_ACCEPT_ATTR}"
					hidden
				/>
			</div>
			<div class="comment-image-row">
				<span class="comment-image-name muted" aria-live="polite"></span>
				<button type="button" class="image-clear" aria-label="Remove selected image" hidden>x</button>
			</div>
			<div class="comment-image-preview activity-comment-edit-preview" hidden>
				<img alt="Comment image preview" />
			</div>
			<div class="activity-comment-edit-actions">
				<button type="submit" class="btn btn-primary">Update</button>
				<button type="button" class="btn btn-outline cancel-edit">Cancel</button>
			</div>
		</form>
	`;
}
