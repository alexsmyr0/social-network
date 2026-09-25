const HEALTH_PATH = '/api/v1/health';

export async function checkBackendHealth(fetchRef = globalThis.fetch) {
	try {
		const response = await fetchRef(HEALTH_PATH, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			credentials: 'include',
		});

		const payload = await response.json().catch(() => null);
		if (!response.ok || payload?.data?.status !== 'ok') {
			return {
				ok: false,
				status: response.status,
				message: 'The service is not responding normally.',
			};
		}

		return {
			ok: true,
			status: response.status,
			message: 'Backend connected',
		};
	} catch {
		return {
			ok: false,
			status: 0,
			message: 'Connection interrupted. Check the backend and try again.',
		};
	}
}

export { HEALTH_PATH };
