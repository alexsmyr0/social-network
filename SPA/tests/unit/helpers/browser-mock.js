// SPA/tests/unit/helpers/browser-mock.js

import { vi } from 'vitest';
import { normalizePathname } from '../../../core/router/routes.js';

export function createMockBrowser(initialPath = '/') {
	const documentListeners = new Map();
	const windowListeners = new Map();
	const historyCalls = [];

	const overlay = {
		style: { opacity: '1' },
		removed: false,
		remove() {
			this.removed = true;
		},
	};

	const mainContent = { innerHTML: '' };

	const setPath = (path) => {
		location.pathname = path;
		location.href = `https://example.test${path}`;
	};

	const dispatchWindow = (type, event = {}) => {
		const handlers = windowListeners.get(type) ?? [];
		for (const handler of handlers) {
			handler(event);
		}
	};

	const dispatchDocument = (type, event = {}) => {
		const handlers = documentListeners.get(type) ?? [];
		for (const handler of handlers) {
			handler(event);
		}
	};

	const location = {
		pathname: normalizePathname(initialPath),
		href: `https://example.test${normalizePathname(initialPath)}`,
		assign: vi.fn(),
	};

	const history = {
		stack: [normalizePathname(initialPath)],
		index: 0,
		pushState(_state, _title, path) {
			const normalized = normalizePathname(path);
			this.stack = this.stack.slice(0, this.index + 1);
			this.stack.push(normalized);
			this.index += 1;
			setPath(normalized);
			historyCalls.push({ type: 'push', path: normalized });
		},
		replaceState(_state, _title, path) {
			const normalized = normalizePathname(path);
			this.stack[this.index] = normalized;
			setPath(normalized);
			historyCalls.push({ type: 'replace', path: normalized });
		},
		back() {
			if (this.index === 0) {
				return;
			}
			this.index -= 1;
			setPath(this.stack[this.index]);
			dispatchWindow('popstate', { type: 'popstate' });
		},
		forward() {
			if (this.index >= this.stack.length - 1) {
				return;
			}
			this.index += 1;
			setPath(this.stack[this.index]);
			dispatchWindow('popstate', { type: 'popstate' });
		},
	};

	const windowRef = {
		location,
		history,
		addEventListener(type, handler) {
			if (!windowListeners.has(type)) {
				windowListeners.set(type, []);
			}
			windowListeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const handlers = windowListeners.get(type) ?? [];
			windowListeners.set(
				type,
				handlers.filter((candidate) => candidate !== handler),
			);
		},
		setTimeout(fn) {
			fn();
			return 1;
		},
		clearTimeout() {},
	};

	const documentRef = {
		readyState: 'complete',
		getElementById(id) {
			if (id === 'main-content') {
				return mainContent;
			}
			if (id === 'loading-overlay') {
				return overlay;
			}
			return null;
		},
		addEventListener(type, handler) {
			if (!documentListeners.has(type)) {
				documentListeners.set(type, []);
			}
			documentListeners.get(type).push(handler);
		},
		removeEventListener(type, handler) {
			const handlers = documentListeners.get(type) ?? [];
			documentListeners.set(
				type,
				handlers.filter((candidate) => candidate !== handler),
			);
		},
	};

	function clickLink(href) {
		const anchor = {
			getAttribute(name) {
				if (name === 'href') {
					return href;
				}
				return null;
			},
		};

		const event = {
			type: 'click',
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			target: {
				closest(selector) {
					if (selector === 'a[data-link]') {
						return anchor;
					}
					return null;
				},
			},
			preventDefault: vi.fn(() => {
				event.defaultPrevented = true;
			}),
		};

		dispatchDocument('click', event);
		return event;
	}

	function clickLogout() {
		const logoutButton = {
			tagName: 'BUTTON',
		};

		const event = {
			type: 'click',
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			target: {
				closest(selector) {
					if (selector === '[data-action="logout"]') {
						return logoutButton;
					}
					return null;
				},
			},
			preventDefault: vi.fn(() => {
				event.defaultPrevented = true;
			}),
		};

		dispatchDocument('click', event);
		return event;
	}

	function submitForm(formId) {
		const form = {
			id: formId,
			getAttribute: (name) => (name === 'id' ? formId : null),
			closest: (selector) => (selector === 'form' ? form : null),
		};
		const event = {
			type: 'submit',
			target: form,
			preventDefault: vi.fn(() => {
				event.defaultPrevented = true;
			}),
			defaultPrevented: false,
		};
		dispatchDocument('submit', event);
		return event;
	}

	return {
		windowRef,
		documentRef,
		mainContent,
		overlay,
		historyCalls,
		clickLink,
		clickLogout,
		submitForm,
		dispatchDocument,
	};
}
