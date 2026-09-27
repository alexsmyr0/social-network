import { reactive, readonly } from 'vue';

import { fetchCurrentAccount, loginAccount, logoutAccount } from '../../api/session.js';

export const sessionKey = Symbol('commonplace-session');

export function createSessionState({
	fetchCurrent = fetchCurrentAccount,
	login = loginAccount,
	logout = logoutAccount,
	onLogout = () => {},
} = {}) {
	const state = reactive({
		status: 'checking',
		account: null,
		logoutPending: false,
		logoutError: '',
	});
	const retainedResources = new Set();
	let restoration = null;
	let revision = 0;

	function closeRetainedResources() {
		for (const release of retainedResources) {
			try {
				release();
			} catch {
				// A broken cleanup must not preserve the rest of the user's state.
			}
		}
		retainedResources.clear();
	}

	function clearAuthenticatedState() {
		revision += 1;
		state.account = null;
		state.status = 'unauthenticated';
		closeRetainedResources();
	}

	function acceptAccount(account) {
		revision += 1;
		state.account = account;
		state.status = 'authenticated';
		state.logoutError = '';
	}

	async function restore({ force = false } = {}) {
		if (!force && state.status !== 'checking' && state.status !== 'unavailable')
			return state.status;
		if (restoration) return restoration;
		state.status = 'checking';
		const startedAt = revision;
		restoration = fetchCurrent()
			.then((result) => {
				if (revision !== startedAt) return state.status;
				if (result.status === 'authenticated') acceptAccount(result.account);
				else if (result.status === 'unauthenticated') clearAuthenticatedState();
				else state.status = 'unavailable';
				return state.status;
			})
			.finally(() => {
				restoration = null;
			});
		return restoration;
	}

	async function signIn(credentials) {
		const result = await login(credentials);
		if (result.status === 'authenticated') acceptAccount(result.account);
		else if (result.status === 'invalid-credentials' && !state.account) {
			state.status = 'unauthenticated';
		}
		return result;
	}

	async function signOut() {
		if (state.logoutPending) return { status: 'pending' };
		state.logoutPending = true;
		state.logoutError = '';
		try {
			const result = await logout();
			if (result.status === 'logged-out') {
				clearAuthenticatedState();
				onLogout();
			} else
				state.logoutError =
					'We couldn’t confirm sign out. You are still shown as signed in; try again.';
			return result;
		} finally {
			state.logoutPending = false;
		}
	}

	function retainResource(release) {
		retainedResources.add(release);
		return () => retainedResources.delete(release);
	}

	return {
		state: readonly(state),
		acceptAccount,
		clearAuthenticatedState,
		restore,
		signIn,
		signOut,
		retainResource,
	};
}
