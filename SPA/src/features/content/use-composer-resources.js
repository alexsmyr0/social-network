import { computed } from 'vue';

import { useSocialResource } from '../social/use-social-resource.js';

const FOLLOWER_PAGE_SIZE = 50;
// The picker loads at most ten pages (500 followers) per visit. Followers can
// outnumber that, so a longer list is marked incomplete and recipients it
// does not show are left for the server to judge instead of flagged as lost.
const FOLLOWER_PAGES = 10;

async function loadFollowers(api, userId) {
	const seen = new Map();
	let complete = false;
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
		if (page >= result.pagination.total_pages) {
			complete = true;
			break;
		}
	}
	return { status: 'ok', followers: [...seen.values()], complete };
}

// Inputs the composer needs besides the post itself: category metadata, the
// author's current accepted followers (the only eligible recipients) and
// their profile visibility, which limits who a Public post reaches. All are
// the viewer's own data, so invalidations refresh them without blanking the
// form; an account change, session clear or failed read still discards them.
export function useComposerResources({ social, content, session }) {
	const accountId = () => session.state.account?.id ?? null;
	// Signed out, there is nobody's data to read; the session handler leaves.
	const forAccount = (load) => () => {
		const id = accountId();
		return id === null ? Promise.resolve({ status: 'loading' }) : load(id);
	};
	const categories = useSocialResource(() => content.api.fetchCategories(), {
		social,
		retain: true,
	});
	const followers = useSocialResource(
		forAccount((id) => loadFollowers(social.api, id)),
		{ social, sources: accountId, retain: true },
	);
	const profile = useSocialResource(
		forAccount((id) => social.api.fetchProfile(id)),
		{ social, sources: accountId, retain: true },
	);

	return {
		categories: computed(() => ({
			status: categories.status.value,
			list: categories.result.value?.categories ?? [],
			reload: categories.reload,
		})),
		followers: computed(() => ({
			status: followers.status.value,
			list: followers.result.value?.followers ?? [],
			complete: followers.result.value?.complete ?? true,
			reload: followers.reload,
		})),
		eligibleIds: computed(() =>
			followers.status.value === 'ready' && followers.result.value.complete
				? followers.result.value.followers.map((person) => person.id)
				: null,
		),
		visibility: computed(() => {
			const subject = profile.result.value?.profile;
			return subject?.access === 'full' ? subject.profile.visibility : null;
		}),
	};
}
