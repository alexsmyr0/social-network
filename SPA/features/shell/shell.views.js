// SPA/features/shell/shell.views.js

import { renderNotificationBell } from '../notification/notification.views.js';

function renderAppNavigation() {
	return `
		<nav aria-label="Forum navigation">
			<a data-link href="/">Feed</a>
			<span aria-hidden="true"> | </span>
			<a data-link href="/create-post">Create Post</a>
			<span aria-hidden="true"> | </span>
			<a data-link href="/activity">Activity</a>
		</nav>
	`;
}

export function renderAuthenticatedShell(content) {
	return `
		<div class="app-shell" data-auth-shell>
			<header class="app-shell__header" aria-label="Forum header">
				<div class="app-shell__brand">
					<span class="app-shell__brand-mark">F</span>orum
				</div>
				${renderAppNavigation()}
				<div class="app-shell__actions">
					${renderNotificationBell()}
					<button class="app-shell__logout" type="button" data-action="logout">Logout</button>
				</div>
			</header>
			<div class="app-shell__layout">
				<main class="app-shell__outlet" aria-label="Page content">
					${content}
				</main>
				<aside class="app-shell__chat" aria-label="Direct messages">
					<section class="chat-panel" data-chat-roster>
						<h2 class="chat-panel__title chat-panel__title--spaced">
							<span>Chat</span>
							<span class="chat-panel__unread-slot" data-roster-unread-slot></span>
						</h2>
						<div id="roster-list" class="chat-panel__roster">
							<p class="chat-panel__empty">No active chats</p>
						</div>
					</section>
					<section class="chat-panel chat-panel--conversation" data-chat-active hidden>
						<p class="chat-panel__active-empty">Select a chat to open the conversation.</p>
					</section>
				</aside>
			</div>
		</div>
	`;
}
