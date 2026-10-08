import { reactive } from 'vue';

import {
	CATEGORY_MAX,
	fieldMessage,
	imageProblem,
	normalizeText,
	normalizeTitle,
	SELECTION_MAX,
	sameIds,
	sortedIds,
	textProblem,
} from './content-utils.js';

// One editable post. `image` is a freshly chosen File; `existingImageUrl` is
// the stored attachment, kept unless the author removes or replaces it.
export function createPostForm() {
	return reactive({
		title: '',
		body: '',
		categoryIds: [],
		audience: 'public',
		selectedIds: [],
		image: null,
		imagePreview: '',
		existingImageUrl: null,
		removeImage: false,
		errors: {},
		alert: '',
	});
}

export function clearImageChoice(form) {
	if (form.imagePreview) URL.revokeObjectURL(form.imagePreview);
	form.image = null;
	form.imagePreview = '';
}

export function chooseImage(form, file) {
	clearImageChoice(form);
	delete form.errors.image;
	const problem = imageProblem(file);
	if (problem) {
		form.errors.image = problem;
		return false;
	}
	form.image = file;
	form.imagePreview = URL.createObjectURL(file);
	form.removeImage = false;
	return true;
}

// Replaces every input with the server's copy. Used on first load and after
// a confirmed save, never while the author still has unsaved edits.
export function seedForm(form, post) {
	clearImageChoice(form);
	form.title = post.title ?? '';
	form.body = post.body;
	form.categoryIds = post.categories
		? post.categories.map((category) => category.id)
		: [...(post.category_ids ?? [])];
	form.audience = post.audience;
	form.selectedIds = sortedIds(post.selected_follower_ids ?? []);
	form.existingImageUrl = post.image_url;
	form.removeImage = false;
	form.errors = {};
	form.alert = '';
}

export function resetForm(form) {
	seedForm(form, {
		title: null,
		body: '',
		category_ids: [],
		audience: 'public',
		selected_follower_ids: [],
		image_url: null,
	});
}

function keepsImage(form) {
	return Boolean(form.image || (form.existingImageUrl && !form.removeImage));
}

// Selected people the author can no longer address: they stopped following
// (or never did). They stay visible until removed so the server never has to
// silently drop them, and publishing is blocked meanwhile.
export function lostRecipients(form, eligibleIds) {
	if (form.audience !== 'selected' || !eligibleIds) return [];
	const eligible = new Set(eligibleIds);
	return form.selectedIds.filter((id) => !eligible.has(id));
}

function selectionProblem(form, { publishing, eligibleIds }) {
	if (form.selectedIds.length > SELECTION_MAX) return fieldMessage('', 'TOO_MANY');
	if (form.audience !== 'selected') return '';
	if (lostRecipients(form, eligibleIds).length > 0) {
		return 'Remove the people who no longer follow you before saving this audience.';
	}
	if (publishing && form.selectedIds.length === 0) {
		return 'Choose at least one follower to publish to Selected followers.';
	}
	return '';
}

// Client checks mirror the contract so common mistakes are caught before a
// request; the server remains the authority and its field errors still apply.
// `publishing` is a transition to published (it needs recipients for a
// Selected audience); `requireContent` covers any edit that stays visible.
export function validateForm(form, { publishing, requireContent = publishing, eligibleIds }) {
	const errors = {};
	for (const field of ['title', 'body']) {
		const problem = textProblem(field, form[field]);
		if (problem) errors[field] = fieldMessage(field, problem);
	}
	if (form.categoryIds.length > CATEGORY_MAX) errors.category_ids = fieldMessage('', 'TOO_MANY');
	if (requireContent && !errors.body && normalizeText(form.body) === '' && !keepsImage(form)) {
		errors.body = fieldMessage('body', 'CONTENT_REQUIRED');
	}
	const selection = selectionProblem(form, { publishing, eligibleIds });
	if (selection) errors.selected_follower_ids = selection;
	// A rejected image choice stays explained but does not block saving the
	// rest of the post without it.
	const imageError = form.image ? null : form.errors.image;
	form.errors = imageError ? { ...errors, image: imageError } : errors;
	return Object.keys(errors).length === 0;
}

function audienceFields(form) {
	const fields = { audience: form.audience };
	if (form.audience === 'selected') fields.selectedFollowerIds = sortedIds(form.selectedIds);
	return fields;
}

// A new post or draft sends only what the author supplied; defaults (public,
// no title, no categories) are left to the server.
export function createFields(form) {
	const fields = { body: normalizeText(form.body) };
	const title = normalizeTitle(form.title);
	if (title !== null) fields.title = title;
	if (form.categoryIds.length > 0) fields.categoryIds = sortedIds(form.categoryIds);
	if (form.audience !== 'public') Object.assign(fields, audienceFields(form));
	if (form.image) fields.image = form.image;
	return fields;
}

// Partial edit: only fields that differ from the snapshot the form was based
// on. Omitted fields keep their stored values; staying on Selected followers
// without a selection change keeps the current grants.
export function changeFields(form, base) {
	const fields = {};
	const title = normalizeTitle(form.title);
	if (title !== base.title) fields.title = title;
	const body = normalizeText(form.body);
	if (body !== base.body) fields.body = body;
	const baseCategories = base.categories.map((category) => category.id);
	if (!sameIds(form.categoryIds, baseCategories)) fields.categoryIds = sortedIds(form.categoryIds);
	if (form.image) fields.image = form.image;
	else if (form.removeImage && base.image_url) fields.removeImage = true;
	if (form.audience !== base.audience) Object.assign(fields, audienceFields(form));
	else if (
		form.audience === 'selected' &&
		!sameIds(form.selectedIds, base.selected_follower_ids ?? [])
	) {
		fields.selectedFollowerIds = sortedIds(form.selectedIds);
	}
	return fields;
}

// After a version conflict the form moves onto the latest snapshot while
// keeping the author's unsaved edits. Recipients the server removed meanwhile
// (an unfollow) stay removed: a stale form never restores a revoked grant,
// and a refollowed person must be chosen again explicitly.
export function rebaseForm(form, base, latest) {
	const untouched = (field) => normalizeText(form[field]) === normalizeText(base[field] ?? '');
	if (untouched('title')) form.title = latest.title ?? '';
	if (untouched('body')) form.body = latest.body;
	const categoryIds = (post) => post.categories.map((category) => category.id);
	if (sameIds(form.categoryIds, categoryIds(base))) form.categoryIds = categoryIds(latest);
	// A fresh image choice or a pending removal stays; otherwise the stored
	// attachment follows the server.
	form.existingImageUrl = latest.image_url;
	if (!latest.image_url) form.removeImage = false;
	const before = base.selected_follower_ids ?? [];
	const now = latest.selected_follower_ids ?? [];
	if (form.audience === base.audience && sameIds(form.selectedIds, before)) {
		form.audience = latest.audience;
		form.selectedIds = sortedIds(now);
		return;
	}
	const removed = new Set(before.filter((id) => !now.includes(id)));
	form.selectedIds = form.selectedIds.filter((id) => !removed.has(id));
}

// Maps a rejected write onto the form. Inputs are never cleared, except a
// rejected fresh image, which cannot be retried as-is.
export function applyFailure(form, result) {
	if (result.status === 'invalid-image' || (result.status === 'too-large' && form.image)) {
		clearImageChoice(form);
		form.errors = {
			...form.errors,
			image:
				result.status === 'too-large'
					? 'That image is too large. Images can be up to 5 MiB.'
					: fieldMessage('image', 'INVALID_IMAGE'),
		};
		form.alert = 'The image couldn’t be uploaded. Your text and choices are still here.';
		return;
	}
	if (result.status === 'too-large') {
		form.alert = 'This post is too large to send. Shorten it and try again.';
		return;
	}
	const errors = {};
	for (const [field, code] of Object.entries(result.fields ?? {})) {
		errors[field] = fieldMessage(field, code);
	}
	form.errors = errors;
	form.alert =
		Object.keys(errors).length > 0
			? 'Some details need attention. Your inputs are still here.'
			: 'That request was rejected. Reload the page and try again.';
}
