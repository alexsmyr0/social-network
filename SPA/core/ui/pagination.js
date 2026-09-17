export function clampPage(page, totalPages) {
	return Math.min(Math.max(page, 1), Math.max(totalPages, 1));
}

export function nextPage(currentPage, totalPages) {
	return clampPage(currentPage + 1, totalPages);
}

export function previousPage(currentPage, totalPages) {
	return clampPage(currentPage - 1, totalPages);
}

export function getPageWindow(currentPage, totalPages, maxVisible = 5) {
	if (totalPages <= 0) {
		return [];
	}

	if (totalPages <= maxVisible) {
		return Array.from({ length: totalPages }, (_value, index) => ({
			type: 'page',
			value: index + 1,
			active: index + 1 === currentPage,
		}));
	}

	const items = [{ type: 'page', value: 1, active: currentPage === 1 }];
	const windowSize = Math.max(1, maxVisible - 2);
	let start = currentPage - Math.floor(windowSize / 2);
	let end = start + windowSize - 1;

	if (start < 2) {
		start = 2;
		end = start + windowSize - 1;
	}

	if (end > totalPages - 1) {
		end = totalPages - 1;
		start = Math.max(2, end - windowSize + 1);
	}

	if (start > 2) {
		items.push({ type: 'ellipsis' });
	}

	for (let page = start; page <= end; page += 1) {
		items.push({ type: 'page', value: page, active: page === currentPage });
	}

	if (end < totalPages - 1) {
		items.push({ type: 'ellipsis' });
	}

	items.push({ type: 'page', value: totalPages, active: currentPage === totalPages });
	return items;
}
