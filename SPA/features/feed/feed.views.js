// SPA/features/feed/feed.views.js

export function renderFeedView(title) {
	return `
		<section data-screen="feed" aria-labelledby="screen-feed-title">
			<h1 id="screen-feed-title" class="visually-hidden">${title}</h1>

			<section class="filters" aria-label="Feed filters">
				<div class="filter-group">
					<label for="categoryFilter">Category</label>
					<select id="categoryFilter" name="category_id">
						<option value="">All categories</option>
					</select>
				</div>

				<div class="filter-group">
					<label for="perPageSelect">Posts per page</label>
					<select id="perPageSelect" name="per_page">
						<option value="5">5</option>
						<option value="10">10</option>
						<option value="20">20</option>
						<option value="0">All posts</option>
					</select>
				</div>
			</section>

			<section class="posts">
				<div id="posts-output"></div>

				<div id="posts-empty" class="empty-state" hidden>
					<h3>No posts yet</h3>
					<p>Be the first to start a discussion.</p>
				</div>
			</section>

			<nav class="pagination" id="pagination" hidden aria-label="Feed pagination">
				<button class="btn" id="prevPage" type="button">‹</button>
				<div id="pageNumbers" class="page-numbers"></div>
				<button class="btn" id="nextPage" type="button">›</button>
			</nav>
		</section>
	`;
}
