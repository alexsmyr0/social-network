import { describe, expect, test, vi } from 'vitest';
import { initFeedPage } from '../../../../features/feed/feed.page.js';

class FakeElement {
	constructor(tagName = 'div') {
		this.tagName = tagName.toUpperCase();
		this.hidden = false;
		this.value = '';
		this.textContent = '';
		this.innerHTML = '';
		this.children = [];
		this.listeners = new Map();
		this.ownerDocument = null;
		this.className = '';
		this.disabled = false;
		this.dataset = {};
		this.classList = {
			add: vi.fn(),
		};
	}

	addEventListener(type, handler) {
		this.listeners.set(type, handler);
	}

	dispatch(type) {
		this.listeners.get(type)?.({ target: this });
	}

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	querySelectorAll() {
		return [];
	}

	querySelector() {
		return null;
	}
}

class FakeSelect extends FakeElement {
	constructor() {
		super('select');
		this.options = [];
	}

	appendChild(option) {
		this.options.push(option);
		return option;
	}

	querySelectorAll(selector) {
		return selector === 'option:not(:first-child)' ? this.options : [];
	}
}

class FakePostsOutput extends FakeElement {
	constructor(documentRef) {
		super('div');
		this.ownerDocument = documentRef;
		this.rendered = [];
	}

	set innerHTML(value) {
		this._innerHTML = value;
		if (value === '') {
			this.rendered = [];
		}
	}

	get innerHTML() {
		return this._innerHTML;
	}

	appendChild(child) {
		this.rendered.push(child);
		return child;
	}
}

class FakeRoot extends FakeElement {
	constructor(documentRef) {
		super('section');
		this.attrs = new Map();
		this.categoryFilter = new FakeSelect();
		this.perPageSelect = new FakeSelect();
		this.postsOutput = new FakePostsOutput(documentRef);
		this.postsEmpty = new FakeElement();
		this.pagination = new FakeElement('nav');
		this.prevPage = new FakeElement('button');
		this.nextPage = new FakeElement('button');
		this.pageNumbers = new FakeElement('div');
	}

	getAttribute(name) {
		return this.attrs.get(name) ?? null;
	}

	setAttribute(name, value) {
		this.attrs.set(name, String(value));
	}

	querySelector(selector) {
		const selectors = {
			'#categoryFilter': this.categoryFilter,
			'#perPageSelect': this.perPageSelect,
			'#posts-output': this.postsOutput,
			'#posts-empty': this.postsEmpty,
			'#pagination': this.pagination,
			'#prevPage': this.prevPage,
			'#nextPage': this.nextPage,
			'#pageNumbers': this.pageNumbers,
		};
		return selectors[selector] ?? null;
	}
}

function createDocumentRef() {
	const documentRef = {
		root: null,
		querySelector(selector) {
			return selector === '[data-screen="feed"]' ? this.root : null;
		},
		createElement(tagName) {
			const element = new FakeElement(tagName);
			element.ownerDocument = this;
			return element;
		},
	};
	documentRef.root = new FakeRoot(documentRef);
	return documentRef;
}

function createWindowRef() {
	const location = {
		href: 'https://example.test/',
		origin: 'https://example.test',
		pathname: '/',
		search: '',
	};
	return {
		location,
		history: {
			pushState(_state, _title, nextPath) {
				const url = new URL(nextPath, 'https://example.test');
				location.href = url.toString();
				location.pathname = url.pathname;
				location.search = url.search;
			},
		},
		dispatchEvent: vi.fn(),
	};
}

function deferredPostResponse() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = (posts) =>
			done({
				ok: true,
				json: async () => ({
					data: posts,
					meta: { pagination: { page: 1, total_pages: 1 } },
				}),
			});
	});
	return { promise, resolve };
}

async function flushMicrotasks() {
	for (let i = 0; i < 5; i += 1) {
		await Promise.resolve();
	}
}

describe('initFeedPage', () => {
	test('ignores stale post responses that resolve after a newer feed request', async () => {
		const documentRef = createDocumentRef();
		const windowRef = createWindowRef();
		const postRequests = [];
		const fetchRef = vi.fn((url) => {
			if (String(url).includes('/categories')) {
				return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
			}
			const request = deferredPostResponse();
			postRequests.push({ url: String(url), ...request });
			return request.promise;
		});

		initFeedPage({ windowRef, documentRef, fetchRef });
		await flushMicrotasks();
		expect(postRequests).toHaveLength(1);

		documentRef.root.perPageSelect.value = '20';
		documentRef.root.perPageSelect.dispatch('change');
		await flushMicrotasks();
		expect(postRequests).toHaveLength(2);

		postRequests[1].resolve([{ id: 2, title: 'Newest page', body: 'fresh' }]);
		await flushMicrotasks();
		expect(documentRef.root.postsOutput.rendered).toHaveLength(1);
		expect(documentRef.root.postsOutput.rendered[0].innerHTML).toContain('Newest page');

		postRequests[0].resolve([{ id: 1, title: 'Stale page', body: 'old' }]);
		await flushMicrotasks();
		expect(documentRef.root.postsOutput.rendered).toHaveLength(1);
		expect(documentRef.root.postsOutput.rendered[0].innerHTML).toContain('Newest page');
		expect(documentRef.root.postsOutput.rendered[0].innerHTML).not.toContain('Stale page');
	});
});
