import { onUnmounted, ref, shallowRef, watch } from 'vue';

const FALLBACK_REFETCH_MS = 60000;
// A clear (session ended) must never be upgraded into a refetch.
const MODE_RANK = { quiet: 0, hard: 1, clear: 2 };

// Loads one protected social read and keeps it honest. A newer load always
// supersedes an older one, so a slow response can never repaint obsolete or
// since-denied data. Route/query changes, window focus and server
// invalidations discard the shown data before refetching; the 60-second
// fallback and writes that retain access refetch quietly. A failed read never
// leaves the previous protected details on screen.
export function useSocialResource(load, { social, sources }) {
	const status = ref('loading');
	const result = shallowRef(null);
	const failure = shallowRef(null);
	let latest = 0;
	let scheduled = null;
	let timer = null;
	let active = true;

	function discard(next) {
		result.value = null;
		failure.value = null;
		status.value = next;
	}

	function apply(outcome) {
		if (outcome.status === 'ok') {
			failure.value = null;
			result.value = outcome;
			status.value = 'ready';
			return;
		}
		discard(outcome.status === 'unauthenticated' ? 'loading' : outcome.status);
		if (outcome.status === 'rejected') failure.value = outcome;
	}

	async function run(mode) {
		if (!active) return;
		const mine = ++latest;
		if (mode === 'clear') {
			discard('loading');
			return;
		}
		if (mode === 'hard') discard('loading');
		const outcome = await load();
		if (!active || mine !== latest) return;
		if (outcome.status === 'unauthenticated') {
			discard('loading');
			await social.handleUnauthenticated();
			return;
		}
		apply(outcome);
	}

	// Bursts of invalidations in one tick collapse to a single request; the
	// strongest requested mode wins.
	function reload(mode = 'hard') {
		latest += 1;
		if (mode !== 'quiet') discard('loading');
		if (scheduled) {
			if (MODE_RANK[mode] > MODE_RANK[scheduled.mode]) scheduled.mode = mode;
			return scheduled.promise;
		}
		const entry = { mode };
		entry.promise = Promise.resolve().then(() => {
			scheduled = null;
			return run(entry.mode);
		});
		scheduled = entry;
		return entry.promise;
	}

	const onFocus = () => {
		if (typeof document === 'undefined' || document.visibilityState !== 'hidden') reload('hard');
	};
	const unregister = social.registerResource({ reload });

	if (typeof window !== 'undefined') {
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onFocus);
		timer = setInterval(() => {
			if (document.visibilityState !== 'hidden') reload('quiet');
		}, FALLBACK_REFETCH_MS);
	}

	if (sources) watch(sources, () => reload('hard'));
	reload('hard');

	onUnmounted(() => {
		active = false;
		unregister();
		clearInterval(timer);
		if (typeof window !== 'undefined') {
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onFocus);
		}
	});

	return { status, result, failure, reload };
}
