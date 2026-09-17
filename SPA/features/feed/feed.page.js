import { API_BASE } from '../../core/api/constants.js';
import { getPageWindow, nextPage, previousPage } from '../../core/ui/pagination.js';
import { initReactionBindings } from '../post/post.reactions.bindings.js';
import { renderPostCard } from '../post/post-card.views.js';
import { coercePerPage, getFeedQueryState, setFeedQueryState } from './feed.state.js';

const FEED_BOUND_ATTR = 'data-feed-bound';

async function loadCategories(fetchRef) {
	const response = await fetchRef(`${API_BASE}/categories`, {
		credentials: 'include',
		headers: { Accept: 'application/json' },
	});

	if (!response.ok) {
		return [];
	}

	const payload = await response.json();
	return Array.isArray(payload) ? payload : (payload.data ?? []);
}

async function loadPosts(fetchRef, windowRef, { page, perPage, categoryId }) {
	const url = new URL(`${API_BASE}/posts`, windowRef.location.origin);
	url.searchParams.set('page', String(page));

	if (perPage > 0) {
		url.searchParams.set('per_page', String(perPage));
	}

	if (categoryId) {
		url.searchParams.set('category_id', categoryId);
	}

	const response = await fetchRef(url.toString(), {
		credentials: 'include',
		headers: { Accept: 'application/json' },
	});

	if (!response.ok) {
		return null;
	}

	return response.json();
}

function syncCategoryOptions(documentRef, select, categories, selectedCategoryId) {
	if (!select || select.tagName !== 'SELECT') {
		return;
	}

	select.querySelectorAll('option:not(:first-child)').forEach((option) => {
		option.remove();
	});

	for (const category of categories) {
		const option = documentRef.createElement('option');
		option.value = String(category.id);
		option.textContent = category.name;
		select.appendChild(option);
	}

	select.value = selectedCategoryId;
}

async function renderPosts(
	elements,
	state,
	pager,
	fetchRef,
	windowRef,
	isCurrentRequest = () => true,
) {
	const { postsOutput, postsEmpty, pagination } = elements;
	const documentRef = postsOutput?.ownerDocument;

	if (!postsOutput || !postsEmpty || !pagination || !documentRef) {
		return;
	}

	postsOutput.innerHTML = '';
	postsEmpty.hidden = true;
	pagination.hidden = true;

	const payload = await loadPosts(fetchRef, windowRef, state);
	if (!isCurrentRequest()) {
		return;
	}

	const posts = Array.isArray(payload?.data) ? payload.data : [];

	if (posts.length === 0) {
		postsEmpty.hidden = false;
		pager.set(1, 1);
		return;
	}

	for (const post of posts) {
		const card = renderPostCard(documentRef, post, {
			onNavigate: (targetPost) => {
				windowRef.history.pushState({}, '', `/posts/${targetPost.id}`);
				windowRef.dispatchEvent(new PopStateEvent('popstate'));
			},
		});
		postsOutput.appendChild(card);
	}

	if (state.perPage === 0) {
		return;
	}

	const paginationMeta = payload?.meta?.pagination;
	if (paginationMeta && paginationMeta.total_pages > 1) {
		pagination.hidden = false;
		pager.set(paginationMeta.page, paginationMeta.total_pages);
		return;
	}

	pager.set(1, 1);
}

function renderPagination(documentRef, numbersEl, items, onPageChange) {
	if (!numbersEl) {
		return;
	}

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
		if (item.active) {
			button.classList.add('is-active');
		}
		button.addEventListener('click', () => onPageChange(item.value));
		numbersEl.appendChild(button);
	}
}

function createPaginationController(documentRef, { prevBtn, nextBtn, numbersEl, onPageChange }) {
	let currentPage = 1;
	let totalPages = 1;

	function updateControls() {
		if (prevBtn) {
			prevBtn.disabled = currentPage <= 1;
		}

		if (nextBtn) {
			nextBtn.disabled = currentPage >= totalPages;
		}

		renderPagination(documentRef, numbersEl, getPageWindow(currentPage, totalPages), onPageChange);
	}

	return {
		set(page, total) {
			currentPage = page;
			totalPages = total;
			updateControls();
		},
		next() {
			onPageChange(nextPage(currentPage, totalPages));
		},
		prev() {
			onPageChange(previousPage(currentPage, totalPages));
		},
	};
}

export function initFeedPage(options = {}) {
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

	const root = documentRef.querySelector('[data-screen="feed"]');
	if (!root) {
		return null;
	}

	if (root.getAttribute(FEED_BOUND_ATTR) === 'true') {
		return null;
	}

	root.setAttribute(FEED_BOUND_ATTR, 'true');

	const elements = {
		root,
		categoryFilter: root.querySelector('#categoryFilter'),
		perPageSelect: root.querySelector('#perPageSelect'),
		postsOutput: root.querySelector('#posts-output'),
		postsEmpty: root.querySelector('#posts-empty'),
		pagination: root.querySelector('#pagination'),
		prevPage: root.querySelector('#prevPage'),
		nextPage: root.querySelector('#nextPage'),
		pageNumbers: root.querySelector('#pageNumbers'),
	};

	const state = getFeedQueryState(windowRef);

	if (elements.perPageSelect) {
		elements.perPageSelect.value = String(state.perPage);
	}

	initReactionBindings({ documentRef, fetchRef });
	let postsRequestSequence = 0;

	function renderCurrentPosts() {
		postsRequestSequence += 1;
		const requestID = postsRequestSequence;
		const requestState = { ...state };
		return renderPosts(elements, requestState, pager, fetchRef, windowRef, () => {
			return requestID === postsRequestSequence;
		});
	}

	const pager = createPaginationController(documentRef, {
		prevBtn: elements.prevPage,
		nextBtn: elements.nextPage,
		numbersEl: elements.pageNumbers,
		onPageChange: (page) => {
			if (page === state.page) {
				return;
			}
			state.page = page;
			setFeedQueryState(windowRef, state);
			void renderCurrentPosts();
		},
	});

	elements.prevPage?.addEventListener('click', () => pager.prev());
	elements.nextPage?.addEventListener('click', () => pager.next());

	elements.perPageSelect?.addEventListener('change', () => {
		const nextPerPage = Number.parseInt(elements.perPageSelect.value, 10);
		state.perPage = coercePerPage(nextPerPage);
		state.page = 1;
		setFeedQueryState(windowRef, state);
		void renderCurrentPosts();
	});

	elements.categoryFilter?.addEventListener('change', () => {
		state.categoryId = elements.categoryFilter.value || '';
		state.page = 1;
		setFeedQueryState(windowRef, state);
		void renderCurrentPosts();
	});

	void (async () => {
		const categories = await loadCategories(fetchRef);
		syncCategoryOptions(documentRef, elements.categoryFilter, categories, state.categoryId);
		await renderCurrentPosts();
	})();

	return { state, elements };
}
