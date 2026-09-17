// SPA/core/utils/throttle.js

// Leading-edge throttle with a trailing call. The wrapped function runs
// immediately on the first call, then at most once per `wait` ms while calls
// keep arriving. The final call inside a cooldown window is replayed so the
// latest scroll position is never dropped. Timer-based (no Date.now) so it is
// deterministic under fake timers.
export function throttle(fn, wait) {
	let cooling = false;
	let pending = false;
	let savedArgs = null;
	let savedThis = null;

	function run(thisArg, args) {
		fn.apply(thisArg, args);
		cooling = true;
		setTimeout(() => {
			cooling = false;
			if (pending) {
				pending = false;
				const args = savedArgs;
				const thisArg = savedThis;
				savedArgs = null;
				savedThis = null;
				run(thisArg, args);
			}
		}, wait);
	}

	function throttled(...args) {
		if (cooling) {
			pending = true;
			savedArgs = args;
			savedThis = this;
			return;
		}
		run(this, args);
	}

	throttled.cancel = () => {
		cooling = false;
		pending = false;
		savedArgs = null;
		savedThis = null;
	};

	return throttled;
}
