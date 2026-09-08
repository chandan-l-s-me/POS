import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // NOTE: do not add `define` entries for secrets here. `define` performs a
    // literal text substitution at build time, so anything placed in it — an
    // API key included — is written into the JavaScript bundle and served to
    // every visitor in plaintext. A previous `process.env.GEMINI_API_KEY`
    // define did exactly that. Secrets belong in server.ts, reached through an
    // API route, never in client code.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
