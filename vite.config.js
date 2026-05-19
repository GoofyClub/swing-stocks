import { defineConfig } from 'vite';

// GitHub Pages subpath. The deployed URL is:
//   https://goofyclub.github.io/swing-stocks/
// All asset paths, dynamic imports, and the auth-redirect resolver must respect this base.
const REPO_BASE = '/swing-stocks/';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? REPO_BASE : '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
    // Firebase modular SDK lands ~530 KB unminified; raising the warning ceiling
    // keeps CI logs clean. Real shipped size is gzipped to ~127 KB.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          firebase: [
            'firebase/app',
            'firebase/auth',
            'firebase/firestore',
            'firebase/messaging',
          ],
          // chart.js will be split into its own chunk once a view actually imports it.
        },
      },
    },
  },
  server: {
    port: 5173,
    open: false,
  },
  // The legacy console is kept in /legacy/ as a static artifact. It must NOT be touched
  // by Vite's module graph — explicitly exclude it from server/build resolution.
  optimizeDeps: {
    exclude: ['legacy'],
  },
}));
