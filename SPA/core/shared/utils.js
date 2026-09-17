export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_ACCEPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif'];
export const IMAGE_ACCEPT_ATTR = IMAGE_ACCEPT_MIME_TYPES.join(',');

export function buildImageRequestOptions({
	method = 'POST',
	credentials = 'include',
	imageFile = null,
	buildMultipartBody = () => null,
	jsonBody = {},
	multipartHeaders = {},
	jsonHeaders = {},
} = {}) {
	const hasImage = !!imageFile;
	const options = { method, credentials };

	if (hasImage) {
		options.body = buildMultipartBody(imageFile);
		if (multipartHeaders && Object.keys(multipartHeaders).length > 0) {
			options.headers = multipartHeaders;
		}
		return options;
	}

	options.headers = {
		'Content-Type': 'application/json',
		...jsonHeaders,
	};
	options.body = JSON.stringify(jsonBody);
	return options;
}

export function buildPostMultipartFormData({
	title = '',
	body = '',
	categoryIds = [],
	imageFile = null,
	manual,
	imageURL = null,
	removeImage = false,
	status = null,
} = {}) {
	const formData = new FormData();

	formData.append('title', title);
	formData.append('body', body);

	if (typeof status === 'string' && status) {
		formData.append('status', status);
	}

	for (const id of categoryIds) {
		formData.append('category_ids', String(id));
	}

	if (imageFile) {
		formData.append('image', imageFile);
	}

	if (typeof manual !== 'undefined') {
		formData.append('manual', String(Boolean(manual)));
	}

	if (typeof imageURL === 'string' && imageURL.trim()) {
		formData.append('image_url', imageURL.trim());
	}

	if (removeImage) {
		formData.append('remove_image', 'true');
	}

	return formData;
}
