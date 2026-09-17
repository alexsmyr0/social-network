import { escapeHTML } from '../../core/utils/html.js';

export function renderProfileView(userID) {
	return `
		<div class="profile-page ds-fade-in" data-screen="profile" data-user-id="${userID}">
			<div class="profile-container">
				<div class="profile-card glass-panel">
					<div class="profile-cover"></div>
					<div class="profile-avatar-wrapper">
						<div class="profile-avatar skeleton"></div>
					</div>
					<div id="profile-content" class="profile-content">
						<div class="skeleton-line title"></div>
						<div class="skeleton-line subtitle"></div>
						<div class="profile-details-grid">
							<div class="skeleton-line detail"></div>
							<div class="skeleton-line detail"></div>
							<div class="skeleton-line detail"></div>
						</div>
					</div>
				</div>
			</div>
		</div>
	`;
}

export function renderProfileContent(profile) {
	return `
		<div class="profile-info-header">
			<h1 class="profile-name">${escapeHTML(profile.first_name)} ${escapeHTML(profile.last_name)}</h1>
			<p class="profile-username">@${escapeHTML(profile.username)}</p>
		</div>
		
		<div class="profile-details-grid">
			<div class="profile-stat-box glass-panel-subtle">
				<span class="stat-label">Age</span>
				<span class="stat-value">${escapeHTML(profile.age)}</span>
			</div>
			<div class="profile-stat-box glass-panel-subtle">
				<span class="stat-label">Gender</span>
				<span class="stat-value">${escapeHTML(capitalize(profile.gender))}</span>
			</div>
			<div class="profile-stat-box glass-panel-subtle">
				<span class="stat-label">Member ID</span>
				<span class="stat-value">#${escapeHTML(profile.user_id)}</span>
			</div>
		</div>
	`;
}

export function renderProfileAvatar(profile) {
	const avatarInitial = (profile.username || 'U')[0].toUpperCase();
	return `<div class="avatar-letter">${escapeHTML(avatarInitial)}</div>`;
}

function capitalize(str) {
	if (!str) return '';
	return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
