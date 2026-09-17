// SPA/features/post/post.page.js

import { matchRoute } from '../../core/router/routes.js';
import { setupImagePicker } from '../../core/shared/image-picker.js';
import { escapeHTML } from '../../core/utils/html.js';
import { highlightCommentFromQuery } from './comment-highlight.js';
import {
	createPost,
	createPostComment,
	getPostById,
	getPostComments,
	loadPostCategories,
	loadPostForEdit,
	normalizeCategoryIDs,
	updatePost,
} from './post.api.js';
import { initReactionBindings } from './post.reactions.bindings.js';
import { formatCreatedAt, renderCommentReactions, resolveUsername } from './post-card.views.js';
import { renderPostDetailView } from './post-detail.views.js';

const POST_DETAIL_BOUND_ATTR = 'data-post-detail-bound';
const POST_FORM_BOUND_ATTR = 'data-post-form-bound';

function renderCommentsMarkup(comments) {
	if (!Array.isArray(comments) || comments.length === 0) {
		return '<p class="muted">No comments yet.</p>';
	}

	return comments
		.map((comment) => {
			const body = comment.body ? escapeHTML(comment.body) : '';
			const authorID = escapeHTML(comment.author_id || comment.user_id || '');
			const authorName = escapeHTML(resolveUsername(comment));
			const author = `<a data-link class="profile-link" href="/profile/${authorID}">${authorName}</a>`;
			const createdAt = formatCreatedAt(comment.created_at);
			const createdAtMarkup = createdAt
				? `<time class="comment-date" datetime="${escapeHTML(comment.created_at)}">${escapeHTML(createdAt)}</time>`
				: '';
			const imageMarkup =
				typeof comment.image_url === 'string' && comment.image_url.trim()
					? `
						<div class="comment-image">
							<img src="${escapeHTML(comment.image_url)}" alt="Comment attachment" loading="lazy" />
						</div>
					`
					: '';

			return `
				<article class="comment card card-pad" data-comment-id="${escapeHTML(String(comment.id ?? ''))}">
					<header class="comment-header">
						<p class="muted">Author: ${author}</p>
						${createdAtMarkup}
					</header>
					<div class="comment-body">
						<p>${body}</p>
						${imageMarkup}
					</div>
					<div class="comment-actions">
						${renderCommentReactions(comment)}
					</div>
				</article>
			`;
		})
		.join('');
}

function renderPostError(root, message) {
	root.innerHTML = `
		<section class="post-detail-error" role="alert">
			<h1 id="screen-post-title">Post unavailable</h1>
			<p>${escapeHTML(message)}</p>
		</section>
	`;
}

async function reloadComments(fetchRef, postId, commentsContainer) {
	commentsContainer.innerHTML = `
		<div class="post-comments-loading" aria-busy="true">
			<p>Loading comments...</p>
		</div>
	`;

	const comments = await getPostComments(fetchRef, postId);
	if (!comments) {
		commentsContainer.innerHTML = `
			<p class="muted" role="alert">Unable to load comments right now.</p>
		`;
		return null;
	}

	commentsContainer.innerHTML = renderCommentsMarkup(comments);
	return comments;
}

function setCommentFormFeedback(form, message, isError = false) {
	const feedback = form?.querySelector?.('[data-comment-feedback]');
	if (!feedback) {
		return;
	}

	if (!message) {
		feedback.hidden = true;
		feedback.textContent = '';
		feedback.removeAttribute('role');
		return;
	}

	feedback.hidden = false;
	feedback.textContent = message;
	feedback.setAttribute('role', isError ? 'alert' : 'status');
}

function setCommentFormBusy(form, isBusy) {
	const submitButton = form?.querySelector?.('button[type="submit"]');
	if (!submitButton) {
		return;
	}

	if (isBusy) {
		if (!submitButton.dataset.originalLabel) {
			submitButton.dataset.originalLabel = submitButton.textContent ?? '';
		}
		submitButton.disabled = true;
		submitButton.textContent = 'Posting...';
		return;
	}

	submitButton.disabled = false;
	if (submitButton.dataset.originalLabel) {
		submitButton.textContent = submitButton.dataset.originalLabel;
		delete submitButton.dataset.originalLabel;
	}
}

function bindCommentForm({ form, fetchRef, postId, commentsContainer }) {
	if (!form || form.dataset.bound === 'true') {
		return;
	}

	form.dataset.bound = 'true';
	const imageInput = form.querySelector('.comment-image-input');
	const imagePicker = setupImagePicker({
		input: imageInput,
		triggerButton: form.querySelector('.comment-image-btn'),
		clearButton: form.querySelector('.image-clear'),
		nameLabel: form.querySelector('.comment-image-name'),
		previewContainer: form.querySelector('.comment-image-preview'),
		previewImage: form.querySelector('.comment-image-preview img'),
		onTooLarge: () => {
			setCommentFormFeedback(form, 'Image must be 20MB or smaller.', true);
		},
	});

	form.addEventListener('submit', async (event) => {
		event.preventDefault();

		const formData = new FormData(form);
		const body = typeof formData.get('body') === 'string' ? formData.get('body').trim() : '';
		const imageFile = imagePicker?.getFile?.() ?? imageInput?.files?.[0] ?? null;

		if (!body && !imageFile) {
			setCommentFormFeedback(form, 'Cannot submit an empty comment.', true);
			return;
		}

		setCommentFormFeedback(form, '');
		setCommentFormBusy(form, true);

		try {
			const result = await createPostComment(fetchRef, postId, { body, imageFile });
			if (!result?.ok) {
				setCommentFormFeedback(form, 'Unable to post comment right now.', true);
				return;
			}

			form.reset();
			imagePicker?.clearSelectedFile?.();
			await reloadComments(fetchRef, postId, commentsContainer);
			setCommentFormFeedback(form, 'Comment posted.');
		} finally {
			setCommentFormBusy(form, false);
		}
	});
}

function resolvePostDetailContext(documentRef, match) {
	const root = documentRef.querySelector('[data-screen="post-detail"]');
	if (!root || root.getAttribute(POST_DETAIL_BOUND_ATTR) === 'true') {
		return null;
	}

	const postId = match.params.id;
	if (!postId) {
		renderPostError(root, 'The requested post is missing an identifier.');
		return null;
	}

	root.setAttribute(POST_DETAIL_BOUND_ATTR, 'true');
	root.innerHTML = `
		<div class="post-detail-loading" aria-busy="true">
			<p>Loading post...</p>
		</div>
	`;

	return { root, postId };
}

export async function initPostDetailPage(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const fetchRef = options.fetchRef ?? (typeof fetch === 'function' ? fetch.bind(windowRef) : null);

	if (
		!windowRef ||
		!documentRef ||
		typeof fetchRef !== 'function' ||
		typeof documentRef.querySelector !== 'function'
	) {
		return null;
	}

	const match = matchRoute(windowRef.location.pathname || '/');
	if (match?.route?.id !== 'post-detail') {
		return null;
	}

	const context = resolvePostDetailContext(documentRef, match);
	if (!context) {
		return null;
	}

	const { root, postId } = context;

	const post = await getPostById(fetchRef, postId);
	if (!post) {
		renderPostError(root, 'Unable to load this post right now.');
		return null;
	}

	root.outerHTML = renderPostDetailView(post);

	const nextRoot = documentRef.querySelector('[data-screen="post-detail"]');
	if (!nextRoot) {
		return null;
	}

	nextRoot.setAttribute(POST_DETAIL_BOUND_ATTR, 'true');

	initReactionBindings({ documentRef, fetchRef });

	const commentsContainer = nextRoot.querySelector('[data-comments]');
	if (!commentsContainer) {
		return { post, comments: [] };
	}

	const commentForm = nextRoot.querySelector('#comment-form');
	bindCommentForm({ form: commentForm, fetchRef, postId, commentsContainer });

	const comments = await reloadComments(fetchRef, postId, commentsContainer);

	void highlightCommentFromQuery({ windowRef, documentRef, root: commentsContainer });

	return { post, comments };
}

function setPostFormFeedback(form, message, tone = 'error') {
	const feedback = form?.querySelector?.('[data-post-form-feedback]');
	if (!feedback) {
		return;
	}

	if (!message) {
		feedback.hidden = true;
		feedback.textContent = '';
		feedback.removeAttribute('data-tone');
		feedback.removeAttribute('role');
		return;
	}

	feedback.hidden = false;
	feedback.textContent = message;
	feedback.dataset.tone = tone;
	feedback.setAttribute('role', tone === 'error' ? 'alert' : 'status');
}

function clearPostFormFeedback(form) {
	setPostFormFeedback(form, '');
}

function setPostFormBusy(form, isBusy, busyLabel) {
	const submitButtons = form ? Array.from(form.querySelectorAll('button[type="submit"]')) : [];
	for (const button of submitButtons) {
		if (isBusy) {
			if (!button.dataset.originalLabel) {
				button.dataset.originalLabel = button.textContent ?? '';
			}
			button.disabled = true;
			if (button.classList.contains('post-editor__button--primary')) {
				button.textContent = busyLabel;
			}
			continue;
		}

		button.disabled = false;
		if (button.dataset.originalLabel) {
			button.textContent = button.dataset.originalLabel;
			delete button.dataset.originalLabel;
		}
	}
}

function renderCategoryCheckboxes(host, categories = [], selectedIds = []) {
	if (!(host instanceof HTMLElement)) {
		return;
	}

	host.innerHTML = '';
	const selected = new Set(normalizeCategoryIDs(selectedIds));

	for (const category of categories) {
		const categoryId = Number(category?.id);
		if (!Number.isFinite(categoryId) || categoryId <= 0) {
			continue;
		}

		const label = host.ownerDocument.createElement('label');
		label.className = 'category-checkbox';

		const input = host.ownerDocument.createElement('input');
		input.type = 'checkbox';
		input.value = String(categoryId);
		input.checked = selected.has(categoryId);

		const text = host.ownerDocument.createElement('span');
		text.textContent = String(category?.name ?? '');

		label.appendChild(input);
		label.appendChild(text);
		host.appendChild(label);
	}
}

function getSelectedCategoryIds(host) {
	if (!(host instanceof HTMLElement)) {
		return [];
	}

	return normalizeCategoryIDs(
		Array.from(host.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value),
	);
}

function getSafeReturnPath(windowRef, fallbackPath) {
	const raw = new URLSearchParams(windowRef.location.search).get('next');
	if (!raw) return fallbackPath;
	if (!raw.startsWith('/') || raw.startsWith('//')) return fallbackPath;
	return raw;
}

function resolvePostFormMode(match) {
	if (!match) {
		return null;
	}

	if (match.route.id === 'create-post') {
		return 'create';
	}

	if (match.route.id === 'edit-post') {
		return 'edit';
	}

	return null;
}

function resolveNavigate(windowRef, navigateOverride) {
	return (
		navigateOverride ??
		((path, navOptions = {}) => navigateTo(windowRef, path, !!navOptions.replace))
	);
}

function resolvePostFormElements(root, mode) {
	if (!root) {
		return null;
	}

	const form = root.querySelector(mode === 'create' ? '#create-post-form' : '#edit-post-form');
	if (!(form instanceof HTMLFormElement)) {
		return null;
	}

	const titleInput = form.querySelector('#title');
	const bodyInput = form.querySelector('#body');
	const imageInput = form.querySelector('#image');
	const categoryHost = form.querySelector('#categoryCheckboxes');
	const imageButton = form.querySelector('#image-button');
	const imageName = form.querySelector('#image-name');
	const imagePreview = form.querySelector('#image-preview');
	const imageClear = form.querySelector('#image-clear');
	const imagePreviewImg = imagePreview?.querySelector('img');
	const backLink = form.querySelector('.post-editor__back-link');

	if (
		!(titleInput instanceof HTMLInputElement) ||
		!(bodyInput instanceof HTMLTextAreaElement) ||
		!(imageInput instanceof HTMLInputElement) ||
		!(categoryHost instanceof HTMLElement)
	) {
		return null;
	}

	return {
		form,
		titleInput,
		bodyInput,
		imageInput,
		categoryHost,
		imageButton,
		imageName,
		imagePreview,
		imageClear,
		imagePreviewImg,
		backLink,
	};
}

function createPostFormContext(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const fetchRef = options.fetchRef ?? (typeof fetch === 'function' ? fetch.bind(windowRef) : null);
	const navigate = resolveNavigate(windowRef, options.navigate);

	if (
		!windowRef ||
		!documentRef ||
		typeof fetchRef !== 'function' ||
		typeof documentRef.querySelector !== 'function'
	) {
		return null;
	}

	const match = matchRoute(windowRef.location.pathname || '/');
	const mode = resolvePostFormMode(match);
	if (!mode) {
		return null;
	}

	const screenId = mode === 'create' ? 'create-post' : 'edit-post';
	const root = documentRef.querySelector(`[data-screen="${screenId}"]`);
	if (!root || root.getAttribute(POST_FORM_BOUND_ATTR) === 'true') {
		return null;
	}

	const elements = resolvePostFormElements(root, mode);
	if (!elements) {
		return null;
	}

	root.setAttribute(POST_FORM_BOUND_ATTR, 'true');

	return {
		windowRef,
		documentRef,
		fetchRef,
		navigate,
		match,
		mode,
		root,
		postId: match.params.id ? Number(match.params.id) : null,
		persistedImageURL: null,
		removeImage: false,
		imagePicker: null,
		categories: [],
		...elements,
	};
}

function navigateTo(windowRef, path, replace = false) {
	const normalized = path || '/';
	if (replace) {
		windowRef.history.replaceState({}, '', normalized);
	} else {
		windowRef.history.pushState({}, '', normalized);
	}
	windowRef.dispatchEvent(new PopStateEvent('popstate'));
}

function initializeImagePickerState(context) {
	context.imagePicker = setupImagePicker({
		input: context.imageInput,
		triggerButton: context.imageButton,
		clearButton: context.imageClear,
		nameLabel: context.imageName,
		previewContainer: context.imagePreview,
		previewImage: context.imagePreviewImg,
		persistedLabel:
			context.mode === 'create' ? 'Saved draft image attached' : 'Current post image attached',
		onTooLarge: () => {
			setPostFormFeedback(context.form, 'Image must be 20MB or smaller.');
		},
		onClearPersisted: () => {
			context.persistedImageURL = null;
			context.removeImage = true;
		},
	});

	context.imageInput.addEventListener('change', () => {
		if (context.imagePicker.getFile()) {
			context.removeImage = false;
		}
	});
}

async function initializeCategories(context) {
	setPostFormFeedback(context.form, 'Loading categories...', 'success');
	const categories = await loadPostCategories(context.fetchRef);
	if (!Array.isArray(categories)) {
		setPostFormFeedback(context.form, 'Unable to load categories.');
		return false;
	}

	context.categories = categories;
	renderCategoryCheckboxes(context.categoryHost, categories);
	return true;
}

async function initializeEditMode(context) {
	if (!(Number.isFinite(context.postId) && context.postId > 0)) {
		setPostFormFeedback(context.form, 'Invalid post ID.');
		return false;
	}

	if (context.backLink instanceof HTMLAnchorElement) {
		context.backLink.href = getSafeReturnPath(context.windowRef, `/posts/${context.postId}`);
	}

	setPostFormFeedback(context.form, 'Loading post...', 'success');
	const result = await loadPostForEdit(context.fetchRef, context.postId);
	if (!result.ok || !result.data) {
		if (result.status === 404) {
			setPostFormFeedback(context.form, 'Post not found.');
			return false;
		}

		if (result.status === 401) {
			context.navigate('/login', { replace: true });
			return false;
		}

		setPostFormFeedback(
			context.form,
			result?.payload?.error?.message || 'Unable to load this post.',
		);
		return false;
	}

	context.titleInput.value = String(result.data.title ?? '');
	context.bodyInput.value = String(result.data.body ?? '');
	renderCategoryCheckboxes(
		context.categoryHost,
		context.categories,
		result.data.category_ids || [],
	);
	context.persistedImageURL = result.data.image_url ?? null;
	context.removeImage = false;
	context.imagePicker.setPersistedUrl(context.persistedImageURL);
	clearPostFormFeedback(context.form);
	return true;
}

function initializeCreateMode(context) {
	if (context.backLink instanceof HTMLAnchorElement) {
		context.backLink.href = '/';
	}

	clearPostFormFeedback(context.form);
}

function collectPostFormPayload(context) {
	const title = context.titleInput.value.trim();
	const body = context.bodyInput.value.trim();
	const categoryIds = getSelectedCategoryIds(context.categoryHost);
	const imageFile = context.imagePicker?.getFile?.() ?? context.imageInput?.files?.[0] ?? null;
	const hasPersistedImage = !!context.persistedImageURL;

	return {
		title,
		body,
		categoryIds,
		imageFile,
		hasPersistedImage,
	};
}

function validatePostForm(
	{ title, categoryIds, body, imageFile, hasPersistedImage },
	isDraft = false,
) {
	if (!title) {
		return 'Title is required.';
	}

	// Drafts are work-in-progress, so the category requirement is relaxed to
	// match the backend, which skips the category check for status="draft".
	if (!isDraft && categoryIds.length === 0) {
		return 'Select at least one category.';
	}

	if (!body && !imageFile && !hasPersistedImage) {
		return 'Post body is required unless an image is attached.';
	}

	return null;
}

function isPostFormMounted(context) {
	return context?.root?.isConnected !== false && context?.form?.isConnected !== false;
}

async function handleCreateSubmit(context, payload, isDraft = false) {
	const result = await createPost(context.fetchRef, {
		title: payload.title,
		body: payload.body,
		categoryIds: payload.categoryIds,
		imageFile: payload.imageFile,
		imageURL: context.persistedImageURL,
		status: isDraft ? 'draft' : 'published',
	});
	if (!isPostFormMounted(context)) {
		return;
	}

	if (!result.ok) {
		setPostFormFeedback(
			context.form,
			result?.payload?.error?.message ||
				(isDraft ? 'Unable to save the draft right now.' : 'Unable to create the post right now.'),
		);
		return;
	}

	if (isDraft) {
		// Drafts live in the Activity view; navigate there inside the SPA rather
		// than to the (unpublished) post detail page.
		setPostFormFeedback(context.form, 'Draft saved.', 'success');
		context.navigate('/activity');
		return;
	}

	setPostFormFeedback(context.form, 'Post created.', 'success');
	const createdId = Number(result?.data?.id);
	context.navigate(Number.isFinite(createdId) && createdId > 0 ? `/posts/${createdId}` : '/');
}

async function handleEditSubmit(context, payload) {
	const result = await updatePost(context.fetchRef, context.postId, {
		title: payload.title,
		body: payload.body,
		categoryIds: payload.categoryIds,
		imageFile: payload.imageFile,
		removeImage: context.removeImage && !payload.imageFile,
	});
	if (!isPostFormMounted(context)) {
		return;
	}

	if (!result.ok) {
		if (result.status === 401) {
			context.navigate('/login', { replace: true });
			return;
		}

		if (result.status === 403) {
			setPostFormFeedback(context.form, 'You can only edit your own posts.');
			return;
		}

		if (result.status === 404) {
			setPostFormFeedback(context.form, 'Post not found.');
			return;
		}

		setPostFormFeedback(
			context.form,
			result?.payload?.error?.message || 'Unable to update the post right now.',
		);
		return;
	}

	setPostFormFeedback(context.form, 'Post updated.', 'success');
	const returnTarget =
		context.backLink instanceof HTMLAnchorElement ? context.backLink.getAttribute('href') : null;
	context.navigate(returnTarget || `/posts/${context.postId}`);
}

function bindPostFormEvents(context) {
	if (context.form.dataset.bound === 'true') {
		return;
	}

	context.form.dataset.bound = 'true';

	context.form.addEventListener('submit', async (event) => {
		event.preventDefault();
		clearPostFormFeedback(context.form);

		// The create-post form has a "Save Draft" submit button (name="action"
		// value="draft") alongside Publish. Drafts only exist in create mode
		// (edit-post has no draft control); a keyboard submit has no submitter, so
		// it defaults to a normal publish.
		const isDraft = context.mode === 'create' && event.submitter?.value === 'draft';

		const payload = collectPostFormPayload(context);
		const validationError = validatePostForm(payload, isDraft);
		if (validationError) {
			setPostFormFeedback(context.form, validationError);
			return;
		}

		setPostFormBusy(
			context.form,
			true,
			context.mode === 'create' ? (isDraft ? 'Saving draft...' : 'Publishing...') : 'Updating...',
		);

		try {
			if (context.mode === 'create') {
				await handleCreateSubmit(context, payload, isDraft);
				return;
			}

			await handleEditSubmit(context, payload);
		} finally {
			if (isPostFormMounted(context)) {
				setPostFormBusy(context.form, false, '');
			}
		}
	});
}

export async function initPostFormPage(options = {}) {
	const context = createPostFormContext(options);
	if (!context) {
		return null;
	}

	const categoriesReady = await initializeCategories(context);
	if (!categoriesReady) {
		return null;
	}

	initializeImagePickerState(context);

	if (context.mode === 'edit') {
		const editReady = await initializeEditMode(context);
		if (!editReady) {
			return null;
		}
	} else {
		initializeCreateMode(context);
	}

	bindPostFormEvents(context);
	return context;
}
