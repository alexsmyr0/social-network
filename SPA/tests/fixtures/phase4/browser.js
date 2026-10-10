// Routes the shipped Vue application's API and socket traffic to a GroupBackend
// in the browser. Committed signals are forwarded as payload-free frames to the
// open page when the current viewer is a recipient, as the real socket would.
export async function installGroupFixtures(page, backend, viewer = { id: 42 }) {
	const sockets = [];
	await page.routeWebSocket('**/ws', (socket) => {
		sockets.push(socket);
	});

	function flushSignals() {
		const frames = backend.signals.splice(0);
		for (const frame of frames) {
			const reaches =
				frame.recipients === 'all_authenticated' || frame.recipients.includes(viewer.id);
			if (reaches && viewer.id !== null)
				for (const socket of sockets) socket.send(JSON.stringify({ type: frame.type }));
		}
	}

	await page.route('**/api/v1/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (url.pathname === '/api/v1/users/logout' && req.method() === 'POST') {
			viewer.id = null;
			await route.fulfill({ json: { data: { logged_out: true } } });
			return;
		}
		const body = req.postData();
		const result = backend.request(viewer.id, req.method(), `${url.pathname}${url.search}`, {
			json: body ? JSON.parse(body) : undefined,
			headers: { 'X-Requested-With': req.headers()['x-requested-with'] },
		});
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: 'application/json',
			body: result.body ? JSON.stringify(result.body) : '',
		});
		flushSignals();
	});

	// Another user's write, committed directly on the model, then signalled.
	function actAs(userId, method, path, json) {
		const result = backend.request(userId, method, `/api/v1${path}`, {
			json,
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		flushSignals();
		return result;
	}

	return { sockets, viewer, actAs, flushSignals };
}
