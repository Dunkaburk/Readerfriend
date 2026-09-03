/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022' },
  // The import pipeline runs in an ES-module Web Worker.
  worker: { format: 'es' },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
  },
});
