// Documentation check for the wallhammer-web package. Reads the package README and every Markdown file under
// packages/wallhammer-web/docs/ and fails (exit code 1) on any of:
//
//   [code]     a fenced `ts` block does not type-check against the package (strict, as the package itself)
//              (an error inside the package source itself is reported too, marked as such: fix the package first)
//   [link]     a relative link points to a file that does not exist, or to a heading that the target does not have
//   [subpath]  the text names `wallhammer-web/<subpath>` that is not an export of the package
//
//   node tools/docs/check.ts            check (run from web/, e.g. `pnpm check:docs`)
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
  rule: 'code' | 'link' | 'subpath';
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

const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string> };
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

for (const f of findings) console.log(`[${f.rule}] ${rel(f.file)}:${f.line}  ${f.message}`);
console.log(`docs: ${files.length} files, ${checked} code blocks type-checked, ${findings.length} finding(s)`);
process.exit(findings.length ? 1 : 0);
