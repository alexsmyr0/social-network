// @vitest-environment jsdom
// SN-A19: the approved delivery matrix (every directed-follow × recipient
// visibility × recipient-online combination) replayed through the Vue
// application, for the sender and for the recipient.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatBackend, loadChatFixtures } from '../../../../fixtures/phase5/chat-backend.js';
import {
	cleanupMounted,
	deliverFrames,
	mountMessagesApp,
	settle,
	textOf,
	type,
} from './harness.js';

const pack = loadChatFixtures();
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const NONCE = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
	cleanupMounted();
	vi.unstubAllGlobals();
});

const given = (cell) => ({
	follows: { '1:2': cell.outgoing, '2:1': cell.incoming },
	users: { 2: { visibility: cell.recipient_visibility, online: cell.recipient_online } },
});
const bodies = (wrapper) => wrapper.findAll('.message__body').map((item) => item.text());

describe('SN-A19 delivery matrix in the application', () => {
	test('replays all 36 cells', () => {
		expect(pack.dm_matrix).toHaveLength(36);
	});

	test.each(
		pack.dm_matrix.map((cell) => [cell.case_id, cell]),
	)('%s: sender view', async (_id, cell) => {
		const backend = ChatBackend.fromPack(pack, given(cell));
		const app = await mountMessagesApp('/messages/2', { backend, viewerId: 1 });
		// Retained history stays readable whatever the relationship.
		expect(bodies(app.wrapper)).toEqual(['older', 'reply']);
		const box = app.wrapper.get('#message-body');
		expect(box.attributes('disabled') === undefined).toBe(cell.can_send);
		if (cell.can_send) {
			await type(app.wrapper, 'Hi 👋');
			await app.wrapper.get('.message-composer__send').trigger('click');
			await settle();
			expect(bodies(app.wrapper).at(-1)).toBe('Hi 👋');
			expect(backend.dms.size).toBe(3);
		} else {
			expect(textOf(app.wrapper)).toContain('You can’t message Ada any more.');
			expect(app.fetchRef.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
		}
		// Presence is shown only when the viewer may see the profile, and it is
		// the recipient's real state.
		const presence = app.wrapper.find('.conversation-head .presence');
		expect(presence.exists()).toBe(cell.presence_visible);
		if (cell.presence_visible) {
			expect(presence.attributes('data-online')).toBe(String(cell.recipient_online));
		}
		await app.router.push('/messages');
		await settle();
		const row = app.wrapper.get('[data-user-id="2"]');
		expect(row.find('.presence').exists()).toBe(cell.presence_visible);
		expect(row.text().includes('Read only')).toBe(!cell.can_send);
	});

	test.each(
		pack.dm_matrix.map((cell) => [cell.case_id, cell]),
	)('%s: recipient view', async (_id, cell) => {
		const backend = ChatBackend.fromPack(pack, given(cell));
		const app = await mountMessagesApp('/messages/1', { backend, viewerId: 2 });
		expect(bodies(app.wrapper)).toEqual(['older', 'reply']);
		const result = backend.request(1, 'POST', '/api/v1/chats/2/messages', {
			json: { client_id: NONCE, body: 'Hi 👋' },
			headers: XHR,
		});
		expect(result.status).toBe(cell.can_send ? 201 : 404);
		await deliverFrames(app);
		// A permitted message reaches the recipient's open page at once only when
		// the live predicate holds; otherwise it is stored and a later read
		// (focus, reconnect, reopening) shows it.
		expect(bodies(app.wrapper).includes('Hi 👋')).toBe(cell.recipient_live);
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(bodies(app.wrapper).includes('Hi 👋')).toBe(cell.can_send);
	});
});
