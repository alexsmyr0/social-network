// SPA/features/auth/auth.handlers.js

const LOGIN_FORM_ID = 'login-form';
const REGISTER_FORM_ID = 'register-form';
const LOGIN_ENDPOINT = '/api/v1/users/login';
const REGISTER_ENDPOINT = '/api/v1/users/register';

// Reports whether a submitted form belongs to the SPA auth slice.
export function canHandleAuthForm(form) {
	return Boolean(form?.id === LOGIN_FORM_ID || form?.id === REGISTER_FORM_ID);
}

// Executes the SPA auth request flow for either login or registration.
// The app shell can call this later without knowing auth-specific payload rules.
export async function handleAuthFormSubmit({ form, fetchRef, navigate, onError, onSuccess }) {
	if (!canHandleAuthForm(form)) {
		return { handled: false };
	}

	if (typeof fetchRef !== 'function') {
		throw new TypeError('fetchRef must be a function');
	}

	const authRequest = buildAuthRequest(form);
	const submitButton = findSubmitButton(form);

	setFormBusy(submitButton, true);
	clearFormError(form);

	try {
		const response = await fetchRef(authRequest.endpoint, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(authRequest.payload),
		});

		const responseBody = await readJSONResponse(response);

		if (!response.ok) {
			const message = getErrorMessage(responseBody, authRequest.kind);
			writeFormError(form, message);
			onError?.(message, { response, responseBody, kind: authRequest.kind });
			return {
				handled: true,
				ok: false,
				kind: authRequest.kind,
				message,
				response,
				responseBody,
			};
		}

		// Successful auth creates a session, so later integration can always
		// move the user into the protected forum shell.
		onSuccess?.({ response, responseBody, kind: authRequest.kind });
		navigate?.('/', { replace: true });

		return {
			handled: true,
			ok: true,
			kind: authRequest.kind,
			response,
			responseBody,
		};
	} catch (error) {
		const message = getNetworkErrorMessage();
		writeFormError(form, message);
		onError?.(message, {
			error,
			response: null,
			responseBody: null,
			kind: authRequest.kind,
		});
		return {
			handled: true,
			ok: false,
			kind: authRequest.kind,
			message,
			error,
			response: null,
			responseBody: null,
		};
	} finally {
		setFormBusy(submitButton, false);
	}
}

// Converts the current login form values into the backend contract where the
// identifier is mapped to username or email based on whether it contains `@`.
function buildLoginPayload(formData) {
	const identifier = readTrimmedField(formData, 'identifier');
	const password = readField(formData, 'password');
	const payload = { password };

	// This heuristic is safe because the backend rejects usernames containing `@`.
	if (identifier.includes('@')) {
		payload.email = identifier;
	} else {
		payload.username = identifier;
	}

	return payload;
}

// Mirrors the SDS registration payload shape so the auth slice owns the form
// field-to-API mapping in one place.
function buildRegisterPayload(formData) {
	const payload = {
		first_name: readTrimmedField(formData, 'first_name'),
		last_name: readTrimmedField(formData, 'last_name'),
		gender: readTrimmedField(formData, 'gender'),
		username: readTrimmedField(formData, 'username'),
		email: readTrimmedField(formData, 'email'),
		password: readField(formData, 'password'),
	};

	const age = readIntegerField(formData, 'age');
	if (typeof age === 'number') {
		payload.age = age;
	}

	return payload;
}

// Resolves the outbound request definition from the submitted auth form.
function buildAuthRequest(form) {
	const formData = new FormData(form);

	if (form.id === LOGIN_FORM_ID) {
		return {
			kind: 'login',
			endpoint: LOGIN_ENDPOINT,
			payload: buildLoginPayload(formData),
		};
	}

	return {
		kind: 'register',
		endpoint: REGISTER_ENDPOINT,
		payload: buildRegisterPayload(formData),
	};
}

// Reads a field as-is because password values should not be trimmed silently.
function readField(formData, name) {
	const value = formData.get(name);
	return typeof value === 'string' ? value : '';
}

// Reads a user-entered text field and normalizes surrounding whitespace.
function readTrimmedField(formData, name) {
	return readField(formData, name).trim();
}

// Parses integer-only number fields so invalid programmatic submissions do not
// get serialized as strings into an otherwise numeric API contract.
function readIntegerField(formData, name) {
	const rawValue = readTrimmedField(formData, name);
	if (rawValue === '') {
		return undefined;
	}

	if (!/^-?\d+$/.test(rawValue)) {
		return undefined;
	}

	const numericValue = Number.parseInt(rawValue, 10);
	return Number.isNaN(numericValue) ? undefined : numericValue;
}

// Handles empty or malformed JSON responses without breaking the auth flow.
async function readJSONResponse(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

// Prefers backend error messages, with auth-specific fallbacks when the
// response body is missing or does not follow the standard envelope.
function getErrorMessage(responseBody, kind) {
	const apiMessage = responseBody?.error?.message;
	if (typeof apiMessage === 'string' && apiMessage.trim() !== '') {
		return apiMessage;
	}

	return kind === 'login'
		? 'Login failed. Please check your credentials.'
		: 'Registration failed. Please review your details and try again.';
}

// Keeps network-level failures distinct from backend validation or auth errors
// so the UI can explain why no server response was available.
function getNetworkErrorMessage() {
	return 'Network error. Please try again.';
}

// Finds the submit control so the form can be temporarily locked during the
// network request and avoid duplicate submissions.
function findSubmitButton(form) {
	return form?.querySelector?.('button[type="submit"]') ?? null;
}

// Toggles the submit button disabled state and stores the original label so it
// can be restored after the auth request finishes.
function setFormBusy(submitButton, isBusy) {
	if (!submitButton) {
		return;
	}

	if (isBusy) {
		if (!submitButton.dataset.originalLabel) {
			submitButton.dataset.originalLabel = submitButton.textContent ?? '';
		}
		submitButton.disabled = true;
		submitButton.textContent = 'Working...';
		return;
	}

	submitButton.disabled = false;
	if (submitButton.dataset.originalLabel) {
		submitButton.textContent = submitButton.dataset.originalLabel;
		delete submitButton.dataset.originalLabel;
	}
}

// Clears any previously rendered auth error message from the form.
function clearFormError(form) {
	const errorNode = form?.querySelector?.('[data-auth-error]');
	errorNode?.remove?.();
}

// Renders a compact inline auth error message at the top of the current form.
function writeFormError(form, message) {
	if (!form || typeof document === 'undefined') {
		return;
	}

	clearFormError(form);

	const errorNode = document.createElement('p');
	errorNode.className = 'auth-form-error';
	errorNode.dataset.authError = 'true';
	errorNode.setAttribute('role', 'alert');
	errorNode.textContent = message;

	form.prepend(errorNode);
}
