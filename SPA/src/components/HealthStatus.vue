<script setup>
defineProps({
	state: {
		type: String,
		required: true,
		validator: (value) => ['loading', 'online', 'error'].includes(value),
	},
	message: {
		type: String,
		required: true,
	},
});

defineEmits(['retry']);
</script>

<template>
	<div class="health-status" :class="`health-status--${state}`">
		<span class="health-status__signal" aria-hidden="true"></span>
		<span class="health-status__copy" :role="state === 'error' ? 'alert' : 'status'">
			<span class="health-status__label">System link</span>
			<span>{{ message }}</span>
		</span>
		<button
			v-if="state === 'error'"
			class="health-status__retry"
			type="button"
			@click="$emit('retry')"
		>
			Retry
		</button>
	</div>
</template>
