// SPA/core/router/render-template.js

import { renderActivityView } from '../../features/activity/activity.views.js';
import { renderLoginView, renderRegisterView } from '../../features/auth/auth.views.js';
import { renderFeedView } from '../../features/feed/feed.views.js';
import { renderCreatePostView, renderEditPostView } from '../../features/post/post.views.js';
import { renderPostDetailView } from '../../features/post/post-detail.views.js';
import { renderProfileView } from '../../features/profile/profile.views.js';
import { escapeHTML } from '../utils/html.js';

export function renderTemplate(match) {
	const { id, title } = match.route;

	if (id === 'profile') {
		const userID = escapeHTML(match.params.id || '');
		return renderProfileView(userID);
	}

	if (id === 'login') {
		return renderLoginView();
	}

	if (id === 'register') {
		return renderRegisterView();
	}

	if (id === 'post-detail') {
		return renderPostDetailView({ id: escapeHTML(match.params.id || '') });
	}

	if (id === 'edit-post') {
		const postID = escapeHTML(match.params.id || '');
		return renderEditPostView(postID);
	}

	if (id === 'create-post') {
		return renderCreatePostView();
	}

	if (id === 'activity') {
		return renderActivityView();
	}

	return renderFeedView(escapeHTML(title));
}
