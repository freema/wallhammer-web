// Documentation check for the wallhammer-web package. Reads the package README and every Markdown file under
// packages/wallhammer-web/docs/ and fails (exit code 1) on any of the rules below. The other Markdown files of the
// repository (the root README, CHANGELOG, CONTRIBUTING, CLAUDE.md, the examples' READMEs and the skills) get the
// [link] rule only; the Markdown files of the users' plugin (plugins/**) get [link] and [subpath].
//
//   [code]     a fenced `ts` block does not type-check against the package (strict, as the package itself)
//              (an error inside the package source itself is reported too, marked as such: fix the package first)
//   [link]     a relative link points to a file that does not exist, or to a heading that the target does not have
//   [subpath]  the text names `wallhammer-web/<subpath>` that is not an export of the package
//   [reference] a name exported by an entry of the package (the `export { … }` lists of its index.ts) is not named in
//              docs/reference.md
//   [plugin]   the Claude Code marketplace (.claude-plugin/marketplace.json) or a plugin it lists is malformed: missing
//              name, owner.name or plugins; a plugin source that is not a relative path starting with `./` or a folder
//              without .claude-plugin/plugin.json; a version in the marketplace entry; plugin.json without name,
//              description, author.name or license, with a name other than the entry's, or with a version other than
//              the package's; a SKILL.md (of a plugin or of .claude/skills) without `name` (lower case, digits and
//              hyphens, equal to its folder) and `description` in its front matter, with description and when_to_use
//              together over 1536 characters, or with a body over 200 lines. No network.
//
//   node tools/docs/check.ts            check (run from the repository root, e.g. `pnpm check:docs`)
//   node tools/docs/check.ts --keep     keep the generated TypeScript files and print where they are
//
// Code blocks. Every ```ts block is a module of its own and is checked as it stands. An HTML comment on the line just
// before the fence changes that:
//   <!-- check: wrap -->   the block is a fragment: its `import` lines stay at the top, the rest goes into the body of
//                          an async function (so top-level `return` and `await` work). Names the fragment uses
//                          without defining them must be declared in the block itself (`declare const renderer: Renderer;`).
//   <!-- check: skip -->   the block is not checked at all (pseudo code, shapes of data, GLSL in a ts fence).
// Imports resolve exactly like the package exports in packages/wallhammer-web/package.json. Unused locals are
// allowed in samples; everything else of tsconfig.base.json applies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PKG = path.join(WEB, 'packages/wallhammer-web');
const TSC = path.join(PKG, 'node_modules/.bin/tsc');
const keep = process.argv.includes('--keep');

interface Finding {
  rule: 'code' | 'link' | 'subpath' | 'reference' | 'plugin';
  file: string;
  line: number;
  message: string;
}
const findings: Finding[] = [];
const rel = (p: string): string => path.relative(WEB, p);

// --- Inputs ----------------------------------------------------------------------------------------------------------

function markdownFiles(): string[] {
  const out = [path.join(PKG, 'README.md')];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(PKG, 'docs'));
  return out;
}

/** Markdown outside the package: only their links are checked. */
function linkOnlyFiles(): string[] {
  const out = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CLAUDE.md'].map((f) => path.join(WEB, f)).filter((f) => fs.existsSync(f));
  for (const [dir, file] of [['examples', 'README.md'], ['.claude/skills', 'SKILL.md']] as const) {
    const root = path.join(WEB, dir);
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(root, e.name, file);
      if (e.isDirectory() && fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** Every Markdown file under plugins/ (the users' Claude Code plugin and its skills), sorted. */
function pluginMarkdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(WEB, 'plugins'));
  return out;
}

const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')) as { name: string; version: string; exports: Record<string, string> };
const subpaths = new Set(Object.keys(pkg.exports).filter((k) => k !== '.').map((k) => k.slice(2)));

// --- Headings and links ----------------------------------------------------------------------------------------------

/** GitHub-style anchor of a heading: lower case, punctuation dropped, spaces to hyphens, duplicates numbered. */
function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]!
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

function checkLinks(file: string, text: string): void {
  const lines = text.split('\n');
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    // Inline code may contain brackets that are not links.
    const prose = line.replace(/`[^`]*`/g, '');
    for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto: …
      const [p, anchor] = target.split('#') as [string, string | undefined];
      const dest = p === '' ? file : path.resolve(path.dirname(file), decodeURIComponent(p));
      if (!fs.existsSync(dest)) {
        findings.push({ rule: 'link', file, line: i + 1, message: `missing target ${target}` });
        continue;
      }
      if (anchor !== undefined && dest.endsWith('.md') && !anchorsOf(fs.readFileSync(dest, 'utf8')).has(anchor)) {
        findings.push({ rule: 'link', file, line: i + 1, message: `no heading #${anchor} in ${rel(dest)}` });
      }
    }
  });
}

function checkSubpaths(file: string, text: string): void {
  text.split('\n').forEach((line, i) => {
    // Not preceded by a path character, so `packages/wallhammer-web/docs` is a file path, not an import.
    for (const m of line.matchAll(/(?<![\w/.-])wallhammer-web\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)/g)) {
      if (!subpaths.has(m[1]!)) findings.push({ rule: 'subpath', file, line: i + 1, message: `wallhammer-web/${m[1]} is not an export of the package` });
    }
  });
}

// --- Code blocks -----------------------------------------------------------------------------------------------------

interface Block {
  file: string;
  /** 1-based line of the first line inside the fence. */
  start: number;
  mode: 'module' | 'wrap';
  lines: string[];
}

function codeBlocks(file: string, text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)?\s*$/.exec(lines[i]!);
    if (!open) continue;
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j]!)) j++;
    const lang = open[1] ?? '';
    const marker = /<!--\s*check:\s*(\w+)\s*-->/.exec(lines[i - 1] ?? '')?.[1];
    if (marker !== undefined && marker !== 'wrap' && marker !== 'skip') {
      findings.push({ rule: 'code', file, line: i, message: `unknown marker "check: ${marker}" (wrap or skip)` });
    }
    if ((lang === 'ts' || lang === 'typescript') && marker !== 'skip') {
      out.push({ file, start: i + 2, mode: marker === 'wrap' ? 'wrap' : 'module', lines: lines.slice(i + 1, j) });
    }
    i = j;
  }
  return out;
}

/** Source of one block and, per generated line, the Markdown line it came from (0 = generated). */
function render(b: Block): { source: string; origin: number[] } {
  const src: string[] = [];
  const origin: number[] = [];
  const push = (s: string, from: number): void => void (src.push(s), origin.push(from));
  if (b.mode === 'module') {
    b.lines.forEach((l, k) => push(l, b.start + k));
    push('export {};', 0);
  } else {
    // Imports (which may span lines) go first, the rest into a function body.
    const isImport: boolean[] = [];
    let inImport = false;
    for (const l of b.lines) {
      if (!inImport && /^import\s/.test(l)) inImport = !/;\s*$/.test(l) && !/from\s+['"][^'"]+['"]\s*;?\s*$/.test(l);
      else if (inImport && /;\s*$|from\s+['"][^'"]+['"]\s*$/.test(l)) {
        isImport.push(true);
        inImport = false;
        continue;
      }
      isImport.push(/^import\s/.test(l) || inImport);
    }
    b.lines.forEach((l, k) => isImport[k] && push(l, b.start + k));
    // `declare` statements are only legal at the top level.
    b.lines.forEach((l, k) => !isImport[k] && /^declare\s/.test(l) && push(l, b.start + k));
    push('export async function snippet(): Promise<void> {', 0);
    b.lines.forEach((l, k) => !isImport[k] && !/^declare\s/.test(l) && push(l, b.start + k));
    push('}', 0);
  }
  return { source: `${src.join('\n')}\n`, origin };
}

function checkCode(blocks: Block[]): number {
  if (blocks.length === 0) return 0;
  if (!fs.existsSync(TSC)) {
    findings.push({ rule: 'code', file: TSC, line: 0, message: 'tsc not found; run `pnpm install` in the container first' });
    return 0;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-docs-'));
  const origins = new Map<string, { block: Block; origin: number[] }>();
  blocks.forEach((b, n) => {
    const name = `${path.basename(b.file, '.md')}-${String(n).padStart(3, '0')}.ts`;
    const { source, origin } = render(b);
    fs.writeFileSync(path.join(dir, name), source);
    origins.set(name, { block: b, origin });
  });
  const base = JSON.parse(fs.readFileSync(path.join(WEB, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
  const paths: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(pkg.exports)) paths[k === '.' ? pkg.name : `${pkg.name}/${k.slice(2)}`] = [path.join(PKG, v)];
  const tsconfig = {
    compilerOptions: { ...base.compilerOptions, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], noUnusedLocals: false, noUnusedParameters: false, paths },
    include: ['*.ts'],
  };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  const r = spawnSync(TSC, ['-p', path.join(dir, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let errors = 0;
  for (const line of out.split('\n')) {
    const m = /^(.*?)\((\d+),(\d+)\): error (TS\d+: .*)$/.exec(line.trim());
    if (!m) continue;
    const name = path.basename(m[1]!);
    const hit = origins.get(name);
    errors++;
    if (!hit) {
      // An error in the package itself, not in a sample: the package must type-check on its own first.
      findings.push({ rule: 'code', file: path.resolve(m[1]!), line: Number(m[2]), message: `in the package source, not a sample: ${m[4]!}` });
      continue;
    }
    const docLine = hit.origin[Number(m[2]) - 1] || hit.block.start;
    findings.push({ rule: 'code', file: hit.block.file, line: docLine, message: m[4]! });
  }
  if (r.status !== 0 && errors === 0) findings.push({ rule: 'code', file: dir, line: 0, message: `tsc failed without diagnostics:\n${out}` });
  if (keep) console.log(`docs: generated files kept in ${dir}`);
  else fs.rmSync(dir, { recursive: true, force: true });
  return blocks.length;
}

// --- Exports in the reference ----------------------------------------------------------------------------------------

/** Every name in the `export { … }` and `export type { … }` lists of an entry's index.ts must be named in reference.md. */
function checkReference(): void {
  const refFile = path.join(PKG, 'docs/reference.md');
  if (!fs.existsSync(refFile)) return;
  const words = new Set(fs.readFileSync(refFile, 'utf8').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
  for (const [entry, source] of Object.entries(pkg.exports)) {
    const index = path.join(PKG, source);
    if (entry === '.' || !fs.existsSync(index)) continue; // the root entry only re-exports other entries
    const text = fs.readFileSync(index, 'utf8');
    for (const m of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
      const line = text.slice(0, m.index).split('\n').length;
      for (const part of m[2]!.split(',')) {
        const name = part.replace(/\/\/.*$/gm, '').trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, '').trim();
        if (name && !words.has(name)) findings.push({ rule: 'reference', file: index, line, message: `export ${name} of ${pkg.name}/${entry.slice(2)} is not in docs/reference.md` });
      }
    }
  }
}

// --- The users' plugin --------------------------------------------------------------------------------------------------

/** Claude Code cuts a skill's description plus when_to_use at this many characters in its listing. */
const SKILL_DESCRIPTION_MAX = 1536;
/** A skill's body stays short; the details live in the docs it points to. */
const SKILL_BODY_MAX_LINES = 200;

function pluginFinding(file: string, message: string, line = 0): void {
  findings.push({ rule: 'plugin', file, line, message });
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    pluginFinding(file, 'not a JSON object');
  } catch (e) {
    pluginFinding(file, `not valid JSON: ${(e as Error).message}`);
  }
  return null;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Front matter of a SKILL.md: `key: value` lines between the opening and the closing `---`. */
function checkSkill(file: string): void {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) {
    pluginFinding(file, 'no front matter (--- … ---) at the top', 1);
    return;
  }
  const fm = new Map<string, string>();
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
    if (m) fm.set(m[1]!, m[2]!.trim());
  }
  const name = fm.get('name');
  const folder = path.basename(path.dirname(file));
  if (!nonEmpty(name)) pluginFinding(file, 'front matter has no name', 1);
  else if (!KEBAB.test(name) || name.length > 64) pluginFinding(file, `name "${name}" is not lower case letters, digits and hyphens (at most 64)`, 1);
  else if (name !== folder) pluginFinding(file, `name "${name}" differs from its folder "${folder}"`, 1);
  const description = fm.get('description');
  if (!nonEmpty(description)) pluginFinding(file, 'front matter has no description', 1);
  else {
    const total = description.length + (fm.get('when_to_use')?.length ?? 0);
    if (total > SKILL_DESCRIPTION_MAX) pluginFinding(file, `description and when_to_use have ${total} characters, over ${SKILL_DESCRIPTION_MAX}`, 1);
  }
  const body = lines.length - end - 1;
  if (body > SKILL_BODY_MAX_LINES) pluginFinding(file, `body has ${body} lines, over ${SKILL_BODY_MAX_LINES}`, end + 2);
}

function checkPlugin(dir: string, entryName: string): void {
  const manifest = path.join(dir, '.claude-plugin/plugin.json');
  if (!fs.existsSync(manifest)) {
    pluginFinding(dir, 'plugin folder has no .claude-plugin/plugin.json');
    return;
  }
  const p = readJson(manifest);
  if (!p) return;
  if (p.name !== entryName) pluginFinding(manifest, `name ${JSON.stringify(p.name)} differs from the marketplace entry "${entryName}"`);
  if (p.version !== pkg.version) pluginFinding(manifest, `version ${JSON.stringify(p.version)} differs from the package version ${pkg.version} (bump both together)`);
  if (!nonEmpty(p.description)) pluginFinding(manifest, 'no description');
  if (!nonEmpty((p.author as { name?: unknown } | undefined)?.name)) pluginFinding(manifest, 'no author.name');
  if (!nonEmpty(p.license)) pluginFinding(manifest, 'no license');
  const skills = path.join(dir, 'skills');
  const found = fs.existsSync(skills) ? fs.readdirSync(skills, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)) : [];
  if (found.length === 0) pluginFinding(dir, 'plugin has no skills/<name>/SKILL.md');
  for (const e of found) {
    const f = path.join(skills, e.name, 'SKILL.md');
    if (fs.existsSync(f)) checkSkill(f);
    else pluginFinding(path.join(skills, e.name), 'skill folder without SKILL.md');
  }
}

/** The marketplace at the repository root and every plugin it lists; also the repository's own skills' front matter. */
function checkMarketplace(): void {
  const file = path.join(WEB, '.claude-plugin/marketplace.json');
  if (!fs.existsSync(file)) {
    pluginFinding(file, 'file missing');
    return;
  }
  const m = readJson(file);
  if (m) {
    if (!nonEmpty(m.name) || !KEBAB.test(m.name)) pluginFinding(file, 'name missing or not lower case letters, digits and hyphens');
    if (!nonEmpty((m.owner as { name?: unknown } | undefined)?.name)) pluginFinding(file, 'no owner.name');
    if (!nonEmpty(m.description)) pluginFinding(file, 'no description');
    const plugins = m.plugins;
    if (!Array.isArray(plugins) || plugins.length === 0) pluginFinding(file, 'no plugins');
    else {
      const names = new Set<string>();
      for (const [i, raw] of plugins.entries()) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const at = `plugins[${i}]`;
        if (!nonEmpty(e.name) || !KEBAB.test(e.name)) {
          pluginFinding(file, `${at}: name missing or not lower case letters, digits and hyphens`);
          continue;
        }
        if (names.has(e.name)) pluginFinding(file, `${at}: name "${e.name}" twice`);
        names.add(e.name);
        if (!nonEmpty(e.description)) pluginFinding(file, `${at}: no description`);
        if ('version' in e) pluginFinding(file, `${at}: version belongs in the plugin's plugin.json, not in the marketplace`);
        if (typeof e.source !== 'string' || !e.source.startsWith('./') || e.source.includes('..')) {
          pluginFinding(file, `${at}: source must be a relative path starting with ./ inside the repository`);
          continue;
        }
        const dir = path.resolve(WEB, e.source);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) pluginFinding(file, `${at}: source ${e.source} is not a folder`);
        else checkPlugin(dir, e.name);
      }
    }
  }
  const own = path.join(WEB, '.claude/skills');
  if (fs.existsSync(own)) {
    for (const e of fs.readdirSync(own, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(own, e.name, 'SKILL.md');
      if (e.isDirectory() && fs.existsSync(f)) checkSkill(f);
    }
  }
}

// --- Run -------------------------------------------------------------------------------------------------------------

const files = markdownFiles();
const blocks: Block[] = [];
for (const f of files) {
  if (!fs.existsSync(f)) {
    findings.push({ rule: 'link', file: f, line: 0, message: 'file missing' });
    continue;
  }
  const text = fs.readFileSync(f, 'utf8');
  checkLinks(f, text);
  checkSubpaths(f, text);
  blocks.push(...codeBlocks(f, text));
}
const checked = checkCode(blocks);
const linkOnly = linkOnlyFiles();
for (const f of linkOnly) checkLinks(f, fs.readFileSync(f, 'utf8'));
const plugin = pluginMarkdownFiles();
for (const f of plugin) {
  const text = fs.readFileSync(f, 'utf8');
  checkLinks(f, text);
  checkSubpaths(f, text);
}
checkReference();
checkMarketplace();

for (const f of findings) console.log(`[${f.rule}] ${rel(f.file)}:${f.line}  ${f.message}`);
console.log(`docs: ${files.length} files (and ${linkOnly.length + plugin.length} more for links), ${checked} code blocks type-checked, ${findings.length} finding(s)`);
process.exit(findings.length ? 1 : 0);
