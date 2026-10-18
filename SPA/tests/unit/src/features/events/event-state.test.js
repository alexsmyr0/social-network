import { expect, test, vi } from 'vitest';

import { createEventState } from '../../../../../src/features/events/event-state.js';
import { deferred } from '../groups/harness.js';

function setup() {
	const api = { createEvent: vi.fn(async () => ({ status: 'unavailable' })) };
	const social = { refresh: vi.fn(), invalidate: vi.fn() };
	return { events: createEventState({ api, social }), api };
}

test('an event read started before a lost creation response cannot unlock retry', async () => {
	const { events, api } = setup();
	const hold = deferred();
	const read = events.reconcileCreation(301, async () => {
		await hold.promise;
		return { status: 'ok' };
	});
	await events.create(301, {});
	hold.release();
	await read;
	expect((await events.create(301, {})).status).toBe('busy');
	expect(api.createEvent).toHaveBeenCalledTimes(1);
});

test.each([
	'unavailable',
	'not-found',
])('a %s event read keeps creation blocked; another group read cannot unlock it', async (status) => {
	const { events, api } = setup();
	await events.create(301, {});
	await events.reconcileCreation(301, async () => ({ status }));
	await events.reconcileCreation(302, async () => ({ status: 'ok' }));
	expect((await events.create(301, {})).status).toBe('busy');
	expect(api.createEvent).toHaveBeenCalledTimes(1);
	await events.reconcileCreation(301, async () => ({ status: 'ok' }));
	await events.create(301, {});
	expect(api.createEvent).toHaveBeenCalledTimes(2);
});

test('a previous account’s late event read cannot unlock a newer uncertain creation', async () => {
	const { events, api } = setup();
	await events.create(301, {});
	const hold = deferred();
	const read = events.reconcileCreation(301, async () => {
		await hold.promise;
		return { status: 'ok' };
	});
	events.reset();
	await events.create(301, {});
	hold.release();
	await read;
	expect((await events.create(301, {})).status).toBe('busy');
	expect(api.createEvent).toHaveBeenCalledTimes(2);
});
