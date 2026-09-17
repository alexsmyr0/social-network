// SPA/tests/unit/core/errors/error-handler.test.js

import { afterEach, describe, expect, test, vi } from 'vitest';
import { initGlobalErrorHandlers } from '../../../../core/errors/error-handler.js';

describe('Global error and unhandled rejection handlers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('returns null when window or addEventListener is unavailable', () => {
		expect(initGlobalErrorHandlers(null)).toBeNull();
		expect(initGlobalErrorHandlers({})).toBeNull();
	});

	test('registers event listeners and logs global errors and unhandled rejections', () => {
		const listeners = new Map();
		const windowRef = {
			addEventListener: vi.fn((event, handler) => {
				listeners.set(event, handler);
			}),
			removeEventListener: vi.fn((event) => {
				listeners.delete(event);
			}),
		};

		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const cleanup = initGlobalErrorHandlers(windowRef);

		expect(windowRef.addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
		expect(windowRef.addEventListener).toHaveBeenCalledWith(
			'unhandledrejection',
			expect.any(Function),
		);

		// Trigger error event
		const errorHandler = listeners.get('error');
		expect(errorHandler).toBeTypeOf('function');
		const mockError = new Error('Test global error');
		errorHandler({ error: mockError });

		expect(consoleErrorSpy).toHaveBeenCalledWith('[Global Error]', mockError);

		// Trigger unhandledrejection event
		const rejectionHandler = listeners.get('unhandledrejection');
		expect(rejectionHandler).toBeTypeOf('function');
		const mockReason = new Error('Unhandled promise reject');
		rejectionHandler({ reason: mockReason });

		expect(consoleErrorSpy).toHaveBeenCalledWith('[Unhandled Promise Rejection]', mockReason);

		// Test cleanup
		cleanup();
		expect(windowRef.removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));
		expect(windowRef.removeEventListener).toHaveBeenCalledWith(
			'unhandledrejection',
			expect.any(Function),
		);
	});
});
