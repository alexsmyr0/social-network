import { describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';

import { createAppRouter } from '../../../../../src/app/router.js';
import { createSessionState } from '../../../../../src/features/auth/session-state.js';
import {
	countLabel,
	formatBirthDate,
	initialsOf,
	parsePage,
	parseUserId,
	readSearchQuery,
	validateSearch,
} from '../../../../../src/features/social/social-utils.js';

describe('social routes', () => {
	test.each([
		['/people', 'people'],
		['/people?q=alex&page=2', 'people'],
		['/users/42', 'profile'],
		['/users/42/followers', 'followers'],
		['/users/42/following', 'following'],
	])('resolves %s', async (path, name) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);
		expect(router.currentRoute.value.name).toBe(name);
		expect(router.currentRoute.value.meta.requiresAuth).toBe(true);
	});

	test.each([
		'/users/0',
		'/users/007',
		'/users/abc',
		'/users/-3',
		'/users/4/friends',
		'/users',
	])('does not treat %s as a profile', async (path) => {
		const router = createAppRouter(createMemoryHistory());
		await router.push(path);
		expect(router.currentRoute.value.name).toBe('not-found');
	});

	test('passes the list kind as a prop', async () => {
		const router = createAppRouter(createMemoryHistory());
		await router.push('/users/9/following');
		expect(router.currentRoute.value.matched[0].props.default).toEqual({ kind: 'following' });
	});

	test.each([
		'/people',
		'/users/42',
		'/users/42/followers',
	])('sends an unauthenticated visitor from %s to sign in and remembers the deep link', async (path) => {
		const session = createSessionState({
			fetchCurrent: async () => ({ status: 'unauthenticated' }),
		});
		const router = createAppRouter(createMemoryHistory(), session);
		await router.push(path);
		expect(router.currentRoute.value.name).toBe('login');
		expect(router.currentRoute.value.query.redirect).toBe(path);
	});

	test('returns to a remembered profile after sign in', async () => {
		const states = [{ status: 'unauthenticated' }];
		const session = createSessionState({
			fetchCurrent: async () => states[0],
			login: async () => ({ status: 'authenticated', account: { id: 7 } }),
		});
		const router = createAppRouter(createMemoryHistory(), session);
		await router.push('/users/42');
		expect(router.currentRoute.value.query.redirect).toBe('/users/42');
		states[0] = { status: 'authenticated', account: { id: 7, display_name: 'Ada' } };
		await session.signIn({ email: 'a@b.co', password: 'x' });
		await router.push(router.currentRoute.value.query.redirect);
		expect(router.currentRoute.value.name).toBe('profile');
	});
});

describe('social utilities', () => {
	test('parseUserId accepts only canonical IDs inside the exact-integer range', () => {
		expect(parseUserId('42')).toBe(42);
		expect(parseUserId('9007199254740991')).toBe(9007199254740991);
		for (const bad of [
			'0',
			'007',
			'-1',
			'1.5',
			'1e3',
			' 4',
			'4 ',
			'abc',
			'',
			'9007199254740993',
			undefined,
			42,
		]) {
			expect(parseUserId(bad)).toBeNull();
		}
	});

	test('parsePage falls back to the first page for anything out of range', () => {
		expect(parsePage('3')).toBe(3);
		expect(parsePage(['4', '5'])).toBe(4);
		expect(parsePage('1000000')).toBe(1000000);
		for (const bad of ['0', '-2', '1000001', 'x', '2.5', '', undefined, null, ['x']]) {
			expect(parsePage(bad)).toBe(1);
		}
	});

	test('readSearchQuery reads the first repeated parameter and ignores non-text', () => {
		expect(readSearchQuery('abc')).toBe('abc');
		expect(readSearchQuery(['a', 'b'])).toBe('a');
		expect(readSearchQuery(undefined)).toBe('');
		expect(readSearchQuery(null)).toBe('');
	});

	test('validateSearch trims, counts code points and refuses control characters', () => {
		expect(validateSearch('  Alex  ')).toEqual({ value: 'Alex', error: '' });
		expect(validateSearch('').error).toBe('');
		expect(validateSearch('😀'.repeat(100)).error).toBe('');
		expect(validateSearch('😀'.repeat(101)).error).toContain('100 characters');
		expect(validateSearch('a\tb').error).toContain('control characters');
		expect(validateSearch('a\u0000').error).toContain('control characters');
	});

	test('initialsOf handles empty, single, multi-word and non-Latin names', () => {
		expect(initialsOf('')).toBe('?');
		expect(initialsOf('   ')).toBe('?');
		expect(initialsOf('robin')).toBe('R');
		expect(initialsOf('Ada Lovelace')).toBe('AL');
		expect(initialsOf('Mary Jane Watson')).toBe('MW');
		expect(initialsOf('élodie Dupont')).toBe('ÉD');
		expect(initialsOf('😀 Smile')).toBe('😀S');
	});

	test('formatBirthDate formats valid dates and leaves anything else readable', () => {
		expect(formatBirthDate('1998-03-14')).toBe('14 March 1998');
		expect(formatBirthDate('2000-02-29')).toBe('29 February 2000');
		expect(formatBirthDate('not a date')).toBe('not a date');
		expect(formatBirthDate('2000-13-45')).toBe('2000-13-45');
		expect(formatBirthDate(null)).toBe('');
		expect(formatBirthDate(undefined)).toBe('');
	});

	test('countLabel pluralises', () => {
		expect(countLabel(1, 'follower')).toBe('1 follower');
		expect(countLabel(0, 'follower')).toBe('0 followers');
		expect(countLabel(2, 'person', 'people')).toBe('2 people');
	});
});
