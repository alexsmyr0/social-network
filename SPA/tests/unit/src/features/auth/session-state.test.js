import { describe, expect, test, vi } from 'vitest';

import { createSessionState } from '../../../../../src/features/auth/session-state.js';

const account = { id: 42, display_name: 'Alex Example' };

describe('SN-A05 session state', () => {
	test('restores and deduplicates the startup session lookup', async () => {
		let finish;
		const fetchCurrent = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const session = createSessionState({ fetchCurrent });
		const first = session.restore();
		const second = session.restore();
		expect(fetchCurrent).toHaveBeenCalledTimes(1);
		finish({ status: 'authenticated', account });
		await Promise.all([first, second]);

		expect(session.state.status).toBe('authenticated');
		expect(session.state.account).toEqual(account);
	});

	test('distinguishes an unavailable lookup from an unauthenticated response', async () => {
		const fetchCurrent = vi
			.fn()
			.mockResolvedValueOnce({ status: 'unavailable' })
			.mockResolvedValueOnce({ status: 'unauthenticated' });
		const session = createSessionState({ fetchCurrent });
		await session.restore();
		expect(session.state.status).toBe('unavailable');
		await session.restore({ force: true });
		expect(session.state.status).toBe('unauthenticated');
	});

	test('keeps account and resources on failed logout, then clears both on success', async () => {
		const releaseSocket = vi.fn();
		const logout = vi
			.fn()
			.mockResolvedValueOnce({ status: 'unavailable' })
			.mockResolvedValueOnce({ status: 'logged-out' });
		const session = createSessionState({ logout });
		session.acceptAccount(account);
		session.retainResource(releaseSocket);

		await expect(session.signOut()).resolves.toEqual({ status: 'unavailable' });
		expect(session.state.status).toBe('authenticated');
		expect(session.state.account).toEqual(account);
		expect(session.state.logoutError).toContain('still shown as signed in');
		expect(releaseSocket).not.toHaveBeenCalled();

		await expect(session.signOut()).resolves.toEqual({ status: 'logged-out' });
		expect(session.state.status).toBe('unauthenticated');
		expect(session.state.account).toBeNull();
		expect(session.state.logoutError).toBe('');
		expect(releaseSocket).toHaveBeenCalledTimes(1);
	});

	test('prevents duplicate logout requests while one is pending', async () => {
		let finish;
		const logout = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const session = createSessionState({ logout });
		session.acceptAccount(account);
		const first = session.signOut();
		await expect(session.signOut()).resolves.toEqual({ status: 'pending' });
		expect(logout).toHaveBeenCalledTimes(1);
		finish({ status: 'logged-out' });
		await first;
	});

	test('does not disturb an existing session when another login is rejected', async () => {
		const releaseSocket = vi.fn();
		const session = createSessionState({
			login: vi.fn(async () => ({ status: 'invalid-credentials' })),
		});
		session.acceptAccount(account);
		session.retainResource(releaseSocket);

		await expect(
			session.signIn({ email: 'someone@example.com', password: 'wrong password' }),
		).resolves.toEqual({ status: 'invalid-credentials' });
		expect(session.state.status).toBe('authenticated');
		expect(session.state.account).toEqual(account);
		expect(releaseSocket).not.toHaveBeenCalled();
	});
});
