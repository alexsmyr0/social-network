import { pngBytes, readForm } from './content-backend.js';
export async function installContentFixtures(page, backend, viewer = { id: 42 }) {
	const sockets = [];
	const uploads = [];
	await page.routeWebSocket('**/ws', (socket) => {
		sockets.push(socket);
	});
	await page.route('**/api/v1/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (url.pathname === '/api/v1/users/logout' && req.method() === 'POST') {
			viewer.id = null;
			await route.fulfill({ json: { data: { logged_out: true } } });
			return;
		}
		const { json, form } = await requestBody(req, uploads);
		const headers = { 'X-Requested-With': req.headers()['x-requested-with'] };
		const result = backend.request(viewer.id, req.method(), `${url.pathname}${url.search}`, {
			json,
			form,
			headers,
		});
		await route.fulfill({
			status: result.status,
			headers: result.headers,
			contentType: result.bytes ? 'image/png' : 'application/json',
			body: result.bytes ?? (result.body ? JSON.stringify(result.body) : ''),
		});
	});
	return { sockets, viewer, uploads };
}

async function requestBody(req, uploads) {
	const type = req.headers()['content-type'] ?? '';
	let json;
	let form;
	if (type.startsWith('multipart/form-data')) {
		const data = await new Response(req.postDataBuffer(), {
			headers: { 'content-type': type },
		}).formData();
		form = await readForm(data);
		// Chromium interception omits uploaded file bytes, so record the part
		// the browser sent and model it as the chosen fixture image. Byte
		// validation is covered by the unit-level fixture replay.
		if (form.image) {
			uploads.push({ name: form.image.name, type: form.image.type });
			const bytes = pngBytes();
			form.image = { ...form.image, bytes, size: bytes.length };
		}
	} else if (req.postData()) {
		json = JSON.parse(req.postData());
	}
	return { json, form };
}
