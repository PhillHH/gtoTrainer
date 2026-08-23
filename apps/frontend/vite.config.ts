import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Der Dev-Server laeuft auf 5174 statt des Vite-Defaults 5173 - dieser Port ist
 * auf dem Zielhost bereits fremd belegt. Ueberschreibbar via FRONTEND_PORT.
 *
 * `/api` und `/healthz` werden an das Backend weitergereicht. Dadurch sieht der
 * Browser eine einzige Herkunft: Session- und CSRF-Cookies funktionieren ohne
 * CORS, und die Topologie entspricht dem Zielbetrieb, in dem der Host-Nginx
 * genau dasselbe tut (T1.5).
 */
const FRONTEND_PORT = Number(process.env['FRONTEND_PORT'] ?? 5174);
const BACKEND_URL = process.env['BACKEND_URL'] ?? 'http://127.0.0.1:3010';

export default defineConfig({
  plugins: [react()],
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: false },
      '/healthz': { target: BACKEND_URL, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
