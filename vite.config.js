import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const backendTarget = env.BACKEND_URL || 'http://localhost:8080';

	return {
		root: 'SPA',
		plugins: [vue()],
		resolve: {
			alias: {
				'@': fileURLToPath(new URL('./SPA/src', import.meta.url)),
			},
		},
		build: {
			outDir: 'dist',
			emptyOutDir: true,
		},
		server: {
			host: '0.0.0.0',
			port: 3000,
			strictPort: true,
			proxy: {
				'/api': {
					target: backendTarget,
					changeOrigin: true,
				},
				'/ws': {
					target: backendTarget,
					changeOrigin: true,
					ws: true,
				},
			},
		},
		preview: {
			host: '0.0.0.0',
			port: 3000,
			strictPort: true,
			proxy: {
				'/api': {
					target: backendTarget,
					changeOrigin: true,
				},
				'/ws': {
					target: backendTarget,
					changeOrigin: true,
					ws: true,
				},
			},
		},
	};
});
