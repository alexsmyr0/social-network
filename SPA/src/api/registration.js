const REGISTER_PATH = '/api/v1/users/register';
const UNCONFIRMED_MESSAGE = 'We could not confirm whether your account was created.';

export class RegistrationError extends Error {
	constructor({ code, message, fields = {}, status = 0, ambiguous = false }) {
		super(message);
		this.name = 'RegistrationError';
		this.code = code;
		this.fields = fields;
		this.status = status;
		// True when no contract response arrived, so the server may have
		// committed the account. Callers must recover, not resubmit.
		this.ambiguous = ambiguous;
	}
}

function normalizedOptional(value) {
	const normalized = value.trim();
	return normalized === '' ? null : normalized;
}

export function registrationPayload(values) {
	return {
		email: values.email.trim(),
		password: values.password,
		first_name: values.firstName.trim(),
		last_name: values.lastName.trim(),
		date_of_birth: values.dateOfBirth,
		nickname: normalizedOptional(values.nickname),
		about_me: normalizedOptional(values.aboutMe),
	};
}

function multipartPayload(payload, avatar) {
	const body = new FormData();
	for (const [field, value] of Object.entries(payload)) {
		if (value !== null) body.append(field, value);
	}
	body.append('avatar', avatar);
	return body;
}

export async function registerAccount(values, fetchRef = globalThis.fetch) {
	const payload = registrationPayload(values);
	const hasAvatar = values.avatar instanceof File;
	const body = hasAvatar ? multipartPayload(payload, values.avatar) : JSON.stringify(payload);
	const headers = {
		Accept: 'application/json',
		'X-Requested-With': 'XMLHttpRequest',
	};
	if (!hasAvatar) headers['Content-Type'] = 'application/json';

	let response;
	try {
		response = await fetchRef(REGISTER_PATH, {
			method: 'POST',
			headers,
			credentials: 'include',
			body,
		});
	} catch {
		throw new RegistrationError({
			code: 'NETWORK_ERROR',
			message: UNCONFIRMED_MESSAGE,
			ambiguous: true,
		});
	}

	const responsePayload = await response.json().catch(() => null);
	if (response.ok ? !responsePayload?.data : !responsePayload?.error?.code) {
		throw new RegistrationError({
			code: 'NETWORK_ERROR',
			message: UNCONFIRMED_MESSAGE,
			status: response.status,
			ambiguous: true,
		});
	}
	if (!response.ok) {
		throw new RegistrationError({
			code: responsePayload.error.code,
			message:
				responsePayload.error.message ||
				'The service is unavailable right now. Your details are still here so you can try again.',
			fields: responsePayload.error.fields || {},
			status: response.status,
		});
	}

	return responsePayload.data;
}

export { REGISTER_PATH };
