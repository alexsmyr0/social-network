// SPA/features/activity/activity.page.js

import { setupImagePicker } from '../../core/shared/image-picker.js';
import { clampPage, getPageWindow, nextPage, previousPage } from '../../core/ui/pagination.js';
import { initReactionBindings } from '../post/post.reactions.bindings.js';
import {
	deleteActivityComment,
	deleteActivityPost,
	getActivityQueryState,
	getCurrentUserID,
	loadActivity,
	setActivityPostStatus,
	setActivityQueryState,
	updateActivityComment,
} from './activity.api.js';
import {
	renderActivityCommentEntry,
	renderActivityPostCard,
	renderCommentEditorMarkup,
} from './activity.views.js';

const ACTIVITY_BOUND_ATTR = 'data-activity-bound';

const SECTION_MAP = {
	created_posts: {
		outputId: 'activity-created-output',
		emptyId: 'activity-created-empty',
		countId: 'activity-created-count',
		contentId: 'activity-created-content',
		showOwnerActions: true,
		kind: 'posts',
	},
	liked_posts: {
		outputId: 'activity-liked-output',
		emptyId: 'activity-liked-empty',
		countId: 'activity-liked-count',
		contentId: 'activity-liked-content',
		showOwnerActions: false,
		kind: 'posts',
	},
	disliked_posts: {
		outputId: 'activity-disliked-output',
		emptyId: 'activity-disliked-empty',
		countId: 'activity-disliked-count',
		contentId: 'activity-disliked-content',
		showOwnerActions: false,
		kind: 'posts',
	},
	comments: {
		outputId: 'activity-comments-output',
		emptyId: 'activity-comments-empty',
		countId: 'activity-comments-count',
		contentId: 'activity-comments-content',
		showOwnerActions: false,
		kind: 'comments',
	},
};

function asItems(section) {
	return Array.isArray(section?.items) ? section.items : [];
}

function asPagination(section) {
	return section?.pagination ?? {};
}

function setFeedback(root, message, tone = 'info') {
	const node = root?.querySelector?.('[data-activity-feedback]');
	if (!node) return;

	if (!message) {
		node.hidden = true;
		node.textContent = '';
		node.removeAttribute('role');
		return;
	}

	node.hidden = false;
	node.textContent = message;
	node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
}

function bindSectionToggles(root) {
	const sections = root.querySelectorAll('.activity-section');
	for (const section of sections) {
		const head = section.querySelector('.activity-section-head');
		const toggle = section.querySelector('[data-activity-toggle]');
		if (!head || !toggle) continue;

		const controlsId = toggle.getAttribute('aria-controls');
		const content = controlsId ? root.ownerDocument.getElementById(controlsId) : null;
		if (!content) continue;

		const setOpen = (open) => {
			toggle.setAttribute('aria-expanded', String(open));
			content.hidden = !open;
		};

		setOpen(toggle.getAttribute('aria-expanded') === 'true');

		const toggleSection = () => {
			setOpen(!(toggle.getAttribute('aria-expanded') === 'true'));
		};

		head.addEventListener('click', (event) => {
			if (event.target?.closest?.('[data-activity-toggle]')) return;
			toggleSection();
		});

		toggle.addEventListener('click', (event) => {
			event.stopPropagation();
			toggleSection();
		});
	}
}

function renderPostsSection(root, section, config, currentUserId) {
	const output = root.ownerDocument.getElementById(config.outputId);
	const empty = root.ownerDocument.getElementById(config.emptyId);
	const count = root.ownerDocument.getElementById(config.countId);
	if (!output || !empty || !count) return;

	output.innerHTML = '';
	empty.hidden = true;

	const items = asItems(section);
	const pagination = asPagination(section);
	count.textContent = String(pagination.total ?? items.length);

	if (items.length === 0) {
		empty.hidden = false;
		return;
	}

	const markup = items
		.map((post) => {
			const isOwner =
				Number(post.author_id ?? post.user_id) === Number(currentUserId) &&
				Number(currentUserId) > 0;
			const showOwnerActions = config.showOwnerActions && isOwner;
			return renderActivityPostCard(post, { showOwnerActions });
		})
		.join('');

	output.innerHTML = markup;
}

function renderCommentsSection(root, section, config) {
	const output = root.ownerDocument.getElementById(config.outputId);
	const empty = root.ownerDocument.getElementById(config.emptyId);
	const count = root.ownerDocument.getElementById(config.countId);
	if (!output || !empty || !count) return;

	output.innerHTML = '';
	empty.hidden = true;

	const items = asItems(section);
	const pagination = asPagination(section);
	count.textContent = String(pagination.total ?? items.length);

	if (items.length === 0) {
		empty.hidden = false;
		return;
	}

	output.innerHTML = items.map((comment) => renderActivityCommentEntry(comment)).join('');
}

function renderSections(root, data, currentUserId) {
	renderPostsSection(root, data.created_posts, SECTION_MAP.created_posts, currentUserId);
	renderCommentsSection(root, data.comments, SECTION_MAP.comments);
	renderPostsSection(root, data.liked_posts, SECTION_MAP.liked_posts, currentUserId);
	renderPostsSection(root, data.disliked_posts, SECTION_MAP.disliked_posts, currentUserId);
}

function computeTotalPages(data) {
	return Math.max(
		asPagination(data?.created_posts).total_pages || 1,
		asPagination(data?.comments).total_pages || 1,
		asPagination(data?.liked_posts).total_pages || 1,
		asPagination(data?.disliked_posts).total_pages || 1,
	);
}

function renderPaginationControls(documentRef, numbersEl, items, onSelect) {
	if (!numbersEl) return;
	numbersEl.innerHTML = '';

	for (const item of items) {
		if (item.type === 'ellipsis') {
			const span = documentRef.createElement('span');
			span.className = 'pagination-ellipsis';
			span.textContent = '...';
			numbersEl.appendChild(span);
			continue;
		}

		const button = documentRef.createElement('button');
		button.type = 'button';
		button.className = 'pagination-btn';
		button.textContent = String(item.value);
		button.disabled = item.active;
		if (item.active) button.classList.add('is-active');
		button.addEventListener('click', () => onSelect(item.value));
		numbersEl.appendChild(button);
	}
}

function createPaginationController(documentRef, { prevBtn, nextBtn, numbersEl, onPageChange }) {
	let currentPage = 1;
	let totalPages = 1;

	const update = () => {
		if (prevBtn) prevBtn.disabled = currentPage <= 1;
		if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
		renderPaginationControls(
			documentRef,
			numbersEl,
			getPageWindow(currentPage, totalPages),
			onPageChange,
		);
	};

	return {
		set(page, total) {
			totalPages = Math.max(total, 1);
			currentPage = clampPage(page, totalPages);
			update();
		},
		next() {
			onPageChange(nextPage(currentPage, totalPages));
		},
		prev() {
			onPageChange(previousPage(currentPage, totalPages));
		},
		getCurrentPage: () => currentPage,
		getTotalPages: () => totalPages,
	};
}

function openCommentInlineEditor(article, refresh, fetchRef) {
	if (article.classList.contains('is-editing')) return;

	const commentId = article.dataset.commentId;
	if (!commentId) return;

	const content = article.querySelector('.activity-comment-content');
	if (!content) return;

	const originalMarkup = content.innerHTML;
	const originalBody = article.dataset.commentBody ?? '';
	const originalImageURL = article.dataset.commentImageUrl ?? '';

	article.classList.add('is-editing');
	content.innerHTML = renderCommentEditorMarkup(originalBody);

	const form = content.querySelector('[data-comment-edit-form]');
	const textarea = form?.querySelector?.('textarea');
	const cancelBtn = form?.querySelector?.('.cancel-edit');
	const imageInput = form?.querySelector?.('.comment-image-input');
	const imageButton = form?.querySelector?.('.comment-image-btn');
	const imageClear = form?.querySelector?.('.image-clear');
	const imageName = form?.querySelector?.('.comment-image-name');
	const imagePreview = form?.querySelector?.('.comment-image-preview');
	const imagePreviewImg = imagePreview?.querySelector?.('img');

	let removePersistedImage = false;
	const picker = setupImagePicker({
		input: imageInput,
		triggerButton: imageButton,
		clearButton: imageClear,
		nameLabel: imageName,
		previewContainer: imagePreview,
		previewImage: imagePreviewImg,
		persistedUrl: originalImageURL || null,
		persistedLabel: 'Current image attached',
		onClearPersisted: () => {
			removePersistedImage = true;
		},
	});

	const close = () => {
		picker?.destroy?.();
		content.innerHTML = originalMarkup;
		article.classList.remove('is-editing');
	};

	cancelBtn?.addEventListener('click', (event) => {
		event.preventDefault();
		close();
	});

	form?.addEventListener('submit', async (event) => {
		event.preventDefault();

		const body = (textarea?.value ?? '').trim();
		const imageFile = picker?.getFile?.() ?? imageInput?.files?.[0] ?? null;
		const hasPersistedImage = !!originalImageURL && !removePersistedImage;
		const bodyChanged = body !== (originalBody || '').trim();
		const imageChanged = !!imageFile || removePersistedImage;

		if (!body && !imageFile && !hasPersistedImage) return;
		if (!bodyChanged && !imageChanged) return;

		const result = await updateActivityComment(fetchRef, commentId, {
			body,
			imageFile,
			removeImage: removePersistedImage && !imageFile,
		});

		if (!result.ok) return;

		close();
		await refresh();
	});
}

async function runAction(button, event, action) {
	event.preventDefault();
	event.stopPropagation();
	button.disabled = true;
	try {
		await action();
	} finally {
		button.disabled = false;
	}
}

function handleStatusToggle(button, event, { fetchRef, refresh }) {
	const postId = button.dataset.postId;
	const current = button.dataset.currentStatus;
	if (!postId || !current) return;
	const next = current === 'draft' ? 'published' : 'draft';
	void runAction(button, event, async () => {
		const result = await setActivityPostStatus(fetchRef, postId, next);
		if (result.ok) await refresh();
	});
}

function handleDeletePost(button, event, { fetchRef, refresh }) {
	const postId = button.dataset.postId;
	if (!postId) return;
	void runAction(button, event, async () => {
		const result = await deleteActivityPost(fetchRef, postId);
		if (result.ok) await refresh();
	});
}

function handleEditComment(button, event, { fetchRef, refresh }) {
	event.preventDefault();
	event.stopPropagation();
	const article = button.closest('.activity-comment');
	if (article instanceof HTMLElement) {
		openCommentInlineEditor(article, refresh, fetchRef);
	}
}

function handleDeleteComment(button, event, { fetchRef, refresh }) {
	const commentId = button.dataset.commentId;
	if (!commentId) return;
	void runAction(button, event, async () => {
		const result = await deleteActivityComment(fetchRef, commentId);
		if (result.ok) await refresh();
	});
}

const ACTION_HANDLERS = {
	'status-toggle': handleStatusToggle,
	'delete-post': handleDeletePost,
	'edit-comment': handleEditComment,
	'delete-comment': handleDeleteComment,
};

function bindInteractions({ root, fetchRef, refresh }) {
	root.addEventListener(
		'click',
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;

			const actionable = target.closest('[data-action]');
			if (!actionable) return;

			const handler = ACTION_HANDLERS[actionable.dataset.action];
			if (typeof handler === 'function') {
				handler(actionable, event, { fetchRef, refresh });
			}
		},
		true,
	);
}

export function initActivityPage(options = {}) {
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

	const root = documentRef.querySelector('[data-screen="activity"]');
	if (!root) return null;

	if (root.getAttribute(ACTIVITY_BOUND_ATTR) === 'true') {
		return null;
	}

	root.setAttribute(ACTIVITY_BOUND_ATTR, 'true');

	const statusSelect = root.querySelector('#activity-status-filter');
	const perPageSelect = root.querySelector('#activity-per-page');
	const prevBtn = root.querySelector('#activity-prev-page');
	const nextBtn = root.querySelector('#activity-next-page');
	const numbersEl = root.querySelector('#activity-page-numbers');
	const paginationEl = root.querySelector('#activity-pagination');

	const state = getActivityQueryState(windowRef);

	if (statusSelect) statusSelect.value = state.status;
	if (perPageSelect) perPageSelect.value = String(state.perPage);

	bindSectionToggles(root);
	initReactionBindings({ documentRef, fetchRef });

	let currentUserId = 0;

	const pager = createPaginationController(documentRef, {
		prevBtn,
		nextBtn,
		numbersEl,
		onPageChange: (page) => {
			if (page === state.page) return;
			state.page = page;
			setActivityQueryState(windowRef, state);
			void refresh();
		},
	});

	prevBtn?.addEventListener('click', () => pager.prev());
	nextBtn?.addEventListener('click', () => pager.next());

	statusSelect?.addEventListener('change', () => {
		state.status = statusSelect.value || 'all';
		state.page = 1;
		setActivityQueryState(windowRef, state);
		void refresh();
	});

	perPageSelect?.addEventListener('change', () => {
		const value = Number.parseInt(perPageSelect.value, 10);
		state.perPage = Number.isFinite(value) && value > 0 ? value : 10;
		state.page = 1;
		setActivityQueryState(windowRef, state);
		void refresh();
	});

	const refresh = async () => {
		setFeedback(root, 'Loading activity...', 'info');
		const result = await loadActivity(fetchRef, windowRef, state);

		if (!result.ok || !result.data) {
			setFeedback(root, 'Failed to load activity.', 'error');
			return;
		}

		setFeedback(root, '');
		renderSections(root, result.data, currentUserId);

		const totalPages = computeTotalPages(result.data);
		if (paginationEl) paginationEl.hidden = totalPages <= 1;
		pager.set(state.page, totalPages);
	};

	bindInteractions({ root, fetchRef, refresh });

	void (async () => {
		currentUserId = await getCurrentUserID(fetchRef);
		await refresh();
	})();

	return { root, state, refresh };
}
