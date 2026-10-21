// @vitest-environment jsdom
// SN-A16: the pure form and route helpers behind group content.
import { beforeAll, describe, expect, test, vi } from 'vitest';

import {
	AUDIENCE_LABELS,
	discussionQuery,
	fieldMessage,
	readGroupScope,
} from '../../../../../src/features/content/content-utils.js';
import {
	applyFailure,
	changeFields,
	createFields,
	createPostForm,
	rebaseForm,
	seedForm,
	validateForm,
} from '../../../../../src/features/content/post-form.js';
import { groupSections } from '../../../../../src/features/groups/use-group.js';

beforeAll(() => {
	URL.createObjectURL = vi.fn(() => 'blob:preview');
	URL.revokeObjectURL = vi.fn();
});

const GROUP = { id: 301, title: 'Chess Club' };
function groupPost(overrides = {}) {
	return {
		id: 111,
		author_id: 7,
		author: 'Ada Lovelace',
		title: null,
		body: 'Group hello',
		image_url: '/api/v1/media/411',
		status: 'published',
		audience: 'group',
		group: GROUP,
		version: 1,
		categories: [{ id: 1, name: 'General' }],
		created_at: 'x',
		updated_at: 'x',
		likes: 0,
		dislikes: 0,
		my_reaction: 0,
		...overrides,
	};
}

describe('group content form', () => {
	test('a new group post sends the group and never an audience, even if one was left on the form', () => {
		const form = createPostForm();
		form.body = 'Hi';
		form.audience = 'selected';
		form.selectedIds = [10];
		expect(createFields(form, { groupId: 301 })).toEqual({ body: 'Hi', groupId: 301 });
		// A personal post is unchanged.
		expect(createFields(form)).toEqual({
			body: 'Hi',
			audience: 'selected',
			selectedFollowerIds: [10],
		});
	});

	test('seeding from a group post keeps the neutral default and no recipients', () => {
		const form = createPostForm();
		seedForm(form, groupPost());
		expect(form.audience).toBe('public');
		expect(form.selectedIds).toEqual([]);
		expect(form.body).toBe('Group hello');
		seedForm(form, { ...groupPost(), audience: 'group', selected_follower_ids: [1, 2] });
		expect(form.selectedIds).toEqual([]);
	});

	test('an edit of a group post sends only text, categories and the attachment', () => {
		const base = groupPost();
		const form = createPostForm();
		seedForm(form, base);
		expect(changeFields(form, base)).toEqual({});
		form.body = 'Edited';
		form.categoryIds = [];
		form.removeImage = true;
		form.audience = 'followers';
		form.selectedIds = [10];
		expect(changeFields(form, base)).toEqual({
			body: 'Edited',
			categoryIds: [],
			removeImage: true,
		});
	});

	test('validation ignores recipients for group content only', () => {
		const form = createPostForm();
		form.body = 'x';
		form.audience = 'selected';
		expect(validateForm(form, { publishing: true, eligibleIds: [] })).toBe(false);
		expect(form.errors.selected_follower_ids).toBeDefined();
		expect(validateForm(form, { publishing: true, eligibleIds: [], group: true })).toBe(true);
	});

	test('rebasing a group post keeps the author’s edits and invents no recipients', () => {
		const base = groupPost();
		const form = createPostForm();
		seedForm(form, base);
		form.body = 'Mine';
		const latest = groupPost({ title: 'Renamed', version: 2 });
		rebaseForm(form, base, latest);
		expect(form.body).toBe('Mine');
		expect(form.title).toBe('Renamed');
		expect(form.audience).toBe('public');
		expect(form.selectedIds).toEqual([]);
	});

	test('scope and immutability rejections have plain explanations', () => {
		expect(fieldMessage('audience', 'GROUP_SCOPE')).toContain('membership');
		expect(fieldMessage('group_id', 'IMMUTABLE')).toContain('can’t move');
		const form = createPostForm();
		applyFailure(form, { status: 'rejected', fields: { audience: 'GROUP_SCOPE' } });
		expect(form.errors.audience).toContain('membership');
		expect(AUDIENCE_LABELS.group).toBe('Group members');
	});
});

describe('group routes and sections', () => {
	test('only members see Posts, Events and Chat; the creator also sees join requests', () => {
		expect(groupSections('none').map((section) => section.name)).toEqual(['group']);
		expect(groupSections('member').map((section) => section.name)).toEqual([
			'group',
			'group-posts',
			'group-events',
			'group-chat',
			'group-members',
		]);
		expect(groupSections('creator').map((section) => section.name)).toEqual([
			'group',
			'group-posts',
			'group-events',
			'group-chat',
			'group-members',
			'group-requests',
		]);
	});

	test('a group scope is read only from a single positive decimal', () => {
		expect(readGroupScope({ group: '301' })).toBe(301);
		expect(readGroupScope({ group: ['301', '2'] })).toBe(301);
		for (const bad of ['0', '-1', 'abc', '301abc', '1.5', '', undefined])
			expect(readGroupScope({ group: bad })).toBeNull();
	});

	test('a discussion link carries the filters, and the group only for a post that belongs to it', () => {
		const post = groupPost();
		const feedRoute = {
			name: 'feed',
			query: { feed: 'following', category: '1', page: '3', x: '1' },
		};
		expect(discussionQuery(feedRoute, post)).toEqual({ feed: 'following', category: '1' });
		const groupRoute = { name: 'group-posts', params: { id: '301' }, query: { category: '1' } };
		expect(discussionQuery(groupRoute, post)).toEqual({ category: '1', group: '301' });
		// A group post opened from another group's list does not claim that scope.
		expect(discussionQuery({ ...groupRoute, params: { id: '302' } }, post)).toEqual({
			category: '1',
		});
		expect(discussionQuery({ name: 'my-posts', query: {} }, post)).toEqual({});
		const again = { name: 'post', params: { id: '111' }, query: { group: '301' } };
		expect(discussionQuery(again, post)).toEqual({ group: '301' });
		expect(discussionQuery(again, groupPost({ group: { id: 302, title: 'Other' } }))).toEqual({});
	});
});
