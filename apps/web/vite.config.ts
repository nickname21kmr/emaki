import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const rootEnv = loadEnv('development', path.resolve(import.meta.dirname, '../..'), 'EMAKI_');
const API_PORT = Number(process.env.EMAKI_PORT ?? rootEnv.EMAKI_PORT ?? 5174);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
});
