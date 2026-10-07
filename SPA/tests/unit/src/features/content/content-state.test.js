// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import { reactive } from 'vue';

import { createContentState } from '../../../../../src/features/content/content-state.js';
import { deferred } from './harness.js';

function setup(api) {
	const session = { state: reactive({ account: { id: 42 }, status: 'authenticated' }) };
	const social = { refresh: vi.fn(async () => {}), handleUnauthenticated: vi.fn(async () => {}) };
	return { session, social, content: createContentState({ api, session, social }) };
}

describe('shared content writes', () => {
	test('a second submission while one is in flight sends nothing', async () => {
		const gate = deferred();
		const api = { createPost: vi.fn(() => gate.promise) };
		const { content, social } = setup(api);
		const first = content.createPost({ body: 'Hi' });
		expect(content.isPending('new')).toBe(true);
		expect(await content.createPost({ body: 'Hi' })).toEqual({ status: 'busy' });
		gate.release({ status: 'ok', post: { id: 1 } });
		expect((await first).status).toBe('ok');
		expect(api.createPost).toHaveBeenCalledTimes(1);
		expect(social.refresh).toHaveBeenCalledTimes(1);
		expect(content.isPending('new')).toBe(false);
	});

	test('different posts are guarded independently', async () => {
		const gate = deferred();
		const api = { updatePost: vi.fn(() => gate.promise) };
		const { content } = setup(api);
		const one = content.updatePost(1, {});
		const two = content.updatePost(2, {});
		gate.release({ status: 'ok' });
		await Promise.all([one, two]);
		expect(api.updatePost).toHaveBeenCalledTimes(2);
	});

	test('an account change supersedes an in-flight write and its refresh', async () => {
		const gate = deferred();
		const api = { deletePost: vi.fn(() => gate.promise) };
		const { content, session, social } = setup(api);
		const pending = content.deletePost(1, 1);
		session.state.account = { id: 7 };
		expect(content.isPending(1)).toBe(false);
		gate.release({ status: 'ok' });
		expect(await pending).toEqual({ status: 'superseded' });
		expect(social.refresh).not.toHaveBeenCalled();
	});

	test('401 is confirmed through the shared session handler without a refresh', async () => {
		const api = { updateDraft: vi.fn(async () => ({ status: 'unauthenticated' })) };
		const { content, social } = setup(api);
		expect((await content.updateDraft(5, {})).status).toBe('unauthenticated');
		expect(social.handleUnauthenticated).toHaveBeenCalledTimes(1);
		expect(social.refresh).not.toHaveBeenCalled();
	});

	test('uncertain outcomes refetch views and are never replayed', async () => {
		const api = { createDraft: vi.fn(async () => ({ status: 'unavailable' })) };
		const { content, social } = setup(api);
		expect((await content.createDraft({})).status).toBe('unavailable');
		expect(api.createDraft).toHaveBeenCalledTimes(1);
		expect(social.refresh).toHaveBeenCalledTimes(1);
	});

	test('a flash notice is read once, only by its destination, and cleared by session changes', () => {
		const { content, session } = setup({});
		content.setFlash('feed', 'Saved');
		expect(content.takeFlash('edit-post')).toBe('');
		expect(content.takeFlash('feed')).toBe('Saved');
		expect(content.takeFlash('feed')).toBe('');
		content.setFlash('feed', 'Saved');
		session.state.account = null;
		expect(content.takeFlash('feed')).toBe('');
	});
});
