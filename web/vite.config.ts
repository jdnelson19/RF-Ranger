import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.RF_RANGER_SERVER ?? 'http://localhost:8058';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/photos': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
});
