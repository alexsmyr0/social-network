const CURRENT_ACCOUNT_PATH = '/api/v1/users/me';
const LOGIN_PATH = '/api/v1/users/login';

async function readPayload(response) {
	return response.json().catch(() => null);
}

// Resolves the session behind the current cookie. Only a 401 means signed out;
// a 5xx, network failure or malformed body is "unavailable", never a logout.
export async function fetchCurrentAccount(fetchRef = globalThis.fetch) {
	let response;
	try {
		response = await fetchRef(CURRENT_ACCOUNT_PATH, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			credentials: 'include',
		});
	} catch {
		return { status: 'unavailable' };
	}

	if (response.status === 401) return { status: 'unauthenticated' };
	const payload = await readPayload(response);
	if (!response.ok || !payload?.data) return { status: 'unavailable' };
	return { status: 'authenticated', account: payload.data };
}

// Signs in with an email/password pair. Only the contract's 401
// INVALID_CREDENTIALS proves the credentials were rejected; anything else that
// is not a successful account response is "unavailable".
export async function loginAccount({ email, password }, fetchRef = globalThis.fetch) {
	let response;
	try {
		response = await fetchRef(LOGIN_PATH, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
			},
			credentials: 'include',
			body: JSON.stringify({ email: email.trim(), password }),
		});
	} catch {
		return { status: 'unavailable' };
	}

	const payload = await readPayload(response);
	if (response.status === 401 && payload?.error?.code === 'INVALID_CREDENTIALS') {
		return { status: 'invalid-credentials' };
	}
	if (!response.ok || !payload?.data) return { status: 'unavailable' };
	return { status: 'authenticated', account: payload.data };
}

export { CURRENT_ACCOUNT_PATH, LOGIN_PATH };
