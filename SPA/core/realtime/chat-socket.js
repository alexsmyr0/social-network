// SPA/core/realtime/chat-socket.js
//
// D04 — browser WebSocket transport for the realtime chat.
//
// The socket is a thin, decoupled bridge between the backend WS contract
// (SDS § 5.5) and the rest of the SPA. It does NOT touch the DOM directly:
// every inbound server frame is re-published as a DOM CustomEvent on the
// shared documentRef, so feature slices (roster, conversation) subscribe
// without holding a reference to the socket itself. Outbound frames go the
// other way through `send(type, payload)`.
//
// The socket reconnects on its own. It used to open exactly once: a laptop
// waking, a wifi blip or a backend restart left chat permanently dead until the
// user happened to reload the page, with only a transient error banner to say
// so. Drops are now retried with exponential backoff until the socket is either
// re-established or closed deliberately.

// Inbound server event type -> DOM CustomEvent name. Keeping the mapping in
// one place is the single source of truth shared with the subscribers.
export const WS_EVENTS = Object.freeze({
	PRESENCE_SNAPSHOT: 'chat:presence-snapshot',
	PRESENCE_UPDATE: 'chat:presence-update',
	DM_MESSAGE: 'chat:dm-message',
	NOTIFICATION: 'chat:notification-new',
	ERROR: 'chat:error',
});

// Backoff schedule for reconnects, in milliseconds. Doubles from the first
// delay up to the cap; the server's own read deadline is 60s, so a cap of 30s
// keeps a recovering client well inside one window.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Builds the absolute ws:// or wss:// URL for the same-origin /ws endpoint,
// which the frontend server proxies to the backend (D09). Falls back to ws://
// when location data is unavailable (e.g. during tests).
export function resolveSocketURL(locationRef) {
	const protocol = locationRef?.protocol === 'https:' ? 'wss:' : 'ws:';
	const host = locationRef?.host ?? '';
	return `${protocol}//${host}/ws`;
}

function dispatchEvent(documentRef, name, detail) {
	if (typeof documentRef?.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
		return;
	}
	documentRef.dispatchEvent(new CustomEvent(name, { detail }));
}

// Translates a parsed server frame into its corresponding DOM CustomEvent.
// Unknown frame types are ignored — a forward-compatible client must not
// crash on event types it does not understand.
function publishServerEvent(documentRef, frame) {
	const payload = frame?.payload ?? {};

	switch (frame?.type) {
		case 'presence.snapshot':
			dispatchEvent(documentRef, WS_EVENTS.PRESENCE_SNAPSHOT, {
				users: Array.isArray(payload.users) ? payload.users : [],
			});
			return;
		case 'presence.update':
			dispatchEvent(documentRef, WS_EVENTS.PRESENCE_UPDATE, {
				userId: Number(payload.user_id ?? 0),
				isOnline: Boolean(payload.is_online),
			});
			return;
		case 'dm.message':
			dispatchEvent(documentRef, WS_EVENTS.DM_MESSAGE, { message: payload });
			return;
		case 'notification.new':
			// Carries no payload by design: it is a "refetch now" hint that
			// replaces the notification centre's polling timer.
			dispatchEvent(documentRef, WS_EVENTS.NOTIFICATION, {});
			return;
		case 'chat.error':
			dispatchEvent(documentRef, WS_EVENTS.ERROR, {
				code: String(payload.code ?? 'UNKNOWN'),
				message: String(payload.message ?? 'Something went wrong.'),
			});
			return;
		default:
	}
}

export function createChatSocket(options = {}) {
	const windowRef = options.windowRef ?? (typeof window !== 'undefined' ? window : null);
	const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
	const SocketCtor = options.socketCtor ?? windowRef?.WebSocket ?? null;
	const url = options.url ?? resolveSocketURL(windowRef?.location);

	// Injectable so the reconnect schedule is testable under fake timers.
	const setTimeoutRef =
		options.setTimeoutRef ??
		(typeof windowRef?.setTimeout === 'function'
			? windowRef.setTimeout.bind(windowRef)
			: typeof setTimeout === 'function'
				? setTimeout
				: null);
	const clearTimeoutRef =
		options.clearTimeoutRef ??
		(typeof windowRef?.clearTimeout === 'function'
			? windowRef.clearTimeout.bind(windowRef)
			: typeof clearTimeout === 'function'
				? clearTimeout
				: null);

	let socket = null;
	// Set by close(): a deliberate teardown (logout, 401) must not reconnect.
	let closedByCaller = false;
	let reconnectTimer = null;
	let reconnectDelay = RECONNECT_BASE_MS;
	// Guards the disconnect notice so one drop reports once, not once per
	// transport `error` plus once per `close`.
	let reportedDisconnect = false;

	function isOpen() {
		return Boolean(socket) && socket.readyState === 1; // WebSocket.OPEN
	}

	function reportDisconnect() {
		if (reportedDisconnect) {
			return;
		}
		reportedDisconnect = true;
		dispatchEvent(documentRef, WS_EVENTS.ERROR, {
			code: 'CONNECTION_ERROR',
			message: 'Connection lost. Reconnecting…',
		});
	}

	function cancelReconnect() {
		if (reconnectTimer !== null && typeof clearTimeoutRef === 'function') {
			clearTimeoutRef(reconnectTimer);
		}
		reconnectTimer = null;
	}

	function scheduleReconnect() {
		if (closedByCaller || reconnectTimer !== null || typeof setTimeoutRef !== 'function') {
			return;
		}

		const delay = reconnectDelay;
		reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);

		reconnectTimer = setTimeoutRef(() => {
			reconnectTimer = null;
			if (closedByCaller) {
				return;
			}
			open();
		}, delay);
	}

	function open() {
		if (typeof SocketCtor !== 'function' || socket) {
			return socket;
		}

		closedByCaller = false;
		cancelReconnect();

		const instance = new SocketCtor(url);
		socket = instance;

		instance.addEventListener?.('open', () => {
			// A live connection resets the schedule, so a later single blip is
			// retried after 1s rather than inheriting the previous backoff.
			reconnectDelay = RECONNECT_BASE_MS;
			reportedDisconnect = false;
		});

		instance.addEventListener?.('message', (event) => {
			let frame = null;
			try {
				frame = JSON.parse(event?.data ?? 'null');
			} catch {
				// Malformed frame: drop it. The connection stays usable.
				return;
			}
			publishServerEvent(documentRef, frame);
		});

		// A transport-level failure is surfaced to the UI as a chat.error so the
		// user is not left silently staring at a dead composer. `close` always
		// follows `error`, so the retry itself is scheduled from there.
		instance.addEventListener?.('error', () => {
			if (socket !== instance) {
				return;
			}
			reportDisconnect();
		});

		instance.addEventListener?.('close', () => {
			// A stale handler from a superseded connection must not clear the
			// current socket or queue a duplicate retry.
			if (socket !== instance) {
				return;
			}
			socket = null;
			if (closedByCaller) {
				return;
			}
			reportDisconnect();
			scheduleReconnect();
		});

		return instance;
	}

	// Emits a client frame matching the SDS § 5.5 envelope. Returns false when
	// the socket is not open so callers can surface a send failure.
	function send(type, payload) {
		if (!isOpen()) {
			return false;
		}
		socket.send(JSON.stringify({ type, payload }));
		return true;
	}

	function close() {
		closedByCaller = true;
		cancelReconnect();
		reconnectDelay = RECONNECT_BASE_MS;
		reportedDisconnect = false;

		if (!socket) {
			return;
		}
		const instance = socket;
		socket = null;
		instance.close?.();
	}

	return {
		open,
		close,
		send,
		isOpen,
	};
}
