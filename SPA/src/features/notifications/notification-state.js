import { reactive, readonly, watch } from 'vue';

export const notificationsKey = Symbol('commonplace-notifications');

// One owner for notices and /ws across route changes. A generation protects
// reads, writes, socket callbacks and reconnect timers across account changes.
export function createNotificationState({
	session,
	social,
	socketFactory = (url) => new WebSocket(url),
	location = globalThis.location,
	windowRef = globalThis.window,
	documentRef = globalThis.document,
} = {}) {
	const state = reactive({
		status: 'idle',
		notifications: [],
		requests: [],
		unreadCount: null,
		noticePagination: null,
		requestPagination: null,
		noticePage: 1,
		requestPage: 1,
		connection: 'offline',
		pendingReads: {},
		message: '',
	});
	let generation = 0;
	let readRevision = 0;
	let socket = null;
	let reconnectTimer = null;
	let fallbackTimer = null;
	let scheduled = null;
	let owner = null;
	let disposed = false;
	let retryDelay = 1000;
	let handlingUnauthorized = false;

	function discard(status = 'loading') {
		state.notifications = [];
		state.requests = [];
		state.unreadCount = null;
		state.noticePagination = null;
		state.requestPagination = null;
		state.status = status;
	}

	function closeSocket() {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
		if (socket) {
			const previous = socket;
			socket = null;
			previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
			previous.close();
		}
		state.connection = 'offline';
	}

	function reset() {
		generation += 1;
		readRevision += 1;
		scheduled = null;
		closeSocket();
		clearInterval(fallbackTimer);
		fallbackTimer = null;
		discard('idle');
		state.pendingReads = {};
		state.message = '';
		state.noticePage = state.requestPage = 1;
		retryDelay = 1000;
	}

	async function unauthorized() {
		if (handlingUnauthorized) {
			discard('unavailable');
			return;
		}
		handlingUnauthorized = true;
		reset();
		try {
			await social.handleUnauthenticated();
		} finally {
			handlingUnauthorized = false;
		}
		if (session.state.status === 'authenticated') {
			if (state.status === 'ready') connect();
			startFallback();
		}
	}

	function isCurrentRead(epoch, mine) {
		return epoch === generation && mine === readRevision && !disposed;
	}

	async function read(mode) {
		if (!owner || disposed) return;
		const epoch = generation;
		const mine = ++readRevision;
		if (mode === 'clear') return;
		if (mode === 'hard') discard();
		const [notices, requests] = await Promise.all([
			social.api.fetchNotifications({ page: state.noticePage }),
			social.api.fetchFollowRequests({ page: state.requestPage }),
		]);
		if (!isCurrentRead(epoch, mine)) return;
		if (notices.status === 'unauthenticated' || requests.status === 'unauthenticated') {
			await unauthorized();
			return;
		}
		if (notices.status !== 'ok' || requests.status !== 'ok') {
			discard('unavailable');
			return;
		}
		state.notifications = notices.notifications;
		state.unreadCount = notices.unreadCount;
		state.noticePagination = notices.pagination;
		state.requests = requests.requests;
		state.requestPagination = requests.pagination;
		state.status = 'ready';
		connect();
		startFallback();
	}

	function reload(mode = 'hard') {
		// Revoke old reads and clear protected data synchronously, before a
		// coalesced request starts. A pre-signal response can never repaint it.
		readRevision += 1;
		if (mode !== 'quiet') discard(mode === 'clear' ? 'idle' : 'loading');
		if (scheduled) {
			if (mode === 'clear' || (mode === 'hard' && scheduled.mode !== 'clear'))
				scheduled.mode = mode;
			return scheduled.promise;
		}
		const entry = { mode };
		entry.promise = Promise.resolve().then(() => {
			if (scheduled !== entry) return;
			scheduled = null;
			return read(entry.mode);
		});
		scheduled = entry;
		return entry.promise;
	}

	function invalidate() {
		state.noticePage = state.requestPage = 1;
		return social.invalidate();
	}

	function reconnect(epoch) {
		if (epoch !== generation || !owner || disposed || reconnectTimer) return;
		state.connection = 'reconnecting';
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, retryDelay);
		retryDelay = Math.min(retryDelay * 2, 30000);
	}

	function connect() {
		if (socket || reconnectTimer || !owner || disposed) return;
		const epoch = generation;
		state.connection = 'connecting';
		let current;
		try {
			const url = new URL('/ws', location.href);
			url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			current = socketFactory(url.href);
		} catch {
			reconnect(epoch);
			return;
		}
		socket = current;
		const valid = () => epoch === generation && current === socket && !disposed;
		current.onopen = () => {
			if (!valid()) return;
			retryDelay = 1000;
			state.connection = 'online';
			void invalidate();
		};
		current.onmessage = (event) => {
			if (!valid()) return;
			let signal;
			try {
				signal = JSON.parse(event.data);
			} catch {
				return;
			}
			if (signal?.type === 'notification.new' || signal?.type === 'social.invalidate')
				void invalidate();
		};
		current.onclose = () => {
			if (!valid()) return;
			socket = null;
			reconnect(epoch);
		};
		current.onerror = () => {
			if (!valid()) return;
			current.close();
		};
	}

	const onFocus = () => {
		if (owner && documentRef?.visibilityState !== 'hidden') void invalidate();
	};
	function startFallback() {
		if (disposed || !owner || fallbackTimer) return;
		fallbackTimer = setInterval(() => {
			if (documentRef?.visibilityState !== 'hidden') void invalidate();
		}, 60000);
	}

	const unregister = social.registerResource({
		reload(mode) {
			if (mode === 'clear') reset();
			else {
				state.noticePage = state.requestPage = 1;
			}
			return reload(mode);
		},
	});
	windowRef?.addEventListener('focus', onFocus);
	documentRef?.addEventListener('visibilitychange', onFocus);
	const stopWatch = watch(
		() => [session.state.account?.id ?? null, session.state.status],
		([id, status]) => {
			const nextOwner = ['authenticated', 'checking'].includes(status) ? id : null;
			if (nextOwner === owner) return;
			reset();
			owner = nextOwner;
			if (!owner) return;
			void social.invalidate();
			connect();
			startFallback();
		},
		{ immediate: true, flush: 'sync' },
	);

	function cannotRead(id) {
		return (
			!owner ||
			state.pendingReads[id] ||
			state.pendingReads.all ||
			(id === 'all' && Object.keys(state.pendingReads).length > 0)
		);
	}

	function readMessage(outcome) {
		if (outcome.status === 'ok') return '';
		return outcome.status === 'not-found'
			? 'That notice is no longer available. The list has been refreshed.'
			: 'We couldn’t confirm the read change. Check the refreshed list before trying again.';
	}

	async function markRead(id = 'all') {
		if (cannotRead(id)) return;
		const epoch = generation;
		state.pendingReads[id] = true;
		state.message = '';
		try {
			const outcome =
				id === 'all'
					? await social.api.markAllNotificationsRead()
					: await social.api.markNotificationRead(id);
			if (epoch !== generation) return;
			if (outcome.status === 'unauthenticated') {
				await unauthorized();
				return;
			}
			state.message = readMessage(outcome);
			state.noticePage = state.requestPage = 1;
			await social.refresh();
		} finally {
			if (epoch === generation) delete state.pendingReads[id];
		}
	}

	function setPage(kind, page) {
		state[kind === 'requests' ? 'requestPage' : 'noticePage'] = page;
		return reload();
	}

	function dispose() {
		disposed = true;
		stopWatch();
		unregister();
		windowRef?.removeEventListener('focus', onFocus);
		documentRef?.removeEventListener('visibilitychange', onFocus);
		reset();
		owner = null;
	}

	return { state: readonly(state), reload, invalidate, markRead, setPage, dispose };
}
