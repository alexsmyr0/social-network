import { pngBytes, readForm } from './group-content-backend.js';

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

// Same wiring for the group-content model: JSON and multipart writes, media
// bytes for checked image URLs, and payload-free signals to the open page.
// Chromium interception omits uploaded file bytes, so a multipart image is
// recorded and modelled as the chosen fixture image; byte validation is
// covered by the unit-level replay of the approved pack.
export async function installGroupContentFixtures(page, backend, viewer = { id: 42 }) {
	const sockets = [];
	const uploads = [];
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

	async function requestBody(req) {
		const type = req.headers()['content-type'] ?? '';
		if (!type.startsWith('multipart/form-data')) {
			const body = req.postData();
			return { json: body ? JSON.parse(body) : undefined };
		}
		const data = await new Response(req.postDataBuffer(), {
			headers: { 'content-type': type },
		}).formData();
		const form = await readForm(data);
		if (form.image) {
			uploads.push({ name: form.image.name, type: form.image.type });
			const bytes = pngBytes();
			form.image = { ...form.image, bytes, size: bytes.length };
		}
		return { form };
	}

	await page.route('**/api/v1/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (url.pathname === '/api/v1/users/logout' && req.method() === 'POST') {
			viewer.id = null;
			await route.fulfill({ json: { data: { logged_out: true } } });
			return;
		}
		const { json, form } = await requestBody(req);
		const result = backend.request(viewer.id, req.method(), `${url.pathname}${url.search}`, {
			json,
			form,
			headers: { 'X-Requested-With': req.headers()['x-requested-with'] },
		});
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: result.bytes ? 'image/png' : 'application/json',
			body: result.bytes ?? (result.body ? JSON.stringify(result.body) : ''),
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

	return { sockets, uploads, viewer, actAs, flushSignals };
}
