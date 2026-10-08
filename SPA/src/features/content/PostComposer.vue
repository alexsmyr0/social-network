<script setup>
import { computed, onUnmounted, ref } from 'vue';

// biome-ignore lint/correctness/noUnusedImports: registered through the Vue template
import SocialAvatar from '../social/SocialAvatar.vue';
// biome-ignore lint/correctness/noUnusedImports: used by the Vue template
import { BODY_MAX, codePoints, IMAGE_TYPES, TITLE_MAX } from './content-utils.js';
import { chooseImage, clearImageChoice, lostRecipients } from './post-form.js';

const props = defineProps({
	form: { type: Object, required: true },
	categories: { type: Object, required: true },
	followers: { type: Object, required: true },
	eligibleIds: { type: Array, default: null },
	visibility: { type: String, default: null },
	disabled: { type: Boolean, default: false },
	idPrefix: { type: String, default: 'post' },
});

const imageInput = ref(null);
const recipientFilter = ref('');
const id = (name) => `${props.idPrefix}-${name}`;
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const accept = IMAGE_TYPES.join(',');

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const titleCount = computed(() => codePoints(props.form.title));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const bodyCount = computed(() => codePoints(props.form.body));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const audiences = [
	{
		value: 'public',
		label: 'Public',
		hint: 'Default. Anyone who can see your profile can read it.',
	},
	{ value: 'followers', label: 'Followers', hint: 'Only people who follow you.' },
	{
		value: 'selected',
		label: 'Selected followers',
		hint: 'Only the followers you choose below.',
	},
];

// The audience never broadens profile privacy; say so where it matters.
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const privacyNote = computed(() =>
	props.visibility === 'private' && props.form.audience === 'public'
		? 'Your profile is private, so even a Public post is visible only to your accepted followers.'
		: '',
);

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const lost = computed(() => lostRecipients(props.form, props.eligibleIds));
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const visibleFollowers = computed(() => {
	const needle = recipientFilter.value.trim().toLocaleLowerCase();
	return props.followers.list.filter((person) =>
		person.display_name.toLocaleLowerCase().includes(needle),
	);
});
// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
const selectionSummary = computed(() => {
	const count = props.form.selectedIds.length;
	return count === 1 ? '1 follower selected' : `${count} followers selected`;
});

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function errorId(field) {
	return props.form.errors[field] ? id(`${field}-error`) : undefined;
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function describedBy(...ids) {
	return ids.filter(Boolean).join(' ') || undefined;
}

function resetInput() {
	if (imageInput.value) imageInput.value.value = '';
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function onImage(event) {
	const [file] = event.target.files;
	if (!file) return;
	if (!chooseImage(props.form, file)) resetInput();
}

function discardChoice() {
	clearImageChoice(props.form);
	delete props.form.errors.image;
	resetInput();
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function removeStored() {
	discardChoice();
	props.form.removeImage = true;
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function keepStored() {
	props.form.removeImage = false;
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function toggle(list, value, checked) {
	const next = props.form[list].filter((item) => item !== value);
	if (checked) next.push(value);
	props.form[list] = next;
}

// biome-ignore lint/correctness/noUnusedVariables: consumed by the Vue template
function dropRecipient(personId) {
	props.form.selectedIds = props.form.selectedIds.filter((item) => item !== personId);
}

onUnmounted(() => clearImageChoice(props.form));
</script>

<template>
	<div class="composer" :aria-disabled="disabled">
		<div class="form-field composer__field" :class="{ 'form-field--error': form.errors.title }">
			<label :for="id('title')">Title <span class="composer__optional">Optional</span></label>
			<input
				:id="id('title')"
				v-model="form.title"
				name="title"
				type="text"
				autocomplete="off"
				:aria-invalid="Boolean(form.errors.title)"
				:aria-describedby="describedBy(id('title-count'), errorId('title'))"
			/>
			<p :id="id('title-count')" class="field-hint composer__count">{{ titleCount }} / {{ TITLE_MAX }}</p>
			<p v-if="form.errors.title" :id="id('title-error')" class="field-error">{{ form.errors.title }}</p>
		</div>

		<div class="form-field composer__field" :class="{ 'form-field--error': form.errors.body }">
			<label :for="id('body')">Post</label>
			<textarea
				:id="id('body')"
				v-model="form.body"
				name="body"
				rows="6"
				:aria-invalid="Boolean(form.errors.body)"
				:aria-describedby="describedBy(id('body-hint'), errorId('body'))"
			></textarea>
			<p :id="id('body-hint')" class="field-hint composer__count">
				Text, an image or both · {{ bodyCount.toLocaleString('en-GB') }} / {{ BODY_MAX.toLocaleString('en-GB') }}
			</p>
			<p v-if="form.errors.body" :id="id('body-error')" class="field-error">{{ form.errors.body }}</p>
		</div>

		<div class="composer__image" :class="{ 'form-field--error': form.errors.image }">
			<p class="composer__label" :id="id('image-label')">Image <span class="composer__optional">Optional</span></p>
			<figure v-if="form.imagePreview" class="composer__preview">
				<img :src="form.imagePreview" alt="Preview of the image you chose" />
				<figcaption>{{ form.existingImageUrl ? 'Replaces the current image when you save' : 'New image' }}</figcaption>
			</figure>
			<figure v-else-if="form.existingImageUrl && !form.removeImage" class="composer__preview">
				<img :src="form.existingImageUrl" alt="Current image attached to this post" />
				<figcaption>Current image</figcaption>
			</figure>
			<p v-else-if="form.existingImageUrl && form.removeImage" class="composer__notice" role="status">
				The current image will be removed when you save.
			</p>
			<div class="composer__image-actions">
				<input
					:id="id('image')"
					ref="imageInput"
					class="visually-hidden file-input"
					name="image"
					type="file"
					:accept="accept"
					:aria-describedby="describedBy(id('image-hint'), errorId('image'))"
					:aria-invalid="Boolean(form.errors.image)"
					@change="onImage"
				/>
				<label class="file-button" :for="id('image')">
					{{ form.image || (form.existingImageUrl && !form.removeImage) ? 'Replace image' : 'Add an image' }}
				</label>
				<button v-if="form.image" class="text-button" type="button" @click="discardChoice">
					{{ form.existingImageUrl ? 'Keep the current image instead' : 'Remove selected image' }}
				</button>
				<button v-else-if="form.existingImageUrl && !form.removeImage" class="text-button" type="button" @click="removeStored">Remove image</button>
				<button v-else-if="form.existingImageUrl && form.removeImage" class="text-button" type="button" @click="keepStored">Keep the current image</button>
			</div>
			<p :id="id('image-hint')" class="field-hint">JPEG, PNG or GIF · up to 5 MiB</p>
			<p v-if="form.errors.image" :id="id('image-error')" class="field-error" role="alert">{{ form.errors.image }}</p>
		</div>

		<fieldset class="composer__group" :class="{ 'form-field--error': form.errors.category_ids }">
			<legend>Categories <span class="composer__optional">Optional</span></legend>
			<p v-if="categories.status === 'loading' && categories.list.length === 0" class="field-hint" role="status">Loading categories…</p>
			<p v-else-if="categories.status === 'unavailable'" class="field-hint">
				Categories can’t be loaded right now.
				<button class="text-button" type="button" @click="categories.reload('hard')">Try again</button>
			</p>
			<p v-else-if="categories.list.length === 0" class="field-hint">No categories are available.</p>
			<ul v-else class="composer__chips">
				<li v-for="category in categories.list" :key="category.id">
					<label class="choice-chip">
						<input
							type="checkbox"
							name="category_ids"
							:value="category.id"
							:checked="form.categoryIds.includes(category.id)"
							@change="toggle('categoryIds', category.id, $event.target.checked)"
						/>
						<span>{{ category.name }}</span>
					</label>
				</li>
			</ul>
			<p v-if="form.errors.category_ids" class="field-error">{{ form.errors.category_ids }}</p>
		</fieldset>

		<fieldset class="composer__group composer__audience" :class="{ 'form-field--error': form.errors.audience }">
			<legend>Who can see this</legend>
			<div class="audience-options">
				<label v-for="option in audiences" :key="option.value" class="audience-option" :data-audience="option.value">
					<input v-model="form.audience" type="radio" :name="id('audience')" :value="option.value" />
					<span class="audience-option__copy">
						<strong>{{ option.label }}</strong>
						<span>{{ option.hint }}</span>
					</span>
				</label>
			</div>
			<p v-if="privacyNote" class="composer__notice" data-privacy-note>{{ privacyNote }}</p>
			<p v-if="form.errors.audience" class="field-error">{{ form.errors.audience }}</p>

			<div v-if="form.audience === 'selected'" class="recipient-picker" :class="{ 'form-field--error': form.errors.selected_follower_ids }">
				<p class="recipient-picker__summary" role="status">{{ selectionSummary }}</p>

				<div v-if="lost.length" class="recipient-picker__lost" data-lost-recipients>
					<p>These people no longer follow you and can’t receive this post:</p>
					<ul>
						<li v-for="personId in lost" :key="personId">
							<span>Former follower #{{ personId }}</span>
							<button class="text-button" type="button" @click="dropRecipient(personId)">Remove</button>
						</li>
					</ul>
				</div>

				<p v-if="followers.status === 'loading' && followers.list.length === 0" class="field-hint" role="status">Loading your followers…</p>
				<p v-else-if="followers.status === 'unavailable'" class="field-hint">
					Your followers can’t be loaded right now.
					<button class="text-button" type="button" @click="followers.reload('hard')">Try again</button>
				</p>
				<p v-else-if="followers.list.length === 0" class="field-hint">
					No one follows you yet. You can save this as a draft and choose recipients later.
				</p>
				<template v-else>
					<label class="recipient-picker__filter" :for="id('recipient-filter')">Find a follower</label>
					<input :id="id('recipient-filter')" v-model="recipientFilter" class="recipient-picker__search" type="search" autocomplete="off" />
					<ul class="recipient-picker__list" aria-label="Your followers">
						<li v-for="person in visibleFollowers" :key="person.id">
							<label class="recipient">
								<input
									type="checkbox"
									name="selected_follower_ids"
									:value="person.id"
									:checked="form.selectedIds.includes(person.id)"
									@change="toggle('selectedIds', person.id, $event.target.checked)"
								/>
								<SocialAvatar :name="person.display_name" :src="person.avatar_url" size="sm" />
								<span class="recipient__name">{{ person.display_name }}</span>
							</label>
						</li>
					</ul>
					<p v-if="visibleFollowers.length === 0" class="field-hint">No follower matches that name.</p>
					<p v-if="!followers.complete" class="field-hint" data-followers-truncated>
						Showing your first {{ followers.list.length }} followers. Anyone you already chose who isn’t listed stays selected.
					</p>
				</template>
				<p v-if="form.errors.selected_follower_ids" class="field-error" role="alert">{{ form.errors.selected_follower_ids }}</p>
			</div>
		</fieldset>
	</div>
</template>
