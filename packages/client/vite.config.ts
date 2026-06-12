import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      // game server (rooms + websocket); same-origin in production
      '/ws': { target: 'ws://localhost:5174', ws: true },
      '/api': { target: 'http://localhost:5174' },
    },
  },
  build: { target: 'es2022' },
});
