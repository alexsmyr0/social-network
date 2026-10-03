import { createRouter, createWebHistory } from 'vue-router';

import LoginPage from '../features/auth/LoginPage.vue';
import RegisterPage from '../features/auth/RegisterPage.vue';
import { safeReturnPath } from '../features/auth/return-path.js';
import NotFoundPage from '../features/migration/NotFoundPage.vue';
import HomePage from '../features/shell/HomePage.vue';
import FollowListPage from '../features/social/FollowListPage.vue';
import PeoplePage from '../features/social/PeoplePage.vue';
import ProfilePage from '../features/social/ProfilePage.vue';

export const routes = [
	{
		path: '/',
		name: 'home',
		component: HomePage,
		meta: { title: 'Home', requiresAuth: true },
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

	router.afterEach((to) => {
		if (typeof document !== 'undefined') {
			document.title = `${to.meta.title} · Commonplace`;
		}
	});

	return router;
}
