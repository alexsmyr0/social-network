import { MAX_IMAGE_BYTES } from './utils.js';

export function setupImagePicker({
	input,
	triggerButton,
	clearButton,
	nameLabel,
	previewContainer,
	previewImage,
	persistedUrl = null,
	persistedLabel = '',
	maxBytes = MAX_IMAGE_BYTES,
	onTooLarge = () => {},
	onClearPersisted = () => {},
} = {}) {
	let objectPreviewUrl = null;
	let currentPersistedUrl = normalizeURL(persistedUrl);
	let previewProbeToken = 0;

	const revokeObjectPreview = () => {
		if (!objectPreviewUrl) return;
		URL.revokeObjectURL(objectPreviewUrl);
		objectPreviewUrl = null;
	};

	const getFile = () => input?.files?.[0] || null;

	const clearPreviewCheckerboard = () => {
		if (!previewContainer || !previewImage) return;
		previewContainer.classList.remove('image-preview--checkerboard');
		delete previewImage.dataset.transparent;
	};

	const markPreviewCheckerboard = (hasTransparency) => {
		if (!previewContainer || !previewImage) return;
		previewContainer.classList.toggle('image-preview--checkerboard', hasTransparency);
		previewImage.dataset.transparent = hasTransparency ? 'true' : 'false';
	};

	const probePreviewTransparency = ({ file = null, src = '' } = {}) => {
		if (!previewContainer || !previewImage || !src) return;
		const token = ++previewProbeToken;
		clearPreviewCheckerboard();
		detectTransparentPng(previewImage, { file, src })
			.then((hasTransparency) => {
				if (token !== previewProbeToken) return;
				markPreviewCheckerboard(hasTransparency);
			})
			.catch(() => {
				if (token !== previewProbeToken) return;
				markPreviewCheckerboard(false);
			});
	};

	const updateClearButton = (file) => {
		if (!clearButton) return;
		clearButton.hidden = !file && !currentPersistedUrl;
	};

	const updateNameLabel = (file) => {
		if (!nameLabel) return;
		if (file) {
			nameLabel.textContent = `Selected: ${file.name}`;
			return;
		}
		if (currentPersistedUrl && persistedLabel) {
			nameLabel.textContent = persistedLabel;
			return;
		}
		nameLabel.textContent = '';
	};

	const updatePreview = (file) => {
		if (!previewContainer || !previewImage) {
			revokeObjectPreview();
			return;
		}

		revokeObjectPreview();
		previewProbeToken += 1;
		clearPreviewCheckerboard();

		if (file) {
			objectPreviewUrl = URL.createObjectURL(file);
			previewImage.src = objectPreviewUrl;
			previewContainer.hidden = false;
			probePreviewTransparency({ file, src: objectPreviewUrl });
			return;
		}

		if (currentPersistedUrl) {
			previewImage.src = currentPersistedUrl;
			previewContainer.hidden = false;
			probePreviewTransparency({ src: currentPersistedUrl });
			return;
		}

		previewImage.removeAttribute('src');
		previewContainer.hidden = true;
	};

	const updateUI = () => {
		const file = getFile();
		updateClearButton(file);
		updateNameLabel(file);
		updatePreview(file);
	};

	const onInputChange = () => {
		const file = getFile();
		if (file && file.size > maxBytes) {
			if (input) input.value = '';
			onTooLarge(file, maxBytes);
		}
		updateUI();
	};

	const onTriggerClick = () => input?.click();

	const onClearClick = () => {
		const file = getFile();
		if (file && input) {
			input.value = '';
			updateUI();
			return;
		}

		if (currentPersistedUrl) {
			currentPersistedUrl = null;
			onClearPersisted();
			updateUI();
		}
	};

	triggerButton?.addEventListener('click', onTriggerClick);
	input?.addEventListener('change', onInputChange);
	clearButton?.addEventListener('click', onClearClick);

	updateUI();

	return {
		getFile,
		clearSelectedFile() {
			if (input) input.value = '';
			updateUI();
		},
		setPersistedUrl(url) {
			currentPersistedUrl = normalizeURL(url);
			updateUI();
		},
		clearPersistedUrl() {
			currentPersistedUrl = null;
			updateUI();
		},
		hasAnyImage() {
			return !!getFile() || !!currentPersistedUrl;
		},
		destroy() {
			triggerButton?.removeEventListener('click', onTriggerClick);
			input?.removeEventListener('change', onInputChange);
			clearButton?.removeEventListener('click', onClearClick);
			revokeObjectPreview();
		},
	};
}

function normalizeURL(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function isPngSource(src) {
	if (!src) return false;
	try {
		const parsed = new URL(src, window.location.href);
		return parsed.pathname.toLowerCase().endsWith('.png');
	} catch {
		return src.split('?')[0].toLowerCase().endsWith('.png');
	}
}

function isPngCandidate(file, src) {
	if (file?.type) return file.type.toLowerCase() === 'image/png';
	return isPngSource(src);
}

function waitForImageReady(imgEl) {
	if (!(imgEl instanceof HTMLImageElement)) return Promise.resolve(false);
	if (imgEl.complete && imgEl.naturalWidth && imgEl.naturalHeight) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const onLoad = () => {
			cleanup();
			resolve(true);
		};
		const onError = () => {
			cleanup();
			resolve(false);
		};
		const cleanup = () => {
			imgEl.removeEventListener('load', onLoad);
			imgEl.removeEventListener('error', onError);
		};
		imgEl.addEventListener('load', onLoad, { once: true });
		imgEl.addEventListener('error', onError, { once: true });
	});
}

async function detectTransparentPng(imgEl, { file = null, src = '' } = {}) {
	if (!isPngCandidate(file, src)) return false;
	const ready = await waitForImageReady(imgEl);
	if (!ready || !imgEl.naturalWidth || !imgEl.naturalHeight) return false;

	try {
		const sampleWidth = Math.min(80, imgEl.naturalWidth);
		const sampleHeight = Math.min(80, imgEl.naturalHeight);
		const canvas = document.createElement('canvas');
		canvas.width = sampleWidth;
		canvas.height = sampleHeight;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return false;

		ctx.drawImage(imgEl, 0, 0, sampleWidth, sampleHeight);
		const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
		for (let i = 3; i < data.length; i += 4) {
			if (data[i] < 250) return true;
		}
	} catch {
		return false;
	}

	return false;
}
