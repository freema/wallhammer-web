// Static build of every example, the live demos on GitHub Pages (.github/workflows/pages.yml):
//
//   pnpm build:examples                                   (base `/`, for a local preview of dist-pages/)
//   WH_PAGES_BASE=/wallhammer-web/ pnpm build:examples    (the base of https://freema.github.io/wallhammer-web/)
//
// Each example (a folder examples/<name>/ with index.html) is built with its own vite.config.ts under the base
// `<WH_PAGES_BASE><name>/` into dist-pages/<name>/, with every .html page of its folder as an entry (also
// endless/sphere.html). dist-pages/index.html lists the examples like the index of the dev server
// (tools/serve/examples.ts). WH_PAGES_OUT sets another output folder.
//
// Files an example keeps out of git under public/ (a line `public/<path>` in its .gitignore, e.g. the baked cells of
// endless) are left out, so a local build publishes the same site as the workflow, which has no such files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { EXAMPLES, indexPage, listExamples } from '../serve/examples.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.resolve(ROOT, process.env.WH_PAGES_OUT ?? 'dist-pages');
let BASE = process.env.WH_PAGES_BASE ?? '/';
if (!BASE.startsWith('/')) BASE = `/${BASE}`;
if (!BASE.endsWith('/')) BASE = `${BASE}/`;

/** Total size of the files under `dir`, in bytes. */
function size(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** Paths under public/ that the example's .gitignore keeps out of git (plain paths only, no patterns). */
function ignoredPublic(dir: string): string[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^\//, ''))
    .filter((l) => l.startsWith('public/') && !/[*?[!]/.test(l))
    .map((l) => l.slice('public/'.length).replace(/\/$/, ''))
    .filter((l) => l !== '');
}

const t0 = performance.now();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const examples = listExamples();
for (const e of examples) {
  const root = path.join(EXAMPLES, e.name);
  const outDir = path.join(OUT, e.name);
  const input = Object.fromEntries(['index.html', ...e.pages].map((p) => [p.replace(/\.html$/, ''), path.join(root, p)]));
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    base: `${BASE}${e.name}/`,
    logLevel: 'warn',
    // One bundle per page is fine for a demo; the size limit only silences Vite's code-splitting hint.
    build: { outDir, emptyOutDir: true, rolldownOptions: { input }, chunkSizeWarningLimit: 2000 },
  });
  for (const p of ignoredPublic(root)) fs.rmSync(path.join(outDir, p), { recursive: true, force: true });
  console.log(`[pages] ${e.name}: ${mb(size(outDir))}${e.pages.length > 0 ? ` (pages: index.html, ${e.pages.join(', ')})` : ''}`);
}

fs.writeFileSync(path.join(OUT, 'index.html'), indexPage());
console.log(
  `[pages] ${examples.length} examples under ${BASE} in ${path.relative(ROOT, OUT) || '.'}/, ${mb(size(OUT))}, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
);
