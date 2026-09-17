// SPA/core/state/store.js
//
// Minimal Proxy-based reactive store (SDS § 7.0, issue #76).
//
// The whole point of the Proxy is that a plain assignment is the write API:
// `store.state.currentUserId = 7` notifies subscribers exactly like
// `store.set('currentUserId', 7)` does. Feature slices therefore never have to
// remember to call a setter — the trap does the bookkeeping.
//
// Deliberately small: no nesting, no deep reactivity, no computed values. Every
// value is treated as one opaque slot compared with `Object.is`, so slices hold
// immutable values (numbers, booleans, frozen arrays, replaced Sets) and swap
// them wholesale rather than mutating in place.

// A write that does not change the slot must not wake subscribers — otherwise a
// presence frame repeating "user 3 is online" repaints the roster on every ping.
function isUnchanged(previous, next) {
	return Object.is(previous, next);
}

export function createStore(initialState = {}) {
	const initial = { ...initialState };
	const target = { ...initialState };

	// Global listeners fire once per write batch; key listeners fire only for
	// the slots they asked about. Sets give O(1) unsubscribe and dedupe repeats.
	const globalListeners = new Set();
	const keyListeners = new Map();

	function snapshot() {
		return { ...target };
	}

	// Listeners are copied before iteration so a subscriber that unsubscribes
	// (or subscribes) during notification cannot corrupt the live iteration.
	function notify(changes) {
		if (changes.length === 0) {
			return;
		}

		for (const { key, value, previous } of changes) {
			const listeners = keyListeners.get(key);
			if (!listeners) {
				continue;
			}
			for (const listener of [...listeners]) {
				listener(value, previous, key);
			}
		}

		if (globalListeners.size === 0) {
			return;
		}

		const changedKeys = changes.map((change) => change.key);
		const current = snapshot();
		for (const listener of [...globalListeners]) {
			listener(current, changedKeys);
		}
	}

	// Writes go through the Proxy so direct assignment and set() share one path.
	const state = new Proxy(target, {
		set(object, key, value) {
			const previous = object[key];
			if (isUnchanged(previous, value)) {
				return true;
			}
			object[key] = value;
			notify([{ key, value, previous }]);
			return true;
		},
		deleteProperty(object, key) {
			if (!Object.hasOwn(object, key)) {
				return true;
			}
			const previous = object[key];
			delete object[key];
			notify([{ key, value: undefined, previous }]);
			return true;
		},
	});

	function get(key) {
		return key === undefined ? snapshot() : target[key];
	}

	// set(key, value) writes one slot; set(patch) writes several and notifies
	// global subscribers once for the whole batch rather than per key.
	function set(keyOrPatch, maybeValue) {
		if (typeof keyOrPatch === 'string') {
			state[keyOrPatch] = maybeValue;
			return;
		}

		if (!keyOrPatch || typeof keyOrPatch !== 'object') {
			return;
		}

		const changes = [];
		for (const [key, value] of Object.entries(keyOrPatch)) {
			const previous = target[key];
			if (isUnchanged(previous, value)) {
				continue;
			}
			target[key] = value;
			changes.push({ key, value, previous });
		}
		notify(changes);
	}

	// subscribe(listener) watches every key; subscribe(key, listener) watches
	// one. Both return the unsubscribe function.
	function subscribe(keyOrListener, maybeListener) {
		if (typeof keyOrListener === 'function') {
			globalListeners.add(keyOrListener);
			return () => globalListeners.delete(keyOrListener);
		}

		if (typeof keyOrListener !== 'string' || typeof maybeListener !== 'function') {
			return () => {};
		}

		if (!keyListeners.has(keyOrListener)) {
			keyListeners.set(keyOrListener, new Set());
		}
		const listeners = keyListeners.get(keyOrListener);
		listeners.add(maybeListener);

		return () => {
			listeners.delete(maybeListener);
			if (listeners.size === 0) {
				keyListeners.delete(keyOrListener);
			}
		};
	}

	// Restores the construction-time values and notifies whatever actually
	// moved. Subscribers survive a reset — only data is rolled back.
	function reset() {
		const changes = [];
		for (const key of new Set([...Object.keys(target), ...Object.keys(initial)])) {
			const previous = target[key];
			const value = initial[key];

			if (!Object.hasOwn(initial, key)) {
				delete target[key];
				changes.push({ key, value: undefined, previous });
				continue;
			}

			if (isUnchanged(previous, value)) {
				continue;
			}
			target[key] = value;
			changes.push({ key, value, previous });
		}
		notify(changes);
	}

	return { state, get, set, subscribe, reset };
}
