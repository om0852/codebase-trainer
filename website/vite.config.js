import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = 'https://github.com/om0852/codebase-trainer/blob/main/';

// llms-full.txt for AI search: the README as plain text, rebuilt on every build so it never drifts from the
// package docs. Repo-relative links become absolute GitHub links.
function llmsFull() {
  return {
    name: 'llms-full',
    generateBundle() {
      const readme = readFileSync(resolve(here, '..', 'README.md'), 'utf8')
        .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, link) => `](${REPO}${link.replace(/^\.\//, '')})`);
      this.emitFile({ type: 'asset', fileName: 'llms-full.txt', source: readme });
    }
  };
}

// Two pages (landing and docs). Relative asset paths, so the built site works at a project URL
// (user.github.io/codebase-trainer/) and on a custom domain.
export default defineConfig({
  base: './',
  plugins: [llmsFull()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        docs: resolve(here, 'docs.html')
      }
    }
  }
});
