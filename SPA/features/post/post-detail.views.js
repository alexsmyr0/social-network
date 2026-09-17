// SPA/features/post/post-detail.views.js

import { IMAGE_ACCEPT_ATTR } from '../../core/shared/utils.js';
import { escapeHTML } from '../../core/utils/html.js';
import {
	formatCreatedAt,
	renderCategories,
	renderPostReactions,
	resolveUsername,
} from './post-card.views.js';

export function renderPostDetailView(post = {}) {
	const postID = post.id ?? '';
	const title = post.title ? escapeHTML(post.title) : 'Post Detail';
	const body = post.body ? escapeHTML(post.body) : '';
	const authorID = escapeHTML(post.author_id || post.user_id || '');
	const authorName = escapeHTML(resolveUsername(post));
	const authorMarkup = `<a data-link class="profile-link" href="/profile/${authorID}">${authorName}</a>`;
	const createdAt = formatCreatedAt(post.created_at);
	const createdAtMarkup = createdAt
		? `<time class="post-detail-date" datetime="${escapeHTML(post.created_at)}">${escapeHTML(createdAt)}</time>`
		: '';

	return `
		<section class="post-detail-view" data-screen="post-detail" data-post-id="${escapeHTML(String(postID))}" aria-labelledby="screen-post-title">
			<article class="post-detail">
				<header class="post-detail-header">
					${renderCategories(post.categories)}
					<h1 id="screen-post-title" class="post-detail-title">${title}</h1>
					<div class="post-detail-meta">
						<p class="muted">Author: ${authorMarkup}</p>
						${createdAtMarkup}
					</div>
				</header>

				<div class="post-detail-body">
					<p>${body}</p>
				</div>

				<section class="post-actions">
					${renderPostReactions(post)}
				</section>

				<section data-comments></section>

				<form id="comment-form" class="comment-form">
					<div class="comment-textarea-wrap">
						<textarea
							name="body"
							rows="4"
							placeholder="Write your reply here..."
						></textarea>
						<button type="button" class="comment-image-btn" aria-label="Attach image" title="Attach image">
							<img class="comment-image-icon" src="/assets/img/paperclip.png" alt="" aria-hidden="true" />
						</button>
						<input
							type="file"
							name="image"
							class="comment-image-input"
							accept="${IMAGE_ACCEPT_ATTR}"
							hidden
						/>
					</div>
					<div class="comment-image-row">
						<span class="comment-image-name muted" aria-live="polite"></span>
						<button type="button" class="image-clear" aria-label="Remove selected image" hidden>x</button>
					</div>
					<div class="comment-image-preview" hidden>
						<img alt="Selected comment image preview" />
					</div>
					<p class="muted" data-comment-feedback hidden></p>
					<button type="submit">Post comment</button>
				</form>
			</article>
		</section>
	`;
}
