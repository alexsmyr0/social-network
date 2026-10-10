import { inject, nextTick, provide, ref, watch } from 'vue';

const feedbackKey = Symbol('commonplace-group-feedback');

// One stable live region per group screen. Membership writes discard and
// refetch the lists that hold their buttons, so a button's component may be
// gone by the time its write resolves (and its events would be dropped).
// Outcomes are therefore reported through this provided function, and focus
// moves to the region instead of to a control that no longer exists. Only a
// confirmed success is ever worded as one.
export function useGroupFeedback(session) {
	const feedback = ref(null);
	const region = ref(null);

	function clear() {
		feedback.value = null;
	}

	if (session) watch(() => session.state.account?.id ?? null, clear);

	async function report({ outcome, success }) {
		if (['superseded', 'unauthenticated', 'busy'].includes(outcome.status)) return;
		feedback.value =
			outcome.status === 'ok'
				? { tone: 'success', text: success }
				: { tone: 'error', text: outcome.message };
		await nextTick();
		region.value?.focus();
	}

	provide(feedbackKey, report);
	return { feedback, region, report, clear };
}

// For controls inside a group screen; outside one, outcomes are ignored.
export function useGroupReporter() {
	return inject(feedbackKey, () => {});
}
