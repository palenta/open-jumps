// The client is built by Vite into client/dist, which the game server serves itself (plan 2.2: one host for
// static files, the API and the WebSocket). In development the Vite dev server proxies /api and /matchmake
// (HTTP + WebSocket) to the game server, so the browser still talks to one origin and the session cookie stays
// first-party.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const GAME_SERVER = process.env.GAME_SERVER ?? 'http://127.0.0.1:2567';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: GAME_SERVER, changeOrigin: false },
      '/matchmake': { target: GAME_SERVER, changeOrigin: false, ws: true },
      // The room socket: the SDK opens ws://host/<processId>/<roomId>?sessionId=… — two short path segments that
      // are not Vite's own (/src, /node_modules, /@fs, /@vite) nor the API.
      '^/(?!src/|node_modules/|@|api/|matchmake/)[A-Za-z0-9_-]+/[A-Za-z0-9_-]+(\\?.*)?$': { target: GAME_SERVER, changeOrigin: false, ws: true },
    },
  },
});
