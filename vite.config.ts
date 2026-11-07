import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'web',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1024,
  },
  server: {
    host: '127.0.0.1',
    open: false,
    proxy: {
      '/events': 'http://127.0.0.1:5188',
      '/api': 'http://127.0.0.1:5188',
      '/assets/kenney': 'http://127.0.0.1:5188',
    },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
