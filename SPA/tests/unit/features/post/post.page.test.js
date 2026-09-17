import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

var createPost;
var createPostComment;
var getPostById;
var getPostComments;
var loadPostCategories;
var loadPostForEdit;
var normalizeCategoryIDs;
var updatePost;
var setupImagePicker;
const OriginalFormData = globalThis.FormData;
const OriginalHTMLElement = globalThis.HTMLElement;
const OriginalHTMLFormElement = globalThis.HTMLFormElement;
const OriginalHTMLInputElement = globalThis.HTMLInputElement;
const OriginalHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
const OriginalHTMLButtonElement = globalThis.HTMLButtonElement;
const OriginalHTMLAnchorElement = globalThis.HTMLAnchorElement;
const OriginalHTMLImageElement = globalThis.HTMLImageElement;
const OriginalPopStateEvent = globalThis.PopStateEvent;

vi.mock('../../../../features/post/post.api.js', () => {
	createPost = vi.fn();
	createPostComment = vi.fn();
	getPostById = vi.fn();
	getPostComments = vi.fn();
	loadPostCategories = vi.fn();
	loadPostForEdit = vi.fn();
	normalizeCategoryIDs = vi.fn((categories = []) =>
		categories
			.map((category) => {
				if (typeof category === 'number' || typeof category === 'string') {
					return Number(category);
				}
				return Number(category?.id);
			})
			.filter((id) => Number.isFinite(id) && id > 0)
			.sort((a, b) => a - b),
	);
	updatePost = vi.fn();

	return {
		createPost,
		createPostComment,
		getPostById,
		getPostComments,
		loadPostCategories,
		loadPostForEdit,
		normalizeCategoryIDs,
		updatePost,
	};
});

vi.mock('../../../../core/shared/image-picker.js', () => {
	setupImagePicker = vi.fn();

	return {
		setupImagePicker,
	};
});

import { initPostDetailPage, initPostFormPage } from '../../../../features/post/post.page.js';

class FakeElement {}
class FakeHTMLElement extends FakeElement {
	constructor() {
		super();
		this.dataset = {};
		this.attributes = new Map();
		this.hidden = false;
		this.textContent = '';
		this.listeners = new Map();
		this.ownerDocument = null;
	}

	addEventListener(type, handler) {
		this.listeners.set(type, handler);
	}

	removeEventListener(type) {
		this.listeners.delete(type);
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

	querySelector() {
		return null;
	}

	querySelectorAll() {
		return [];
	}
}

class FakeHTMLFormElement extends FakeHTMLElement {}
class FakeHTMLInputElement extends FakeHTMLElement {
	constructor() {
		super();
		this.value = '';
		this.checked = false;
		this.files = [];
		this.type = 'text';
	}
}
class FakeHTMLTextAreaElement extends FakeHTMLElement {
	constructor() {
		super();
		this.value = '';
	}
}
class FakeHTMLButtonElement extends FakeHTMLElement {
	constructor(label = '') {
		super();
		this.disabled = false;
		this.textContent = label;
		this._classes = new Set();
		this.classList = {
			contains: (name) => this._classes.has(name),
			add: (...names) => {
				names.forEach((name) => {
					this._classes.add(name);
				});
			},
		};
	}
}
class FakeHTMLAnchorElement extends FakeHTMLElement {
	constructor(href = '/') {
		super();
		this.href = href;
	}
}
class FakeHTMLImageElement extends FakeHTMLElement {}

class FakeCommentsContainer {
	constructor() {
		this.innerHTML = '';
	}
}

class FakeFeedbackNode extends FakeHTMLElement {
	constructor() {
		super();
		this.hidden = true;
	}
}

class FakeSubmitButton extends FakeHTMLButtonElement {
	constructor(label = 'Post comment', primary = false) {
		super(label);
		if (primary) {
			this.classList.add('post-editor__button--primary');
		}
	}
}

class FakeImageInput extends FakeHTMLInputElement {
	constructor() {
		super();
		this.files = [];
	}
}

class FakeButton extends FakeHTMLButtonElement {
	constructor(label = '') {
		super(label);
	}
}

class FakeCommentForm extends FakeHTMLFormElement {
	constructor() {
		super();
		this.feedback = new FakeFeedbackNode();
		this.submitButton = new FakeSubmitButton();
		this.imageInput = new FakeImageInput();
		this.imageButton = new FakeButton();
		this.imageClear = new FakeButton();
		this.imageName = new FakeHTMLElement();
		this.imagePreview = new FakeHTMLElement();
		this.imagePreviewImage = new FakeHTMLImageElement();
		this.fields = { body: '' };
		this.reset = vi.fn(() => {
			this.fields.body = '';
			this.imageInput.files = [];
		});
	}

	querySelector(selector) {
		if (selector === '[data-comment-feedback]') return this.feedback;
		if (selector === 'button[type="submit"]') return this.submitButton;
		if (selector === '.comment-image-input') return this.imageInput;
		if (selector === '.comment-image-btn') return this.imageButton;
		if (selector === '.image-clear') return this.imageClear;
		if (selector === '.comment-image-name') return this.imageName;
		if (selector === '.comment-image-preview') return this.imagePreview;
		if (selector === '.comment-image-preview img') return this.imagePreviewImage;
		return null;
	}

	async submit() {
		const handler = this.listeners.get('submit');
		const event = { preventDefault: vi.fn() };
		await handler(event);
		return event;
	}
}

class FakeRenderedRoot extends FakeHTMLElement {
	constructor(markup) {
		super();
		this.markup = markup;
		this.innerHTML = markup;
		this.commentsContainer = new FakeCommentsContainer();
		this.commentForm = new FakeCommentForm();
	}

	querySelector(selector) {
		if (selector === '[data-comments]') return this.commentsContainer;
		if (selector === '#comment-form') return this.commentForm;
		return null;
	}
}

class FakePlaceholderRoot extends FakeHTMLElement {
	constructor(documentRef) {
		super();
		this.documentRef = documentRef;
		this.innerHTML = '';
		this._outerHTML = '';
	}

	set outerHTML(markup) {
		this._outerHTML = markup;
		this.documentRef.currentRoot = new FakeRenderedRoot(markup);
	}

	get outerHTML() {
		return this._outerHTML;
	}
}

class FakeCategoryInput extends FakeHTMLInputElement {
	constructor(value) {
		super();
		this.type = 'checkbox';
		this.value = String(value);
	}
}

class FakeLabel extends FakeHTMLElement {
	constructor() {
		super();
		this.children = [];
		this.className = '';
	}

	appendChild(child) {
		this.children.push(child);
		child.parentNode = this;
		return child;
	}
}

class FakeCategoryHost extends FakeHTMLElement {
	constructor(documentRef) {
		super();
		this.ownerDocument = documentRef;
		this.labels = [];
		this._innerHTML = '';
	}

	set innerHTML(value) {
		this._innerHTML = value;
		if (value === '') {
			this.labels = [];
		}
	}

	get innerHTML() {
		return this._innerHTML;
	}

	appendChild(label) {
		this.labels.push(label);
		label.parentNode = this;
		return label;
	}

	querySelectorAll(selector) {
		if (selector !== 'input[type="checkbox"]:checked') {
			return [];
		}

		return this.labels
			.map((label) => label.children.find((child) => child instanceof FakeCategoryInput))
			.filter((input) => input?.checked);
	}
}

class FakePostForm extends FakeHTMLFormElement {
	constructor(documentRef, mode) {
		super();
		this.mode = mode;
		this.feedback = new FakeFeedbackNode();
		this.titleInput = new FakeHTMLInputElement();
		this.bodyInput = new FakeHTMLTextAreaElement();
		this.imageInput = new FakeImageInput();
		this.imageButton = new FakeButton();
		this.imageName = new FakeHTMLElement();
		this.imagePreview = new FakeHTMLElement();
		this.imagePreviewImage = new FakeHTMLImageElement();
		this.imageClear = new FakeButton();
		this.categoryHost = new FakeCategoryHost(documentRef);
		this.primarySubmit = new FakeSubmitButton(
			mode === 'create-post' ? 'Publish Post' : 'Update Post',
			true,
		);
		this.secondarySubmit =
			mode === 'create-post' ? new FakeSubmitButton('Save Draft', false) : null;
		this.backLink = new FakeHTMLAnchorElement(mode === 'create-post' ? '/' : '/activity');
	}

	querySelector(selector) {
		if (selector === '[data-post-form-feedback]') return this.feedback;
		if (selector === '#title') return this.titleInput;
		if (selector === '#body') return this.bodyInput;
		if (selector === '#image') return this.imageInput;
		if (selector === '#image-button') return this.imageButton;
		if (selector === '#image-name') return this.imageName;
		if (selector === '#image-preview') return this.imagePreview;
		if (selector === '#image-preview img') return this.imagePreviewImage;
		if (selector === '#image-clear') return this.imageClear;
		if (selector === '#categoryCheckboxes') return this.categoryHost;
		if (selector === '.post-editor__back-link') return this.backLink;
		return null;
	}

	querySelectorAll(selector) {
		if (selector !== 'button[type="submit"]') {
			return [];
		}

		return this.secondarySubmit ? [this.secondarySubmit, this.primarySubmit] : [this.primarySubmit];
	}

	async submit({ submitter } = {}) {
		const handler = this.listeners.get('submit');
		const event = { preventDefault: vi.fn(), submitter };
		await handler(event);
		return event;
	}

	async submitDraft() {
		// Mirrors clicking the "Save Draft" button (name="action" value="draft").
		return this.submit({ submitter: { value: 'draft' } });
	}
}

class FakePostFormRoot extends FakeHTMLElement {
	constructor(documentRef, mode) {
		super();
		this.mode = mode;
		this.form = new FakePostForm(documentRef, mode);
	}

	querySelector(selector) {
		if (selector === '#create-post-form' && this.mode === 'create-post') return this.form;
		if (selector === '#edit-post-form' && this.mode === 'edit-post') return this.form;
		return null;
	}
}

function createPostDetailDocument() {
	const documentRef = {
		currentRoot: null,
		querySelector(selector) {
			if (selector === '[data-screen="post-detail"]') {
				return this.currentRoot;
			}
			return null;
		},
	};

	documentRef.currentRoot = new FakePlaceholderRoot(documentRef);
	return documentRef;
}

function createPostFormDocument(mode) {
	const documentRef = {
		root: null,
		querySelector(selector) {
			if (selector === `[data-screen="${mode}"]`) {
				return this.root;
			}
			return null;
		},
		createElement(tagName) {
			if (tagName === 'label') return new FakeLabel();
			if (tagName === 'input') return new FakeCategoryInput('');
			if (tagName === 'span') return new FakeHTMLElement();
			return new FakeHTMLElement();
		},
	};

	documentRef.root = new FakePostFormRoot(documentRef, mode);
	documentRef.root.ownerDocument = documentRef;
	return documentRef;
}

beforeEach(() => {
	createPost?.mockReset();
	createPostComment?.mockReset();
	getPostById?.mockReset();
	getPostComments?.mockReset();
	loadPostCategories?.mockReset();
	loadPostForEdit?.mockReset();
	normalizeCategoryIDs?.mockClear();
	updatePost?.mockReset();
	setupImagePicker?.mockReset();

	globalThis.HTMLElement = FakeHTMLElement;
	globalThis.HTMLFormElement = FakeHTMLFormElement;
	globalThis.HTMLInputElement = FakeHTMLInputElement;
	globalThis.HTMLTextAreaElement = FakeHTMLTextAreaElement;
	globalThis.HTMLButtonElement = FakeHTMLButtonElement;
	globalThis.HTMLAnchorElement = FakeHTMLAnchorElement;
	globalThis.HTMLImageElement = FakeHTMLImageElement;
	globalThis.PopStateEvent = class FakePopStateEvent {
		constructor(type) {
			this.type = type;
		}
	};

	setupImagePicker.mockImplementation((options = {}) => {
		let persistedUrl = null;
		return {
			options,
			getFile: () => options.input?.files?.[0] ?? null,
			clearSelectedFile: vi.fn(() => {
				if (options.input) options.input.files = [];
			}),
			setPersistedUrl: vi.fn((url) => {
				persistedUrl = url;
			}),
			clearPersistedUrl: vi.fn(() => {
				persistedUrl = null;
			}),
			hasAnyImage: () => !!(options.input?.files?.[0] ?? null) || !!persistedUrl,
		};
	});

	globalThis.FormData = class FakeFormData {
		constructor(form) {
			this.form = form;
		}

		get(name) {
			return this.form?.fields?.[name] ?? '';
		}
	};
});

afterEach(() => {
	globalThis.FormData = OriginalFormData;
	globalThis.HTMLElement = OriginalHTMLElement;
	globalThis.HTMLFormElement = OriginalHTMLFormElement;
	globalThis.HTMLInputElement = OriginalHTMLInputElement;
	globalThis.HTMLTextAreaElement = OriginalHTMLTextAreaElement;
	globalThis.HTMLButtonElement = OriginalHTMLButtonElement;
	globalThis.HTMLAnchorElement = OriginalHTMLAnchorElement;
	globalThis.HTMLImageElement = OriginalHTMLImageElement;
	globalThis.PopStateEvent = OriginalPopStateEvent;
});

describe('initPostDetailPage', () => {
	test('fetches post and comments using the URL id and renders comments', async () => {
		const documentRef = createPostDetailDocument();
		const windowRef = { location: { pathname: '/posts/42' } };
		const fetchRef = vi.fn();

		getPostById.mockResolvedValue({
			id: 42,
			title: 'Route hydration',
			body: 'Loaded body',
			username: 'alice',
			created_at: '2026-04-29T09:30:00Z',
			categories: ['SPA'],
		});
		getPostComments.mockResolvedValue([
			{
				id: 9,
				body: 'First reply',
				username: 'bob',
				created_at: '2026-04-29T10:00:00Z',
			},
		]);

		const result = await initPostDetailPage({ windowRef, documentRef, fetchRef });

		expect(getPostById).toHaveBeenCalledWith(fetchRef, '42');
		expect(getPostComments).toHaveBeenCalledWith(fetchRef, '42');
		expect(documentRef.currentRoot.markup).toContain('Route hydration');
		expect(documentRef.currentRoot.commentsContainer.innerHTML).toContain('First reply');
		expect(result).toEqual({
			post: expect.objectContaining({ id: 42, title: 'Route hydration' }),
			comments: [expect.objectContaining({ id: 9, body: 'First reply' })],
		});
	});

	test('renders an error state when the post request fails', async () => {
		const documentRef = createPostDetailDocument();
		const windowRef = { location: { pathname: '/posts/77' } };

		getPostById.mockResolvedValue(null);

		const result = await initPostDetailPage({
			windowRef,
			documentRef,
			fetchRef: vi.fn(),
		});

		expect(documentRef.currentRoot.innerHTML).toContain('Post unavailable');
		expect(documentRef.currentRoot.innerHTML).toContain('Unable to load this post right now.');
		expect(getPostComments).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});

	test('submits a comment, clears the form, and reloads comments', async () => {
		const documentRef = createPostDetailDocument();
		const windowRef = { location: { pathname: '/posts/42' } };
		const fetchRef = vi.fn();

		getPostById.mockResolvedValue({
			id: 42,
			title: 'Route hydration',
			body: 'Loaded body',
			username: 'alice',
			created_at: '2026-04-29T09:30:00Z',
			categories: ['SPA'],
		});
		getPostComments
			.mockResolvedValueOnce([
				{ id: 9, body: 'First reply', username: 'bob', created_at: '2026-04-29T10:00:00Z' },
			])
			.mockResolvedValueOnce([
				{ id: 9, body: 'First reply', username: 'bob', created_at: '2026-04-29T10:00:00Z' },
				{ id: 10, body: 'New reply', username: 'alice', created_at: '2026-04-29T10:05:00Z' },
			]);
		createPostComment.mockResolvedValue({ ok: true, status: 201, data: { id: 10 } });

		await initPostDetailPage({ windowRef, documentRef, fetchRef });

		documentRef.currentRoot.commentForm.fields.body = 'New reply';
		await documentRef.currentRoot.commentForm.submit();

		expect(createPostComment).toHaveBeenCalledWith(fetchRef, '42', {
			body: 'New reply',
			imageFile: null,
		});
		expect(documentRef.currentRoot.commentForm.reset).toHaveBeenCalledTimes(1);
		expect(getPostComments).toHaveBeenCalledTimes(2);
		expect(documentRef.currentRoot.commentsContainer.innerHTML).toContain('New reply');
	});

	test('allows image-only comment submission via the shared picker flow', async () => {
		const documentRef = createPostDetailDocument();
		const windowRef = { location: { pathname: '/posts/42' } };
		const fetchRef = vi.fn();
		const imageFile = { name: 'reply.png', size: 128, type: 'image/png' };
		const clearSelectedFile = vi.fn();

		setupImagePicker.mockReturnValue({
			getFile: () => imageFile,
			clearSelectedFile,
		});

		getPostById.mockResolvedValue({
			id: 42,
			title: 'Route hydration',
			body: 'Loaded body',
			username: 'alice',
			created_at: '2026-04-29T09:30:00Z',
			categories: ['SPA'],
		});
		getPostComments.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				id: 11,
				body: '',
				username: 'alice',
				created_at: '2026-04-29T10:05:00Z',
				image_url: '/static/uploads/comment/reply.png',
			},
		]);
		createPostComment.mockResolvedValue({ ok: true, status: 201, data: { id: 11 } });

		await initPostDetailPage({ windowRef, documentRef, fetchRef });
		await documentRef.currentRoot.commentForm.submit();

		expect(createPostComment).toHaveBeenCalledWith(fetchRef, '42', {
			body: '',
			imageFile,
		});
		expect(clearSelectedFile).toHaveBeenCalledTimes(1);
		expect(documentRef.currentRoot.commentsContainer.innerHTML).toContain(
			'/static/uploads/comment/reply.png',
		);
	});
});

describe('initPostFormPage', () => {
	test('loads categories, initializes the picker, and renders the create form inside the SPA route', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([
			{ id: 3, name: 'General' },
			{ id: 7, name: 'Announcements' },
		]);

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });

		expect(loadPostCategories).toHaveBeenCalledWith(fetchRef);
		expect(documentRef.root.form.categoryHost.labels).toHaveLength(2);
		expect(setupImagePicker).toHaveBeenCalledTimes(1);
		expect(setupImagePicker.mock.calls[0][0]).toEqual(
			expect.objectContaining({
				input: documentRef.root.form.imageInput,
				triggerButton: documentRef.root.form.imageButton,
				clearButton: documentRef.root.form.imageClear,
			}),
		);
	});

	test('prefills edit mode from the post API and keeps logout-compatible SPA navigation hooks', async () => {
		const documentRef = createPostFormDocument('edit-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/edit-post/14', search: '?next=%2Factivity' } };

		loadPostCategories.mockResolvedValue([
			{ id: 3, name: 'General' },
			{ id: 7, name: 'Announcements' },
		]);
		loadPostForEdit.mockResolvedValue({
			ok: true,
			status: 200,
			data: {
				id: 14,
				title: 'Existing title',
				body: 'Existing body',
				category_ids: [7],
				image_url: '/uploads/existing.png',
			},
		});

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });

		expect(loadPostForEdit).toHaveBeenCalledWith(fetchRef, 14);
		expect(documentRef.root.form.titleInput.value).toBe('Existing title');
		expect(documentRef.root.form.bodyInput.value).toBe('Existing body');
		expect(documentRef.root.form.categoryHost.labels).toHaveLength(2);
		expect(documentRef.root.form.categoryHost.labels[1].children[0].checked).toBe(true);
		expect(setupImagePicker.mock.results[0].value.setPersistedUrl).toHaveBeenCalledWith(
			'/uploads/existing.png',
		);
		expect(documentRef.root.form.backLink.href).toBe('/activity');
	});

	test('validates that title is required before create submit', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.bodyInput.value = 'Ready body';
		documentRef.root.form.categoryHost.labels[0].children[0].checked = true;

		await documentRef.root.form.submit();

		expect(createPost).not.toHaveBeenCalled();
		expect(documentRef.root.form.feedback.textContent).toBe('Title is required.');
	});

	test('validates that at least one category is selected before create submit', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Missing category';
		documentRef.root.form.bodyInput.value = 'Ready body';

		await documentRef.root.form.submit();

		expect(createPost).not.toHaveBeenCalled();
		expect(documentRef.root.form.feedback.textContent).toBe('Select at least one category.');
	});

	test('validates that body or image is required before create submit', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Image-less';
		documentRef.root.form.categoryHost.labels[0].children[0].checked = true;

		await documentRef.root.form.submit();

		expect(createPost).not.toHaveBeenCalled();
		expect(documentRef.root.form.feedback.textContent).toBe(
			'Post body is required unless an image is attached.',
		);
	});

	test('submits create flow and navigates inside the SPA after success', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);
		createPost.mockResolvedValue({
			ok: true,
			status: 201,
			data: { id: 88 },
			payload: { data: { id: 88 } },
		});

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Fresh post';
		documentRef.root.form.bodyInput.value = 'Published from SPA';
		documentRef.root.form.categoryHost.labels[0].children[0].checked = true;

		await documentRef.root.form.submit();

		expect(createPost).toHaveBeenCalledWith(fetchRef, {
			title: 'Fresh post',
			body: 'Published from SPA',
			categoryIds: [3],
			imageFile: null,
			imageURL: null,
			status: 'published',
		});
		expect(navigate).toHaveBeenCalledWith('/posts/88');
	});

	test('does not navigate after a create submit resolves on an unmounted form', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };
		let resolveCreate;

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);
		createPost.mockReturnValue(
			new Promise((resolve) => {
				resolveCreate = resolve;
			}),
		);

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Fresh post';
		documentRef.root.form.bodyInput.value = 'Published from SPA';
		documentRef.root.form.categoryHost.labels[0].children[0].checked = true;

		const submitPromise = documentRef.root.form.submit();
		await Promise.resolve();
		documentRef.root.isConnected = false;
		documentRef.root.form.isConnected = false;
		resolveCreate({
			ok: true,
			status: 201,
			data: { id: 88 },
			payload: { data: { id: 88 } },
		});
		await submitPromise;

		expect(navigate).not.toHaveBeenCalled();
		expect(documentRef.root.form.feedback.textContent).not.toBe('Post created.');
	});

	test('saving a draft sends status=draft and navigates to activity inside the SPA', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);
		createPost.mockResolvedValue({
			ok: true,
			status: 201,
			data: { id: 90 },
			payload: { data: { id: 90 } },
		});

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Work in progress';
		documentRef.root.form.bodyInput.value = 'Not ready yet';
		documentRef.root.form.categoryHost.labels[0].children[0].checked = true;

		await documentRef.root.form.submitDraft();

		expect(createPost).toHaveBeenCalledWith(fetchRef, {
			title: 'Work in progress',
			body: 'Not ready yet',
			categoryIds: [3],
			imageFile: null,
			imageURL: null,
			status: 'draft',
		});
		// Drafts live in Activity; navigation stays inside the SPA.
		expect(navigate).toHaveBeenCalledWith('/activity');
		expect(documentRef.root.form.feedback.textContent).toBe('Draft saved.');
	});

	test('saving a draft does not require a category', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);
		createPost.mockResolvedValue({
			ok: true,
			status: 201,
			data: { id: 91 },
			payload: { data: { id: 91 } },
		});

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Just a title';
		documentRef.root.form.bodyInput.value = 'Draft body';
		// No category selected.

		await documentRef.root.form.submitDraft();

		expect(createPost).toHaveBeenCalledWith(
			fetchRef,
			expect.objectContaining({ status: 'draft', categoryIds: [] }),
		);
		expect(navigate).toHaveBeenCalledWith('/activity');
	});

	test('publishing still requires a category even though drafts do not', async () => {
		const documentRef = createPostFormDocument('create-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/create-post', search: '' } };

		loadPostCategories.mockResolvedValue([{ id: 3, name: 'General' }]);

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		documentRef.root.form.titleInput.value = 'Needs a category';
		documentRef.root.form.bodyInput.value = 'Body present';
		// No category selected → publish must be blocked.

		await documentRef.root.form.submit();

		expect(createPost).not.toHaveBeenCalled();
		expect(documentRef.root.form.feedback.textContent).toBe('Select at least one category.');
	});

	test('submits update flow with remove_image after clearing persisted media', async () => {
		const documentRef = createPostFormDocument('edit-post');
		const navigate = vi.fn();
		const fetchRef = vi.fn();
		const windowRef = { location: { pathname: '/edit-post/14', search: '?next=%2Fposts%2F14' } };

		loadPostCategories.mockResolvedValue([{ id: 7, name: 'Announcements' }]);
		loadPostForEdit.mockResolvedValue({
			ok: true,
			status: 200,
			data: {
				id: 14,
				title: 'Existing title',
				body: 'Existing body',
				category_ids: [7],
				image_url: '/uploads/existing.png',
			},
		});
		updatePost.mockResolvedValue({
			ok: true,
			status: 200,
			data: { id: 14 },
			payload: { data: { id: 14 } },
		});

		await initPostFormPage({ windowRef, documentRef, fetchRef, navigate });
		const pickerOptions = setupImagePicker.mock.calls[0][0];
		pickerOptions.onClearPersisted();
		documentRef.root.form.titleInput.value = 'Updated title';
		documentRef.root.form.bodyInput.value = 'Updated body';
		documentRef.root.form.categoryHost.labels[0].children[0].checked = true;

		await documentRef.root.form.submit();

		expect(updatePost).toHaveBeenCalledWith(fetchRef, 14, {
			title: 'Updated title',
			body: 'Updated body',
			categoryIds: [7],
			imageFile: null,
			removeImage: true,
		});
		expect(navigate).toHaveBeenCalledWith('/posts/14');
	});
});
