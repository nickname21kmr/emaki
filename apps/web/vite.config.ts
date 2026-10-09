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
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
        // 后端重启时把已经在推送的响应（/api/events）也断掉。vite 默认只给还没发响应头的请求回 502，
        // 正在推的 SSE 会一直挂着，EventSource 既不报错也不重连
        configure: (proxy) =>
          proxy.on('error', (_err, _req, res) => {
            if ('headersSent' in res && res.headersSent) res.destroy();
          }),
      },
    },
  },
});
