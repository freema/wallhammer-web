// The list of examples and the index page that shows it: served at `/` by the dev server (tools/serve/serve.ts) and
// written as `index.html` of the static site (tools/pages/build.ts). An example is a folder examples/<name>/ with
// index.html; its title comes from `<title>`, its line from `description` in its package.json.
//
// The links are relative (`<name>/`), so the same page works at `/` and under a sub-path such as `/wallhammer-web/`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES = fileURLToPath(new URL('../../examples/', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const REPOSITORY = 'https://github.com/freema/wallhammer-web';
const PACKAGE = 'https://www.npmjs.com/package/wallhammer-web';

export interface Example {
  name: string;
  title: string;
  description: string;
  /** Further pages of the example (other .html files in its folder), e.g. endless/sphere.html. */
  pages: string[];
}

/** Whether examples/<name> is an example (a folder with index.html). */
export function isExample(name: string): boolean {
  return NAME.test(name) && fs.existsSync(path.join(EXAMPLES, name, 'index.html'));
}

function readExample(name: string): Example {
  const dir = path.join(EXAMPLES, name);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const title = (/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? name).replace(/^Wallhammer Web:\s*/, '');
  let description = '';
  try {
    description = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { description?: string }).description ?? '';
  } catch {
    // An example without package.json is still listed.
  }
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'index.html').sort();
  return { name, title, description, pages };
}

/** Every example, sorted by name. The folder is read on every call, so a new example needs no restart. */
export function listExamples(): Example[] {
  return fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isExample(e.name))
    .map((e) => readExample(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The index page of all examples. */
export function indexPage(): string {
  const items = listExamples()
    .map((e) => {
      const more = e.pages.map((p) => ` · <a href="${e.name}/${esc(p)}">${esc(p)}</a>`).join('');
      return `<li><a href="${e.name}/"><b>${esc(e.name)}</b></a> <span>${esc(e.title)}</span>${more}<p>${esc(e.description)}</p></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>Wallhammer Web: examples</title>
<style>
  body { margin: 0; padding: 24px 16px; background: #15161a; color: #d8d9de; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 12px 0; border-top: 1px solid #2a2c33; }
  a { color: #8fb8ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  span { color: #9a9ca6; margin-left: 8px; }
  p { margin: 4px 0 0; color: #b4b6be; }
  header p { margin: 0 0 16px; }
</style>
</head>
<body>
<main>
<header>
<h1>Wallhammer Web: examples</h1>
<p>A 3D engine for the browser where the whole world is written in code: no model files, no texture files, no images.
Every page needs WebGL2. Source on <a href="${REPOSITORY}">GitHub</a>, package <a href="${PACKAGE}">wallhammer-web</a> on npm.</p>
</header>
<ul>
${items}
</ul>
</main>
</body>
</html>
`;
}
