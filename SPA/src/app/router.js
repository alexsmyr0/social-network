import { createRouter, createWebHistory } from 'vue-router';

import LoginPage from '../features/auth/LoginPage.vue';
import RegisterPage from '../features/auth/RegisterPage.vue';
import { safeReturnPath } from '../features/auth/return-path.js';
import ActivityPage from '../features/content/ActivityPage.vue';
import ComposePage from '../features/content/ComposePage.vue';
import { feedQuery, readFeedQuery, sameQuery } from '../features/content/content-utils.js';
import DiscussionPage from '../features/content/DiscussionPage.vue';
import EditPostPage from '../features/content/EditPostPage.vue';
import FeedPage from '../features/content/FeedPage.vue';
import MyPostsPage from '../features/content/MyPostsPage.vue';
import GroupCreatePage from '../features/groups/GroupCreatePage.vue';
import GroupPage from '../features/groups/GroupPage.vue';
import GroupsPage from '../features/groups/GroupsPage.vue';
import { groupsQuery, readGroupsQuery } from '../features/groups/group-utils.js';
import NotFoundPage from '../features/migration/NotFoundPage.vue';
import HomePage from '../features/shell/HomePage.vue';
import FollowListPage from '../features/social/FollowListPage.vue';
import PeoplePage from '../features/social/PeoplePage.vue';
import ProfilePage from '../features/social/ProfilePage.vue';

export const routes = [
	{
		path: '/posts/:id([1-9]\\d*)',
		name: 'post',
		component: DiscussionPage,
		meta: { title: 'Discussion', requiresAuth: true },
	},
	{
		path: '/comments/:id([1-9]\\d*)',
		name: 'comment',
		component: DiscussionPage,
		meta: { title: 'Comment', requiresAuth: true },
	},
	{
		path: '/activity',
		name: 'activity',
		component: ActivityPage,
		meta: { title: 'Your activity', requiresAuth: true },
	},
	{
		path: '/',
		name: 'home',
		component: HomePage,
		meta: { title: 'Home', requiresAuth: true },
	},
	{
		path: '/feed',
		name: 'feed',
		component: FeedPage,
		meta: { title: 'Feed', requiresAuth: true },
	},
	{
		path: '/posts/new',
		name: 'compose',
		component: ComposePage,
		meta: { title: 'New post', requiresAuth: true },
	},
	{
		path: '/posts/mine',
		name: 'my-posts',
		component: MyPostsPage,
		meta: { title: 'Your posts', requiresAuth: true },
	},
	{
		path: '/posts/:id([1-9]\\d*)/edit',
		name: 'edit-post',
		component: EditPostPage,
		meta: { title: 'Edit post', requiresAuth: true },
	},
	{
		path: '/groups',
		name: 'groups',
		component: GroupsPage,
		meta: { title: 'Groups', requiresAuth: true },
	},
	{
		path: '/groups/new',
		name: 'group-new',
		component: GroupCreatePage,
		meta: { title: 'New group', requiresAuth: true },
	},
	{
		path: '/groups/:id([1-9]\\d*)',
		name: 'group',
		component: GroupPage,
		props: { section: 'about' },
		meta: { title: 'Group', requiresAuth: true },
	},
	{
		path: '/groups/:id([1-9]\\d*)/members',
		name: 'group-members',
		component: GroupPage,
		props: { section: 'members' },
		meta: { title: 'Group members', requiresAuth: true },
	},
	{
		path: '/groups/:id([1-9]\\d*)/requests',
		name: 'group-requests',
		component: GroupPage,
		props: { section: 'requests' },
		meta: { title: 'Join requests', requiresAuth: true },
	},
	{
		path: '/people',
		name: 'people',
		component: PeoplePage,
		meta: { title: 'People', requiresAuth: true },
	},
	{
		path: '/users/:id([1-9]\\d*)',
		name: 'profile',
		component: ProfilePage,
		meta: { title: 'Profile', requiresAuth: true },
	},
	{
		path: '/users/:id([1-9]\\d*)/followers',
		name: 'followers',
		component: FollowListPage,
		props: { kind: 'followers' },
		meta: { title: 'Followers', requiresAuth: true },
	},
	{
		path: '/users/:id([1-9]\\d*)/following',
		name: 'following',
		component: FollowListPage,
		props: { kind: 'following' },
		meta: { title: 'Following', requiresAuth: true },
	},
	{
		path: '/login',
		name: 'login',
		component: LoginPage,
		meta: { title: 'Sign in', publicOnly: true },
	},
	{
		path: '/register',
		name: 'register',
		component: RegisterPage,
		meta: { title: 'Create account', publicOnly: true },
	},
	{
		path: '/:pathMatch(.*)*',
		name: 'not-found',
		component: NotFoundPage,
		meta: { title: 'Route unavailable' },
	},
];

export function createAppRouter(history = createWebHistory(), session) {
	const router = createRouter({
		history,
		routes,
		scrollBehavior: () => ({ top: 0 }),
	});

	if (session) {
		router.beforeEach(async (to) => {
			// Recheck a cached account before route changes. Another tab may have
			// revoked the shared cookie since the previous lookup.
			await session.restore({ force: session.state.status === 'authenticated' });
			const status = session.state.status;
			if (to.meta.publicOnly && status === 'authenticated') {
				return safeReturnPath(to.query.redirect);
			}
			if (to.meta.requiresAuth && status === 'unauthenticated') {
				return { name: 'login', query: { redirect: to.fullPath } };
			}
			return true;
		});
	}

	// Malformed, repeated or unknown feed and group filters recover to the nearest valid
	// route state, so a shared or hand-edited link always lands on a working
	// view. Runs before views mount, so they never redirect themselves.
	router.beforeEach((to) => {
		if (to.name !== 'feed' && to.name !== 'groups') return true;
		const canonical =
			to.name === 'feed'
				? feedQuery(readFeedQuery(to.query))
				: groupsQuery(readGroupsQuery(to.query));
		return sameQuery(to.query, canonical)
			? true
			: { name: to.name, query: canonical, replace: true };
	});

	router.afterEach((to) => {
		if (typeof document !== 'undefined') {
			document.title = `${to.meta.title} · Commonplace`;
		}
	});

	return router;
}
