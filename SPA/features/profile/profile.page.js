// SPA/features/profile/profile.page.js

import { API_BASE } from '../../core/api/constants.js';
import { renderProfileAvatar, renderProfileContent } from './profile.views.js';

const PROFILE_BOUND_ATTR = 'data-profile-bound';

async function loadProfile(fetchRef, userID) {
	const response = await fetchRef(`${API_BASE}/users/${userID}/profile`, {
		credentials: 'include',
		headers: { Accept: 'application/json' },
	});

	if (!response.ok) {
		return null;
	}

	const payload = await response.json();
	return payload.data ?? payload;
}

function fillProfileFields(contentEl, profile) {
	if (!contentEl || !profile) return;
	contentEl.innerHTML = renderProfileContent(profile);

	const nameEl = contentEl.querySelector('.profile-name');
	if (nameEl) {
		nameEl.textContent = `${profile.first_name || ''} ${profile.last_name || ''}`;
	}

	const userEl = contentEl.querySelector('.profile-username');
	if (userEl) {
		userEl.textContent = `@${profile.username || ''}`;
	}

	const ageEl = contentEl.querySelector('[data-field="age"]');
	if (ageEl) ageEl.textContent = String(profile.age || '');

	const genderEl = contentEl.querySelector('[data-field="gender"]');
	if (genderEl) genderEl.textContent = profile.gender || '';

	const idEl = contentEl.querySelector('[data-field="id"]');
	if (idEl) idEl.textContent = `#${profile.user_id || ''}`;

	contentEl.classList.remove('skeleton-content');
}

function updateAvatar(avatarEl, profile) {
	if (!avatarEl || !profile) return;
	avatarEl.innerHTML = renderProfileAvatar(profile);
	avatarEl.classList.remove('skeleton');

	const colors = [
		'#FF6B6B',
		'#4ECDC4',
		'#45B7D1',
		'#96CEB4',
		'#FFEEAD',
		'#D4A5A5',
		'#9B59B6',
		'#3498DB',
	];
	const colorIndex = (profile.username || 'U').charCodeAt(0) % colors.length;
	avatarEl.style.background = `linear-gradient(135deg, ${colors[colorIndex]}, ${colors[(colorIndex + 1) % colors.length]})`;
}

async function renderProfileData(fetchRef, userID, contentEl, avatarEl) {
	const profile = await loadProfile(fetchRef, userID);

	if (!profile) {
		if (contentEl) {
			contentEl.innerHTML = `
				<div class="profile-error">
					<h3>User not found</h3>
					<p>The profile you are looking for does not exist or has been removed.</p>
					<button class="auth-button" type="button" data-action="back">Go Back</button>
				</div>
			`;
			contentEl.classList.remove('skeleton-content');
		}
		if (avatarEl) avatarEl.classList.remove('skeleton');
		return;
	}

	fillProfileFields(contentEl, profile);
	updateAvatar(avatarEl, profile);
}

export function initProfilePage(options = {}) {
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

	const root = documentRef.querySelector('[data-screen="profile"]');
	if (!root) {
		return null;
	}

	if (root.getAttribute(PROFILE_BOUND_ATTR) === 'true') {
		return null;
	}

	root.setAttribute(PROFILE_BOUND_ATTR, 'true');

	root.addEventListener('click', (event) => {
		const backButton = event.target?.closest?.('[data-action="back"]');
		if (backButton) {
			event.preventDefault();
			windowRef.history?.back?.();
		}
	});

	const userID = root.getAttribute('data-user-id');
	const contentEl = root.querySelector('#profile-content');
	const avatarEl = root.querySelector('.profile-avatar');

	if (!userID || !contentEl) {
		return null;
	}

	void renderProfileData(fetchRef, userID, contentEl, avatarEl);

	return { root };
}
