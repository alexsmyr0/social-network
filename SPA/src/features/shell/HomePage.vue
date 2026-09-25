<template>
	<section class="home-view" data-screen="home">
		<div class="home-view__hero">
			<p class="eyebrow">Your people, in one place</p>
			<h1>A social space with room to <em>actually connect.</em></h1>
			<p class="home-view__lede">
				Commonplace is becoming a focused home for conversations, shared moments and the
				groups that make a community feel close.
			</p>
			<div class="home-view__actions">
				<RouterLink class="button button--primary" to="/register">Create an account</RouterLink>
				<RouterLink class="text-link" to="/login">
					I already belong
					<span aria-hidden="true">↗</span>
				</RouterLink>
			</div>
		</div>

		<aside class="signal-board" aria-label="Product foundation">
			<div class="signal-board__number" aria-hidden="true">01</div>
			<p class="signal-board__kicker">Foundation online</p>
			<h2>The front door is ready.</h2>
			<p>
				Routing and the backend connection are live. Account access arrives in the next
				implementation step.
			</p>
			<ul class="signal-list">
				<li><span aria-hidden="true">✓</span> Vue application shell</li>
				<li><span aria-hidden="true">✓</span> Same-origin API boundary</li>
				<li><span aria-hidden="true">✓</span> Responsive route states</li>
			</ul>
		</aside>

		<div class="feature-line" aria-label="Planned social network areas">
			<p>Coming into focus</p>
			<ul>
				<li>Profiles</li>
				<li>Groups</li>
				<li>Conversations</li>
			</ul>
		</div>
	</section>
</template>
