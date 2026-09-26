const REGISTER_PATH = '/api/v1/users/register';

export class RegistrationError extends Error {
	constructor({ code, message, fields = {}, status = 0 }) {
		super(message);
		this.name = 'RegistrationError';
		this.code = code;
		this.fields = fields;
		this.status = status;
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
			message:
				'We could not confirm whether your account was created. Keep this page open and try again when the connection returns.',
		});
	}

	const responsePayload = await response.json().catch(() => null);
	if (!response.ok || !responsePayload?.data) {
		throw new RegistrationError({
			code: responsePayload?.error?.code || 'SERVICE_UNAVAILABLE',
			message:
				responsePayload?.error?.message ||
				'The service is unavailable right now. Your details are still here so you can try again.',
			fields: responsePayload?.error?.fields || {},
			status: response.status,
		});
	}

	return responsePayload.data;
}

export { REGISTER_PATH };
