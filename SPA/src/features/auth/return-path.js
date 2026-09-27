export function safeReturnPath(value) {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
	if (value.startsWith('/login') || value.startsWith('/register')) return '/';
	return value;
}
