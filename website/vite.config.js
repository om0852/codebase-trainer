import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// Two pages (landing and docs). Relative asset paths, so the built site works at a project URL
// (user.github.io/codebase-trainer/) and on a custom domain.
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        docs: resolve(here, 'docs.html')
      }
    }
  }
});
