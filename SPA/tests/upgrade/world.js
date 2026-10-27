import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';

// Shared by the legacy seed and the post-upgrade verification of SN-A21. The
// seed talks to the last pre-Phase-5 backend; the verifier to the current one.
export const png = readFileSync('SPA/tests/fixtures/a07/avatar.png');
export const password = 'correct horse battery';
export const stateFile = () => process.env.A21_UPGRADE_STATE;
export const saveState = (state) => writeFileSync(stateFile(), JSON.stringify(state));
export const loadState = () => JSON.parse(readFileSync(stateFile(), 'utf8'));
export const uuid = () => randomUUID();

const headers = (baseURL) => ({ Origin: baseURL, 'X-Requested-With': 'XMLHttpRequest' });
export const newActor = async (browser, baseURL, role, extra = {}) => {
	const context = await browser.newContext({
		baseURL,
		extraHTTPHeaders: headers(baseURL),
		...extra,
	});
	return { role, context, page: await context.newPage() };
};

export async function http(actor, method, path, data, expected = 200) {
	const options = data === undefined ? {} : { data };
	const response = await actor.context.request[method](path, options);
	expect(response.status(), `${actor.role} ${method} ${path}`).toBe(expected);
	if (expected === 204) return null;
	return response.json();
}
export async function multipart(actor, path, fields, expected = 201) {
	const response = await actor.context.request.post(path, { multipart: fields });
	expect(response.status(), `${actor.role} POST ${path}`).toBe(expected);
	return (await response.json()).data;
}
export const image = (name = 'image.png') => ({ name, mimeType: 'image/png', buffer: png });

export async function bytes(actor, path) {
	const response = await actor.context.request.get(path);
	return {
		status: response.status(),
		body: response.status() === 200 ? await response.body() : null,
	};
}
export async function expectBytes(actor, path, allowed) {
	const result = await bytes(actor, path);
	expect(result.status, `${actor.role} ${path}`).toBe(allowed ? 200 : 404);
	if (allowed) expect(result.body).toEqual(png);
}
