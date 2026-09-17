package db

const (
	defaultPage    = 1
	defaultPerPage = 20
	maxPerPage     = 100
)

func normalizePagination(page, perPage int) (int, int) {
	if page < 1 {
		page = defaultPage
	}
	if perPage < 1 {
		perPage = defaultPerPage
	}
	if perPage > maxPerPage {
		perPage = maxPerPage
	}
	return page, perPage
}
