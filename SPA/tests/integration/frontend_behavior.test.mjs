import { beforeAll, expect, test } from 'vitest';
import { setupImagePicker } from '../../core/shared/image-picker.js';
import { renderPostCard } from '../../features/post/post-card.views.js';

class MockClassList {
	constructor() {
		this.items = new Set();
	}

	add(...tokens) {
		for (const token of tokens) this.items.add(token);
	}

	remove(...tokens) {
		for (const token of tokens) this.items.delete(token);
	}

	contains(token) {
		return this.items.has(token);
	}

	toggle(token, force) {
		if (typeof force === 'boolean') {
			if (force) {
				this.items.add(token);
			} else {
				this.items.delete(token);
			}
			return force;
		}
		if (this.items.has(token)) {
			this.items.delete(token);
			return false;
		}
		this.items.add(token);
		return true;
	}
}

class MockStyle {
	constructor() {
		this.values = new Map();
	}

	setProperty(name, value) {
		this.values.set(name, value);
	}

	removeProperty(name) {
		this.values.delete(name);
	}

	getPropertyValue(name) {
		return this.values.get(name) ?? '';
	}
}

class MockEventTarget {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(type, handler, options = {}) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		const once = !!(options && typeof options === 'object' && options.once);
		this.listeners.get(type).push({ handler, once });
	}

	removeEventListener(type, handler) {
		const items = this.listeners.get(type);
		if (!items) return;
		this.listeners.set(
			type,
			items.filter((item) => item.handler !== handler),
		);
	}

	dispatchEvent(event) {
		if (!event || typeof event.type !== 'string') {
			throw new Error('event.type is required');
		}
		if (typeof event.preventDefault !== 'function') {
			event.preventDefault = () => {};
		}
		if (typeof event.stopPropagation !== 'function') {
			event.stopPropagation = () => {};
		}

		const items = this.listeners.get(event.type) ?? [];
		for (const item of [...items]) {
			item.handler.call(this, event);
			if (item.once) {
				this.removeEventListener(event.type, item.handler);
			}
		}
		return true;
	}
}

class MockElement extends MockEventTarget {
	constructor(tagName = 'div') {
		super();
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.classList = new MockClassList();
		this.style = new MockStyle();
		this.dataset = {};
		this.hidden = false;
		this.textContent = '';
		this.attributes = new Map();
	}

	appendChild(child) {
		child.parentNode = this;
		this.children.push(child);
		return child;
	}

	remove() {
		if (!this.parentNode) return;
		this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
		this.parentNode = null;
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	getBoundingClientRect() {
		return { width: 0, height: 0 };
	}

	querySelectorAll() {
		return [];
	}
}

class MockImageElement extends MockElement {
	constructor() {
		super('img');
		this._src = '';
		this.currentSrc = '';
		this.alt = '';
		this.complete = false;
		this.naturalWidth = 0;
		this.naturalHeight = 0;
	}

	set src(value) {
		const v = String(value);
		this._src = v;
		this.currentSrc = v;
		this.complete = true;
		if (!this.naturalWidth) this.naturalWidth = 40;
		if (!this.naturalHeight) this.naturalHeight = 40;
	}

	get src() {
		return this._src;
	}
}

class MockInputElement extends MockElement {
	constructor() {
		super('input');
		this.files = [];
		this._value = '';
	}

	set value(v) {
		this._value = String(v);
		if (this._value === '') {
			this.files = [];
		}
	}

	get value() {
		return this._value;
	}

	click() {
		this.dispatchEvent({ type: 'click' });
	}
}

class MockCanvasContext {
	drawImage() {}

	getImageData() {
		const alpha = globalThis.__mockCanvasAlpha ?? 255;
		return { data: new Uint8ClampedArray([0, 0, 0, alpha]) };
	}
}

class MockCanvasElement extends MockElement {
	constructor() {
		super('canvas');
		this.width = 0;
		this.height = 0;
	}

	getContext() {
		return new MockCanvasContext();
	}
}

class MockDocument {
	constructor() {
		this.body = new MockElement('body');
	}

	createElement(tagName) {
		const tag = String(tagName).toLowerCase();
		if (tag === 'canvas') return new MockCanvasElement();
		if (tag === 'img') return new MockImageElement();
		if (tag === 'input') return new MockInputElement();
		return new MockElement(tag);
	}

	querySelector() {
		return null;
	}
}

function installTestEnvironment() {
	const doc = new MockDocument();
	const win = {
		location: { href: 'https://example.test/' },
		addEventListener() {},
		removeEventListener() {},
		setTimeout,
		clearTimeout,
	};

	globalThis.window = win;
	globalThis.document = doc;
	globalThis.Element = MockElement;
	globalThis.HTMLElement = MockElement;
	globalThis.HTMLImageElement = MockImageElement;

	const NativeURL = globalThis.URL;
	NativeURL.createObjectURL = () => 'blob:mock-preview';
	NativeURL.revokeObjectURL = () => {};
	globalThis.URL = NativeURL;

	globalThis.__mockCanvasAlpha = 255;
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
	installTestEnvironment();
});

test('Image preview behavior', async () => {
	expect(typeof setupImagePicker).toBe('function');

	const input = new MockInputElement();
	const triggerButton = new MockElement('button');
	const clearButton = new MockElement('button');
	clearButton.hidden = true;
	const nameLabel = new MockElement('span');
	const previewContainer = new MockElement('div');
	previewContainer.hidden = true;
	const previewImage = new MockImageElement();

	let tooLargeCalls = 0;

	setupImagePicker({
		input,
		triggerButton,
		clearButton,
		nameLabel,
		previewContainer,
		previewImage,
		maxBytes: 10,
		onTooLarge: () => {
			tooLargeCalls += 1;
		},
	});

	input.files = [{ name: 'ok.jpg', size: 9, type: 'image/jpeg' }];
	input.dispatchEvent({ type: 'change' });

	expect(previewContainer.hidden).toBe(false);
	expect(clearButton.hidden).toBe(false);
	expect(nameLabel.textContent).toBe('Selected: ok.jpg');
	expect(previewImage.src.startsWith('blob:mock-preview')).toBeTruthy();

	input.value = 'had-file';
	input.files = [{ name: 'too-big.jpg', size: 11, type: 'image/jpeg' }];
	input.dispatchEvent({ type: 'change' });

	expect(tooLargeCalls).toBe(1);
	expect(input.value).toBe('');
	expect(input.files.length).toBe(0);
});

test('Preview checkerboard for transparent PNG', async () => {
	const input = new MockInputElement();
	const previewContainer = new MockElement('div');
	previewContainer.hidden = true;
	const previewImage = new MockImageElement();

	setupImagePicker({
		input,
		previewContainer,
		previewImage,
		maxBytes: 1024,
	});

	globalThis.__mockCanvasAlpha = 80;

	input.files = [{ name: 'transparent.png', size: 200, type: 'image/png' }];
	input.dispatchEvent({ type: 'change' });

	await flushMicrotasks();

	expect(previewContainer.hidden).toBe(false);
	expect(previewContainer.classList.contains('image-preview--checkerboard')).toBeTruthy();
	expect(previewImage.dataset.transparent).toBe('true');
});

test('Post card renders body and reactions without comment preview markup', () => {
	const documentRef = new MockDocument();
	const article = renderPostCard(documentRef, {
		id: 7,
		title: 'Forum post',
		body: 'Body copy',
		username: 'alice',
		created_at: '2026-04-21T10:00:00Z',
		likes_count: 2,
		dislikes_count: 1,
	});

	expect(article.innerHTML).toContain('Forum post');
	expect(article.innerHTML).toContain('Body copy');
	expect(article.innerHTML).toContain('data-reaction-scope="post"');
	expect(article.innerHTML).not.toContain('data-comments-preview');
});
