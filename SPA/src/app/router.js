import { createRouter, createWebHistory } from 'vue-router';

import LoginPage from '../features/auth/LoginPage.vue';
import RegisterPage from '../features/auth/RegisterPage.vue';
import NotFoundPage from '../features/migration/NotFoundPage.vue';
import HomePage from '../features/shell/HomePage.vue';

export const routes = [
	{
		path: '/',
		name: 'home',
		component: HomePage,
		meta: { title: 'Home' },
	},
	{
		path: '/login',
		name: 'login',
		component: LoginPage,
		meta: { title: 'Sign in' },
	},
	{
		path: '/register',
		name: 'register',
		component: RegisterPage,
		meta: { title: 'Create account' },
	},
	{
		path: '/:pathMatch(.*)*',
		name: 'not-found',
		component: NotFoundPage,
		meta: { title: 'Route unavailable' },
	},
];

export function createAppRouter(history = createWebHistory()) {
	const router = createRouter({
		history,
		routes,
		scrollBehavior: () => ({ top: 0 }),
	});

	router.afterEach((to) => {
		if (typeof document !== 'undefined') {
			document.title = `${to.meta.title} · Commonplace`;
		}
	});

	return router;
}
