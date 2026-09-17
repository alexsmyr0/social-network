// SPA/core/errors/error-handler.js

/**
 * Registers global error and unhandled promise rejection listeners on window.
 *
 * @param {Window | object | null} [windowRef] Window reference for dependency injection.
 * @returns {(() => void) | null} Teardown function to remove listeners, or null if unsupported.
 */
export function initGlobalErrorHandlers(windowRef = typeof window !== 'undefined' ? window : null) {
	if (!windowRef || typeof windowRef.addEventListener !== 'function') {
		return null;
	}

	const onError = (event) => {
		const error = event?.error || event?.message || event;
		console.error('[Global Error]', error);
	};

	const onUnhandledRejection = (event) => {
		const reason = event?.reason || event;
		console.error('[Unhandled Promise Rejection]', reason);
	};

	windowRef.addEventListener('error', onError);
	windowRef.addEventListener('unhandledrejection', onUnhandledRejection);

	return () => {
		if (typeof windowRef.removeEventListener === 'function') {
			windowRef.removeEventListener('error', onError);
			windowRef.removeEventListener('unhandledrejection', onUnhandledRejection);
		}
	};
}
