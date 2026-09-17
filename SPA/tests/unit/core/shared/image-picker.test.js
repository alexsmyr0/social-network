import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setupImagePicker } from '../../../../core/shared/image-picker.js';

// Minimal DOM element stub covering the surface setupImagePicker touches.
function createElement(tag = 'div') {
	const listeners = new Map();
	return {
		tag,
		hidden: false,
		textContent: '',
		files: [],
		dataset: {},
		_value: '',
		// A real <input type="file"> clears its FileList when value is reset to ''.
		get value() {
			return this._value;
		},
		set value(v) {
			this._value = v;
			if (!v) this.files = [];
		},
		_src: undefined,
		classList: {
			_set: new Set(),
			add(c) {
				this._set.add(c);
			},
			remove(c) {
				this._set.delete(c);
			},
			toggle(c, force) {
				const on = force ?? !this._set.has(c);
				if (on) this._set.add(c);
				else this._set.delete(c);
				return on;
			},
			contains(c) {
				return this._set.has(c);
			},
		},
		set src(v) {
			this._src = v;
		},
		get src() {
			return this._src;
		},
		removeAttribute() {
			this._src = undefined;
		},
		click: vi.fn(),
		addEventListener(type, fn) {
			listeners.set(type, fn);
		},
		removeEventListener(type) {
			listeners.delete(type);
		},
		dispatch(type) {
			listeners.get(type)?.();
		},
		hasListener(type) {
			return listeners.has(type);
		},
	};
}

function imageFile(name = 'photo.jpg', size = 1000, type = 'image/jpeg') {
	return { name, size, type };
}

function setup(overrides = {}) {
	const input = createElement('input');
	const triggerButton = createElement('button');
	const clearButton = createElement('button');
	const nameLabel = createElement('span');
	const previewContainer = createElement('div');
	const previewImage = createElement('img');

	const controller = setupImagePicker({
		input,
		triggerButton,
		clearButton,
		nameLabel,
		previewContainer,
		previewImage,
		...overrides,
	});

	return {
		controller,
		input,
		triggerButton,
		clearButton,
		nameLabel,
		previewContainer,
		previewImage,
	};
}

beforeEach(() => {
	globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
	globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('setupImagePicker', () => {
	test('opens the native file dialog when the trigger button is clicked', () => {
		const { input, triggerButton } = setup();
		triggerButton.dispatch('click');
		expect(input.click).toHaveBeenCalled();
	});

	test('shows the file name, preview, and clear control after a file is selected', () => {
		const { input, nameLabel, clearButton, previewContainer, previewImage } = setup();

		input.files = [imageFile('cat.jpg')];
		input.dispatch('change');

		expect(nameLabel.textContent).toBe('Selected: cat.jpg');
		expect(clearButton.hidden).toBe(false);
		expect(previewContainer.hidden).toBe(false);
		expect(previewImage.src).toBe('blob:preview');
		expect(URL.createObjectURL).toHaveBeenCalled();
	});

	test('rejects oversized files, clears the input, and invokes onTooLarge', () => {
		const onTooLarge = vi.fn();
		const { input } = setup({ maxBytes: 500, onTooLarge });

		const big = imageFile('huge.jpg', 5000);
		input.files = [big];
		input.dispatch('change');

		expect(onTooLarge).toHaveBeenCalledWith(big, 500);
		expect(input.value).toBe('');
	});

	test('clearing a selected file resets the input and hides the preview', () => {
		const { input, clearButton, previewContainer, nameLabel } = setup();

		input.files = [imageFile()];
		input.dispatch('change');
		expect(previewContainer.hidden).toBe(false);

		// Click clear while the file is still selected — the picker resets input.value,
		// which (like a real browser) empties the FileList.
		clearButton.dispatch('click');

		expect(input.value).toBe('');
		expect(previewContainer.hidden).toBe(true);
		expect(nameLabel.textContent).toBe('');
	});

	test('renders a persisted image (edit mode) and surfaces it via hasAnyImage', () => {
		const { controller, previewContainer, previewImage, clearButton } = setup({
			persistedUrl: '/uploads/existing.jpg',
			persistedLabel: 'Current image',
		});

		expect(previewContainer.hidden).toBe(false);
		expect(previewImage.src).toBe('/uploads/existing.jpg');
		expect(clearButton.hidden).toBe(false);
		expect(controller.hasAnyImage()).toBe(true);
	});

	test('clearing a persisted image fires onClearPersisted and empties the picker', () => {
		const onClearPersisted = vi.fn();
		const { controller, clearButton, previewContainer } = setup({
			persistedUrl: '/uploads/existing.jpg',
			persistedLabel: 'Current image',
			onClearPersisted,
		});

		clearButton.dispatch('click');

		expect(onClearPersisted).toHaveBeenCalled();
		expect(previewContainer.hidden).toBe(true);
		expect(controller.hasAnyImage()).toBe(false);
	});

	test('getFile returns the selected file and destroy detaches all listeners', () => {
		const { controller, input, triggerButton, clearButton } = setup();

		const file = imageFile();
		input.files = [file];
		expect(controller.getFile()).toBe(file);

		controller.destroy();

		expect(input.hasListener('change')).toBe(false);
		expect(triggerButton.hasListener('click')).toBe(false);
		expect(clearButton.hasListener('click')).toBe(false);
	});
});
