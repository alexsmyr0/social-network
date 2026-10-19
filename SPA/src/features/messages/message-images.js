// Private message images are read with the session and shown from local object
// URLs. The cache belongs to the signed-in account: `clear` revokes every URL,
// and a response that lands after a clear is revoked on arrival, so no image
// from a previous account can be painted or reused. Entries on screen are
// reference counted and never evicted from under the page.
export function createImageCache({
	fetchImage,
	createUrl = (blob) => URL.createObjectURL(blob),
	revokeUrl = (url) => URL.revokeObjectURL(url),
	limit = 60,
} = {}) {
	const entries = new Map();
	let epoch = 0;

	function evict() {
		for (const [url, entry] of entries) {
			if (entries.size <= limit) return;
			if (entry.refs === 0 && entry.src) {
				revokeUrl(entry.src);
				entries.delete(url);
			}
		}
	}

	async function acquire(url) {
		const existing = entries.get(url);
		if (existing) {
			existing.refs += 1;
			const result = await existing.promise;
			if (result.status !== 'ok') release(url);
			return result;
		}
		const mine = epoch;
		const entry = { refs: 1, src: null, promise: null };
		entry.promise = (async () => {
			const result = await fetchImage(url);
			if (result.status !== 'ok') return result;
			const src = createUrl(result.blob);
			if (mine !== epoch) {
				revokeUrl(src);
				return { status: 'unavailable' };
			}
			entry.src = src;
			return { status: 'ok', src };
		})();
		entries.set(url, entry);
		const result = await entry.promise;
		if (result.status !== 'ok') {
			// Failures are never cached, so the next view tries again.
			if (entries.get(url) === entry) entries.delete(url);
			return result;
		}
		evict();
		return result;
	}

	function release(url) {
		const entry = entries.get(url);
		if (entry && entry.refs > 0) entry.refs -= 1;
	}

	function clear() {
		epoch += 1;
		for (const entry of entries.values()) if (entry.src) revokeUrl(entry.src);
		entries.clear();
	}

	return { acquire, release, clear, size: () => entries.size };
}
