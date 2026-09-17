// SPA/features/auth/auth.views.js

// Renders the public login route inside the SPA using only the supported
// username-or-email plus password entry path defined for this ticket.
export function renderLoginView() {
	return `
		<div class="auth-page" data-screen="login">
			<div class="auth-form-container">
				<div class="auth-form-card">
					<div class="auth-header">
						<div class="auth-logo">
							<div class="auth-logo-icon">F</div>
							Real-Time Forum
						</div>
						<h1 class="auth-title">Welcome Back!</h1>
						<p class="auth-subtitle">Sign in to access your dashboard and continue participating in the community.</p>
					</div>

					<form class="auth-form" id="login-form" method="POST">
						<div class="form-group">
							<label class="form-label" for="login-identifier">Username or Email</label>
							<div class="input-wrapper">
								<span class="input-icon">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
								</span>
								<input class="auth-input" type="text" id="login-identifier" name="identifier" placeholder="Enter your username or email" required autocomplete="username">
							</div>
						</div>
						<div class="form-group">
							<label class="form-label" for="login-password">Password</label>
							<div class="input-wrapper">
								<span class="input-icon">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
								</span>
								<input class="auth-input" type="password" id="login-password" name="password" placeholder="Enter your password" required autocomplete="current-password">
							</div>
						</div>
						<button type="submit" class="auth-button">Sign In</button>
					</form>

					<p class="switch-auth">
						Don't have an account? <a data-link href="/register">Sign Up</a>
					</p>
				</div>
			</div>
			<div class="auth-hero">
				<div class="hero-content">
					<h2 class="hero-title">The heart of community.</h2>
					<div class="testimonial">
						<p class="testimonial-text">"The real-time updates make it feel like a living conversation. It's transformed how we collaborate."</p>
						<div class="testimonial-author">
							<div class="author-avatar author-avatar--initials" aria-hidden="true">MC</div>
							<div class="author-info">
								<h4>Michael Carter</h4>
								<p>Lead Developer at DevCore</p>
							</div>
						</div>
					</div>
				</div>
				<div class="hero-footer">
					<div class="footer-label">Powering 1K+ Communities</div>
					<div class="brand-logos">
						<span class="brand-logo">DISCORD</span>
						<span class="brand-logo">SLACK</span>
						<span class="brand-logo">REDDIT</span>
					</div>
				</div>
			</div>
		</div>
	`;
}

// Renders the public registration route with the full required profile
// fields from the ticket, while keeping the screen limited to the SPA flow.
export function renderRegisterView() {
	return `
		<div class="auth-page" data-screen="register">
			<div class="auth-form-container">
				<div class="auth-form-card auth-form-card--wide">
					<div class="auth-header">
						<div class="auth-logo">
							<div class="auth-logo-icon">F</div>
							Real-Time Forum
						</div>
						<h1 class="auth-title">Create Account</h1>
						<p class="auth-subtitle">Join our community and start sharing your thoughts today.</p>
					</div>

					<form class="auth-form" id="register-form" method="POST">
						<div class="auth-grid-2">
							<div class="form-group">
								<label class="form-label" for="reg-first-name">First Name</label>
								<input class="auth-input auth-input--plain-padding" type="text" id="reg-first-name" name="first_name" placeholder="John" required>
							</div>
							<div class="form-group">
								<label class="form-label" for="reg-last-name">Last Name</label>
								<input class="auth-input auth-input--plain-padding" type="text" id="reg-last-name" name="last_name" placeholder="Doe" required>
							</div>
						</div>

						<div class="auth-grid-2">
								<div class="form-group">
									<label class="form-label" for="reg-age">Age</label>
									<input class="auth-input auth-input--plain-padding" type="number" id="reg-age" name="age" min="13" max="120" placeholder="25" required>
								</div>
							<div class="form-group">
								<label class="form-label" for="reg-gender">Gender</label>
								<select class="auth-input auth-input--plain-padding" id="reg-gender" name="gender" required>
									<option value="" disabled selected>Select</option>
									<option value="male">Male</option>
									<option value="female">Female</option>
									<option value="other">Other</option>
									<option value="prefer-not-to-say">Prefer not to say</option>
								</select>
							</div>
						</div>

						<div class="form-group">
							<label class="form-label" for="reg-username">Username</label>
							<div class="input-wrapper">
								<span class="input-icon">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
								</span>
								<input class="auth-input" type="text" id="reg-username" name="username" placeholder="johndoe" required autocomplete="username">
							</div>
						</div>

						<div class="form-group">
							<label class="form-label" for="reg-email">Email Address</label>
							<div class="input-wrapper">
								<span class="input-icon">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
								</span>
								<input class="auth-input" type="email" id="reg-email" name="email" placeholder="john@example.com" required autocomplete="email">
							</div>
						</div>

						<div class="form-group">
							<label class="form-label" for="reg-password">Password</label>
								<div class="input-wrapper">
									<span class="input-icon">
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
									</span>
									<input class="auth-input" type="password" id="reg-password" name="password" placeholder="Min. 8 characters" minlength="8" required autocomplete="new-password">
								</div>
							</div>

						<button type="submit" class="auth-button">Create Account</button>
					</form>

					<p class="switch-auth">
						Already have an account? <a data-link href="/login">Sign In</a>
					</p>
				</div>
			</div>
			<div class="auth-hero">
				<div class="hero-content">
					<h2 class="hero-title">Start your journey.</h2>
					<div class="testimonial">
						<p class="testimonial-text">"Creating an account was the best thing I did for my professional network. The discussions are top-tier."</p>
						<div class="testimonial-author">
							<div class="author-avatar author-avatar--initials" aria-hidden="true">SJ</div>
							<div class="author-info">
								<h4>Sarah Jenkins</h4>
								<p>Community Member</p>
							</div>
						</div>
					</div>
				</div>
				<div class="hero-footer">
					<div class="footer-label">Join 50K+ others</div>
				</div>
			</div>
		</div>
	`;
}
