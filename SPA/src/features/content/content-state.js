import { reactive, readonly, watch } from 'vue';

import * as contentApi from '../../api/content.js';

export const contentKey = Symbol('commonplace-content');

// Shared publishing writes for the composer, owner editor and (A13) activity
// views. Like the social state it keeps no copy of server content: each write
// is guarded against duplicate submission, ignored once the session changes,
// and followed by a refetch of the mounted views so they converge on what the
// server reports. Uncertain writes are never replayed automatically.
export function createContentState({ api = contentApi, session, social } = {}) {
	const state = reactive({ pending: {}, flash: null });
	let revision = 0;

	function reset() {
		revision += 1;
		state.pending = {};
		state.flash = null;
	}

	if (session) {
		watch(() => session.state.account?.id ?? null, reset, { flush: 'sync' });
	}

	async function run(key, request) {
		if (state.pending[key]) return { status: 'busy' };
		const startedAt = revision;
		state.pending[key] = true;
		try {
			const result = await request();
			if (revision !== startedAt) return { status: 'superseded' };
			if (result.status === 'unauthenticated') {
				await social.handleUnauthenticated();
				return result;
			}
			await social.refresh();
			return revision === startedAt ? result : { status: 'superseded' };
		} finally {
			if (revision === startedAt) delete state.pending[key];
		}
	}

	function isPending(key) {
		return Boolean(state.pending[key]);
	}

	// A one-shot notice for the screen a navigation is heading to (for example
	// "Post published" on the feed). Only that route can read it, so a view
	// briefly remounted during the navigation cannot consume it.
	function setFlash(route, message) {
		state.flash = { route, message };
	}

	function takeFlash(route) {
		if (state.flash?.route !== route) return '';
		const { message } = state.flash;
		state.flash = null;
		return message;
	}

	return {
		state: readonly(state),
		api,
		isPending,
		setFlash,
		takeFlash,
		reset,
		createComment: (id, fields) => run(`thread-${id}`, () => api.createComment(id, fields)),
		updateComment: (id, fields) => run(`comment-${id}`, () => api.updateComment(id, fields)),
		deleteComment: (id, version) => run(`comment-${id}`, () => api.deleteComment(id, version)),
		react: (kind, id, reaction) =>
			run(`${kind}-${id}`, () => api.reactToContent(kind, id, reaction)),
		createPost: (fields) => run('new', () => api.createPost(fields)),
		createDraft: (fields) => run('new', () => api.createDraft(fields)),
		updatePost: (id, fields) => run(id, () => api.updatePost(id, fields)),
		updateDraft: (id, fields) => run(id, () => api.updateDraft(id, fields)),
		deletePost: (id, version) => run(id, () => api.deletePost(id, version)),
		deleteDraft: (id, version) => run(id, () => api.deleteDraft(id, version)),
	};
}
