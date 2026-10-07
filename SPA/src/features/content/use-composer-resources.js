import { computed } from 'vue';

import { useSocialResource } from '../social/use-social-resource.js';

const FOLLOWER_PAGE_SIZE = 50;
// The contract allows at most 500 selected followers, so ten full pages cover
// every follower who could be chosen.
const FOLLOWER_PAGES = 10;

async function loadFollowers(api, userId) {
	const seen = new Map();
	for (let page = 1; page <= FOLLOWER_PAGES; page += 1) {
		const result = await api.fetchFollowers(userId, { page, perPage: FOLLOWER_PAGE_SIZE });
		if (result.status !== 'ok') return result;
		for (const person of result.people) {
			seen.set(person.id, {
				id: person.id,
				display_name: person.display_name,
				avatar_url: person.access === 'full' ? person.avatar_url : null,
			});
		}
		if (page >= result.pagination.total_pages) break;
	}
	return { status: 'ok', followers: [...seen.values()] };
}

// Inputs the composer needs besides the post itself: category metadata, the
// author's current accepted followers (the only eligible recipients) and
// their profile visibility, which limits who a Public post reaches. All are
// the viewer's own data, so invalidations refresh them without blanking the
// form; a session change or failed read still discards them.
export function useComposerResources({ social, content, session }) {
	const accountId = () => session.state.account?.id;
	const categories = useSocialResource(() => content.api.fetchCategories(), {
		social,
		retain: true,
	});
	const followers = useSocialResource(() => loadFollowers(social.api, accountId()), {
		social,
		retain: true,
	});
	const profile = useSocialResource(() => social.api.fetchProfile(accountId()), {
		social,
		retain: true,
	});

	return {
		categories: computed(() => ({
			status: categories.status.value,
			list: categories.result.value?.categories ?? [],
			reload: categories.reload,
		})),
		followers: computed(() => ({
			status: followers.status.value,
			list: followers.result.value?.followers ?? [],
			reload: followers.reload,
		})),
		eligibleIds: computed(() =>
			followers.status.value === 'ready'
				? followers.result.value.followers.map((person) => person.id)
				: null,
		),
		visibility: computed(() => {
			const subject = profile.result.value?.profile;
			return subject?.access === 'full' ? subject.profile.visibility : null;
		}),
	};
}
