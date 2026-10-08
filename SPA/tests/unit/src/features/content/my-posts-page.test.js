// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ContentBackend } from '../../../../fixtures/phase3/content-backend.js';
import { cleanupMounted, contentCalls, mountContentApp, settle, textOf } from './harness.js';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

function model() {
	const backend = new ContentBackend();
	backend.addPost({
		id: 102,
		title: 'Half done',
		status: 'draft',
		created_at: '2026-10-06T12:02:00Z',
	});
	backend.addPost({
		id: 103,
		title: 'Old news',
		status: 'archived',
		created_at: '2026-10-06T12:03:00Z',
	});
	backend.addPost({
		id: 104,
		author_id: 7,
		body: 'Ada’s post',
		created_at: '2026-10-06T12:04:00Z',
	});
	return backend;
}

const ids = (wrapper) =>
	wrapper.findAll('[data-post-id]').map((card) => Number(card.attributes('data-post-id')));

describe('SN-A12 your posts', () => {
	test('lists only the owner’s posts with statuses, and filters drafts', async () => {
		const app = await mountContentApp('/posts/mine', { backend: model() });
		expect(ids(app.wrapper)).toEqual([103, 102, 101]);
		expect(app.wrapper.get('[data-post-id="103"] [data-status]').text()).toBe('Archived');
		expect(app.wrapper.get('[data-post-id="102"] .post-card__edit').text()).toBe('Continue draft');
		// Published posts carry no status badge.
		expect(app.wrapper.find('[data-post-id="101"] [data-status]').exists()).toBe(false);

		await app.wrapper.get('.segmented a[href="/posts/mine?status=draft"]').trigger('click');
		await settle();
		expect(ids(app.wrapper)).toEqual([102]);
		expect(textOf(app.wrapper)).toContain('1 draft');
		expect(contentCalls(app.fetchRef).at(-1).url).toBe('/api/v1/posts/mine?status=draft');
		await app.wrapper.get('[data-post-id="102"] .post-card__edit').trigger('click');
		await settle();
		expect(app.router.currentRoute.value.fullPath).toBe('/posts/102/edit');
		expect(app.wrapper.get('#edit-title').element.value).toBe('Half done');
	});

	test('another author never sees someone else’s drafts or archive', async () => {
		const app = await mountContentApp('/posts/mine?status=draft', {
			backend: model(),
			viewerId: 7,
		});
		expect(ids(app.wrapper)).toEqual([]);
		expect(textOf(app.wrapper)).toContain('No drafts saved.');
		await app.router.push('/posts/mine');
		await settle();
		expect(ids(app.wrapper)).toEqual([104]);
	});
});
