import net from 'node:net';

const host = '127.0.0.1';

function canListenLocally() {
	return new Promise((resolve) => {
		const server = net.createServer();

		server.once('error', () => {
			resolve(false);
		});

		server.listen(0, host, () => {
			server.close(() => resolve(true));
		});
	});
}

const supported = await canListenLocally();
process.exit(supported ? 0 : 1);
