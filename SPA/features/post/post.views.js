// SPA/features/post/post.views.js

function renderPostFormFields({
	heading,
	eyebrow,
	submitLabel,
	mode,
	showDraftAction,
	backHref,
	backLabel,
	postID,
}) {
	const postIDAttr = postID ? ` data-post-id="${postID}"` : '';
	return `
		<section class="post-editor post-editor--${mode}" data-screen="${mode}"${postIDAttr} aria-labelledby="screen-${mode}-title">
			${
				mode === 'create-post'
					? `<header class="activity-header">
				<h1 id="screen-${mode}-title">${heading}</h1>
			</header>`
					: `<div class="post-editor__hero">
				<p class="post-editor__eyebrow">${eyebrow}</p>
				<div class="post-editor__hero-copy">
					<h1 id="screen-${mode}-title" class="post-editor__title">${heading}</h1>
					<p class="post-editor__subtitle">
						Refine the post content, update categories, or replace the attached image.
					</p>
				</div>
			</div>`
			}

			<form id="${mode === 'create-post' ? 'create-post-form' : 'edit-post-form'}" class="post-editor__form" novalidate>
				<p class="post-editor__status" data-post-form-feedback hidden></p>
				<div class="post-editor__layout">
					<div class="post-editor__main">
						<div class="post-editor__section">
							<label for="title" class="field-label">Title</label>
							<input
								id="title"
								class="post-editor__input"
								type="text"
								name="title"
								placeholder="Give the thread a sharp, specific title"
								maxlength="300"
								required
								autocomplete="off"
							/>
						</div>

						<div class="post-editor__section">
							<label for="body" class="field-label">Body</label>
							<div class="post-editor__textarea-wrap">
								<textarea
									id="body"
									class="post-editor__textarea"
									name="body"
									placeholder="Write your post..."
									rows="10"
								></textarea>
								<button
									type="button"
									class="post-editor__attach-button"
									id="image-button"
									aria-label="Attach image"
								>
									<img class="post-editor__attach-icon" src="/assets/img/paperclip.png" alt="" aria-hidden="true" />
								</button>
								<input
									id="image"
									class="sr-only"
									type="file"
									name="image"
									accept="image/jpeg,image/png,image/gif"
								/>
							</div>
							<div class="post-editor__image-meta">
								<span id="image-name" class="post-editor__image-name muted" aria-live="polite"></span>
								<button
									type="button"
									class="image-clear"
									id="image-clear"
									aria-label="Remove image"
									hidden
								>
									×
								</button>
							</div>
							<div id="image-preview" class="post-editor__image-preview" hidden>
								<img alt="Selected upload preview" />
							</div>
						</div>
					</div>

					<aside class="post-editor__sidebar" aria-label="Post settings">
						<div class="post-editor__panel">
							<div class="post-editor__panel-header">
								<p class="post-editor__panel-kicker">Taxonomy</p>
								<h2 class="post-editor__panel-title">Categories</h2>
							</div>
							<p class="post-editor__panel-copy">
								Choose one or more categories to make the discussion easier to discover.
							</p>
							<div id="categoryCheckboxes" class="category-checkboxes" data-role="category-checkboxes"></div>
						</div>

						${
							mode === 'create-post'
								? ''
								: `<div class="post-editor__panel post-editor__panel--quiet">
							<p class="post-editor__panel-kicker">Flow</p>
							<p class="post-editor__panel-copy">
								Update the post when you are done, or return without saving from the back control.
							</p>
						</div>`
						}
					</aside>
				</div>

				<div class="post-editor__footer">
					<div class="post-editor__actions">
						${
							showDraftAction
								? `
								<button class="post-editor__button post-editor__button--secondary" type="submit" name="action" value="draft">
									Save Draft
								</button>
							`
								: ''
						}
						<button
							class="post-editor__button post-editor__button--primary"
							type="submit"
							${showDraftAction ? 'name="action" value="publish"' : ''}
						>
							${submitLabel}
						</button>
					</div>
					<div class="post-editor__back">
						<a href="${backHref}" class="post-editor__back-link" data-link>
							${backLabel}
						</a>
					</div>
				</div>
			</form>
		</section>
	`;
}

export function renderEditPostView(postID) {
	return renderPostFormFields({
		heading: 'Edit Post',
		eyebrow: `Post #${postID}`,
		submitLabel: 'Update Post',
		mode: 'edit-post',
		showDraftAction: false,
		backHref: '/activity',
		backLabel: 'Back to activity',
		postID,
	});
}

export function renderCreatePostView() {
	return renderPostFormFields({
		heading: 'Create Post',
		eyebrow: 'New thread',
		submitLabel: 'Publish Post',
		mode: 'create-post',
		showDraftAction: true,
		backHref: '/',
		backLabel: 'Back to feed',
	});
}
