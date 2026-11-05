import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_ORIGIN = 'http://127.0.0.1:3100';

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', assetsInlineLimit: 0 },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    proxy: { '/api': { target: API_ORIGIN, changeOrigin: false } },
  },
});
