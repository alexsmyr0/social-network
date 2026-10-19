// Routes the shipped Vue application's API, private-image and socket traffic
// to a ChatBackend in the browser. Committed signals reach the open page as
// the real socket would send them: message frames carry their payload,
// invalidation carries none, and every connection (and every invalidation)
// is followed by a presence snapshot filtered for the viewer.
export async function installChatFixtures(page, backend, viewer = { id: 42 }) {
	const sockets = [];
	const closed = new WeakSet();
	const uploads = [];
	// `offline` makes every API request fail like a dropped network.
	const network = { offline: false };

	function push(socket, frame) {
		socket.send(JSON.stringify(frame));
	}

	await page.routeWebSocket('**/ws', (socket) => {
		sockets.push(socket);
		socket.onClose(() => closed.add(socket));
		if (viewer.id !== null)
			push(socket, { type: 'presence.snapshot', payload: backend.presenceSnapshot(viewer.id) });
	});

	function live() {
		return sockets.filter((socket) => !closed.has(socket));
	}

	// The server drops every connection; the page reconnects by itself.
	async function dropSockets() {
		for (const socket of live()) await socket.close();
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test-only signal forwarder
	function flushSignals() {
		const frames = backend.signals.splice(0);
		for (const frame of frames) {
			const reaches =
				viewer.id !== null &&
				(frame.recipients === 'all_authenticated' || frame.recipients.includes(viewer.id));
			if (!reaches) continue;
			const wire =
				frame.payload === undefined
					? { type: frame.type }
					: { type: frame.type, payload: frame.payload };
			for (const socket of live()) {
				push(socket, wire);
				if (frame.type === 'social.invalidate')
					push(socket, { type: 'presence.snapshot', payload: backend.presenceSnapshot(viewer.id) });
			}
		}
	}

	async function requestBody(req) {
		const type = req.headers()['content-type'] ?? '';
		if (!type.startsWith('multipart/form-data')) {
			const body = req.postData();
			return { json: body ? JSON.parse(body) : undefined };
		}
		const data = await new Response(req.postDataBuffer(), {
			headers: { 'content-type': type },
		}).formData();
		const multipart = [...data.entries()].map(([name, value]) => ({
			name,
			filename: value?.name,
			type: value?.type,
		}));
		uploads.push(...multipart);
		return { multipart };
	}

	await page.route(/\/api\/v1\//u, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (network.offline) {
			await route.abort('internetdisconnected');
			return;
		}
		if (url.pathname === '/api/v1/users/logout' && req.method() === 'POST') {
			viewer.id = null;
			await route.fulfill({ json: { data: { logged_out: true } } });
			return;
		}
		const { json, multipart } = await requestBody(req);
		const result = backend.request(viewer.id, req.method(), `${url.pathname}${url.search}`, {
			json,
			multipart,
			headers: { 'X-Requested-With': req.headers()['x-requested-with'] },
		});
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: result.bytes ? 'image/png' : 'application/json',
			body: result.bytes
				? Buffer.from(result.bytes)
				: result.body
					? JSON.stringify(result.body)
					: '',
		});
		flushSignals();
	});

	// Another account's action, committed directly on the model, then signalled.
	function actAs(userId, method, path, json) {
		const result = backend.request(userId, method, `/api/v1${path}`, {
			json,
			headers: { 'X-Requested-With': 'XMLHttpRequest' },
		});
		flushSignals();
		return result;
	}

	return { sockets, uploads, viewer, network, actAs, flushSignals, dropSockets, live };
}
