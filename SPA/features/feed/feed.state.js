const DEFAULT_PER_PAGE = 10;
const ALLOWED_PER_PAGE_VALUES = new Set([0, 5, 10, 20]);

function toPositiveInt(value) {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getFeedQueryState(windowRef) {
	const params = new URLSearchParams(windowRef.location.search);
	const page = toPositiveInt(params.get('page')) ?? 1;
	const requestedPerPage = Number.parseInt(params.get('per_page') ?? '', 10);
	const perPage = ALLOWED_PER_PAGE_VALUES.has(requestedPerPage)
		? requestedPerPage
		: DEFAULT_PER_PAGE;
	const categoryId = toPositiveInt(params.get('category_id'));

	return {
		page,
		perPage,
		categoryId: categoryId ? String(categoryId) : '',
	};
}

export function buildFeedUrl(windowRef, { page, perPage, categoryId }) {
	const url = new URL(windowRef.location.href);
	url.search = '';

	if (page > 1) {
		url.searchParams.set('page', String(page));
	}

	if (perPage !== DEFAULT_PER_PAGE) {
		url.searchParams.set('per_page', String(perPage));
	}

	if (categoryId) {
		url.searchParams.set('category_id', String(categoryId));
	}

	return `${url.pathname}${url.search}`;
}

export function setFeedQueryState(windowRef, state) {
	windowRef.history.pushState({}, '', buildFeedUrl(windowRef, state));
}

export function coercePerPage(value) {
	return ALLOWED_PER_PAGE_VALUES.has(value) ? value : DEFAULT_PER_PAGE;
}
