// Dependency check for the Wallhammer Web workspace. Enforces the module layers of the engine package and the
// boundaries between the engine, its content modules (gen-arch, gen-ground, gen-vegetation), the examples and the apps.
// Every violation is an error (exit code 1); there are no exceptions.
//
//   node tools/layers/check.ts                      check the workspace (the repository root)
//   node tools/layers/check.ts --root <dir>         check another tree (used by the fixtures)
//   node tools/layers/check.ts --list               also print every module with its layer
//
// Rules (ids in brackets appear in the report):
//   [upward]           an engine module imports a module of a higher layer
//   [same-layer]       an engine module imports another module of the same layer
//   [stray-file]       a source file of the engine sits outside a module folder (only src/index.ts may); a module
//                      may have subfolders, a file in them belongs to the module
//   [unknown-module]   an import points to an engine folder that is not a known module
//   [engine-imports-content]  an engine module other than the content modules (CONTENT_MODULES: gen-arch, gen-ground,
//                             gen-vegetation), or the root entry, imports a content module; or the engine imports an app
//   [content-imports-app]     a content module imports an app
//   [content-imports-content] a content module imports another content module (they are one layer)
//   [content-imports-engine]  a content module imports an engine module other than the generator layers
//                             (base, core, gen-core, gen-mesh, gen-tex) or the engine's root entry
//   [subfolder-order]  inside a module with a subfolder order (SUBFOLDER_ORDER: gen-arch structure <- interior <- damage),
//                      a file imports a later subfolder or a file of the module root (the root ranks after all
//                      subfolders; a self-import through `wallhammer-web/<module>` counts as the root), or a file sits
//                      in a subfolder the order does not list; type imports and re-exports count
//   [example-imports]  an example imports an app or another example; an example may import the engine, its own files
//                      and the files of examples/shared (SHARED_EXAMPLE), code used by several examples; an engine-only
//                      example (ENGINE_ONLY_EXAMPLES) and examples/shared itself may not import a content module, and
//                      examples/shared imports nothing but the engine and its own files (a package's vite.config.ts may
//                      import dev tooling from tools/)
//   [webgl]            WebGL types or calls outside the engine module `gpu` (engine and examples)
//   [dom]              browser DOM outside the engine module `platform` (engine)
//   [worker]           the Worker API (new Worker, postMessage, onmessage, importScripts) outside the engine module
//                      `platform` (engine)
//   [use-case-word]    a file name, an exported identifier or a comment of an engine module other than the content
//                      modules names a use case (USE_CASE_WORDS: city, building, roof, tree, car, road, …); `window`
//                      is allowed only in `platform`, where it is the browser global
//   [sim-headless]     the engine module `sim` imports anything but base, core and gen-core (it must run in plain Node)
//   [sim-nondeterministic]  `sim` uses Math.random, the clock (Date, performance.now) or a transcendental Math
//                      function, which IEEE 754 does not define exactly (determinism tier A)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Engine modules and their layers, after Wallhammer Zero (ARCHITECTURE.md, "Layers and modules"). */
export const LAYERS: Readonly<Record<string, number>> = {
  base: 0,
  platform: 1,
  core: 2,
  'gen-core': 2,
  motion: 2,
  'gen-mesh': 3,
  'gen-tex': 3,
  'gen-arch': 3,
  'gen-ground': 3,
  'gen-vegetation': 3,
  'gen-plan': 3,
  gpu: 4,
  render: 5,
  camera: 5,
  env: 5,
  world: 5,
  sim: 5,
  runtime: 6,
  tools: 7,
};

const ENGINE = 'wallhammer-web';
/** Content generators: optional engine modules of layer 3 that nothing else in the engine imports. */
export const CONTENT_MODULES: ReadonlySet<string> = new Set(['gen-arch', 'gen-ground', 'gen-vegetation']);
/** Examples that prove the engine alone: they may import only the engine package, without the content modules. */
const ENGINE_ONLY_EXAMPLES = new Set(['minimal-3d', 'endless', 'planet', 'fantasy-village', 'walk', 'outpost', 'rivers', 'shared']);
/** The folder under examples/ with code used by several examples: any example may import it, it imports no example. */
const SHARED_EXAMPLE = 'shared';
/** Words of use cases that only the content modules may name (file names, exported identifiers, comments). */
export const USE_CASE_WORDS: ReadonlySet<string> = new Set([
  'city', 'cities', 'building', 'buildings', 'roof', 'roofs', 'facade', 'facades', 'façade', 'façades', 'tree', 'trees',
  'leaf', 'leafs', 'crown', 'crowns', 'car', 'cars', 'parking', 'kerb', 'kerbs', 'road', 'roads', 'pavement', 'pavements',
  'crossing', 'crossings', 'window', 'windows', 'river', 'rivers', 'lake', 'lakes', 'shore', 'shores', 'coast', 'coasts',
  'mountain', 'mountains', 'biome', 'biomes', 'village', 'villages', 'town', 'towns', 'settlement', 'settlements',
  'flower', 'flowers', 'bridge', 'bridges', 'tower', 'towers', 'mill', 'mills',
  'creature', 'creatures', 'animal', 'animals',
]);
/** Engine modules a content module may import: generators return plain data and material descriptions. */
export const CONTENT_MAY_IMPORT: ReadonlySet<string> = new Set(['base', 'core', 'gen-core', 'gen-mesh', 'gen-tex']);
/**
 * Modules whose subfolders depend one way: a file imports only its own subfolder and the ones listed before it. Files
 * directly in the module folder (index.ts, build.ts) rank after all subfolders and may import every one of them.
 */
export const SUBFOLDER_ORDER: Readonly<Record<string, readonly string[]>> = { 'gen-arch': ['structure', 'interior', 'damage'] };
/** Engine modules the simulation may import: no browser, no GPU, no image side. */
export const SIM_MAY_IMPORT: ReadonlySet<string> = new Set(['base', 'core', 'gen-core']);

export interface Violation {
  rule: string;
  file: string;
  line: number;
  message: string;
}

type Owner =
  | { kind: 'engine'; module: string | null }
  | { kind: 'app'; pkg: string }
  | { kind: 'example'; pkg: string }
  | { kind: 'other' };

/**
 * Blanks out comments and the text of string and template literals, keeping `${…}` expressions and line breaks.
 * When `comments` is given, the [start, end) range of every comment is pushed to it.
 */
export function codeOnly(src: string, comments?: [number, number][]): string {
  const out = src.split('');
  const blank = (i: number): void => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  // Stack of contexts: 'code' at template expression depth, 'tpl' inside a template literal.
  const stack: ('code' | 'tpl')[] = ['code'];
  const braces: number[] = [0];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i]!;
    const n = src[i + 1];
    if (top === 'tpl') {
      if (c === '\\') {
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        braces.pop();
        i++;
      } else if (c === '$' && n === '{') {
        stack.push('code');
        braces.push(0);
        i += 2;
      } else {
        blank(i);
        i++;
      }
      continue;
    }
    if (c === '/' && n === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') blank(i++);
      comments?.push([start, i]);
    } else if (c === '/' && n === '*') {
      const start = i;
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i);
      blank(i + 1);
      i += 2;
      comments?.push([start, Math.min(i, src.length)]);
    } else if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') blank(i++);
        blank(i++);
      }
      i++;
    } else if (c === '`') {
      stack.push('tpl');
      braces.push(0);
      i++;
    } else if (c === '{') {
      braces[braces.length - 1]!++;
      i++;
    } else if (c === '}') {
      if (stack.length > 1 && braces[braces.length - 1] === 0) {
        // End of a `${…}` expression: back into the template.
        stack.pop();
        braces.pop();
      } else braces[braces.length - 1]!--;
      i++;
    } else i++;
  }
  return out.join('');
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function check(root: string): Violation[] {
  const packagesDir = path.join(root, 'packages');
  const appsDir = path.join(root, 'apps');
  const examplesDir = path.join(root, 'examples');
  const engineSrc = path.join(packagesDir, ENGINE, 'src');
  const apps = fs.existsSync(appsDir) ? fs.readdirSync(appsDir).filter((d) => fs.statSync(path.join(appsDir, d)).isDirectory()) : [];
  const examples = fs.existsSync(examplesDir) ? fs.readdirSync(examplesDir).filter((d) => fs.statSync(path.join(examplesDir, d)).isDirectory()) : [];
  const appNames = new Map<string, string>();
  for (const a of apps) {
    const pj = path.join(appsDir, a, 'package.json');
    const name = fs.existsSync(pj) ? (JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string }).name : undefined;
    appNames.set(name ?? a, a);
  }

  const ownerOf = (file: string): Owner => {
    const rel = path.relative(root, file).split(path.sep);
    if (rel[0] === 'packages' && rel[1] === ENGINE) {
      if (rel[2] !== 'src') return { kind: 'engine', module: null };
      return { kind: 'engine', module: rel.length > 4 ? rel[3]! : null };
    }
    if (rel[0] === 'apps' && rel[1]) return { kind: 'app', pkg: rel[1] };
    if (rel[0] === 'examples' && rel[1]) return { kind: 'example', pkg: rel[1] };
    return { kind: 'other' };
  };

  /** Owner of an import target. Bare specifiers of workspace packages are mapped to their folders. */
  const targetOf = (from: string, spec: string): Owner | null => {
    if (spec.startsWith('.')) return ownerOf(path.resolve(path.dirname(from), spec));
    const parts = spec.split('/');
    if (parts[0] === ENGINE) {
      if (parts.length === 1) return { kind: 'engine', module: null };
      return { kind: 'engine', module: parts[1]! };
    }
    const app = appNames.get(parts[0]!);
    if (app) return { kind: 'app', pkg: app };
    return null;
  };

  /** Subfolder of a path inside an engine module, '' for the module folder itself and the files directly in it. */
  const subfolderOf = (abs: string, module: string): string => {
    const rel = path.relative(path.join(engineSrc, module), abs).split(path.sep);
    if (rel.length > 1) return rel[0]!;
    // A folder import (`../structure`) names the subfolder itself.
    return rel[0] !== '' && fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? rel[0]! : '';
  };
  /** Rank in SUBFOLDER_ORDER: the index of the subfolder, the module root after all subfolders, -1 when not listed. */
  const rankOf = (module: string, sub: string): number => {
    const order = SUBFOLDER_ORDER[module]!;
    return sub === '' ? order.length : order.indexOf(sub);
  };
  const subName = (module: string, sub: string): string => (sub === '' ? `${module} root` : `${module}/${sub}`);

  const violations: Violation[] = [];
  const files = [...walk(path.join(packagesDir, ENGINE, 'src')), ...apps.flatMap((a) => walk(path.join(appsDir, a))), ...examples.flatMap((e) => walk(path.join(examplesDir, e)))];
  const importRe = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const comments: [number, number][] = [];
    const code = codeOnly(src, comments);
    const rel = path.relative(root, file);
    const owner = ownerOf(file);
    const content = owner.kind === 'engine' && owner.module !== null && CONTENT_MODULES.has(owner.module);
    const add = (rule: string, index: number, message: string): void => {
      violations.push({ rule, file: rel, line: lineOf(src, index), message });
    };

    if (owner.kind === 'engine' && owner.module === null && path.relative(engineSrc, file) !== 'index.ts') {
      add('stray-file', 0, 'engine source file outside a module folder; only src/index.ts may sit at the root');
    }
    if (owner.kind === 'engine' && owner.module !== null && !(owner.module in LAYERS)) {
      add('unknown-module', 0, `folder "${owner.module}" is not a known engine module`);
    }
    const ordered = owner.kind === 'engine' && owner.module !== null && owner.module in SUBFOLDER_ORDER ? owner.module : null;
    const ownSub = ordered !== null ? subfolderOf(file, ordered) : '';
    const ownRank = ordered !== null ? rankOf(ordered, ownSub) : -1;
    if (ordered !== null && ownRank < 0) {
      add('subfolder-order', 0, `subfolder ${subName(ordered, ownSub)} is not in the subfolder order of ${ordered} (${SUBFOLDER_ORDER[ordered]!.join(' <- ')} <- root); give it a place in SUBFOLDER_ORDER`);
    }

    for (const m of src.matchAll(importRe)) {
      // Skip matches inside comments or strings: the keyword itself must be code.
      if (code.slice(m.index, m.index + 6) !== src.slice(m.index, m.index + 6)) continue;
      const spec = (m[1] ?? m[2])!;
      const target = targetOf(file, spec);
      if (!target) continue;
      // Subfolder order: within the module, an import may point only to the file's own subfolder or an earlier one.
      if (ordered !== null && ownRank >= 0 && target.kind === 'engine' && target.module === ordered) {
        const parts = spec.split('/');
        const toSub = spec.startsWith('.') ? subfolderOf(path.resolve(path.dirname(file), spec), ordered) : parts.length > 3 ? parts[2]! : '';
        const toRank = rankOf(ordered, toSub);
        if (toRank > ownRank) {
          add('subfolder-order', m.index, `${subName(ordered, ownSub)} imports ${subName(ordered, toSub)} ("${spec}"); imports run one way: ${SUBFOLDER_ORDER[ordered]!.join(' <- ')} <- root`);
        }
      }
      if (owner.kind === 'engine' && content) {
        const from = owner.module!;
        if (target.kind === 'app') add('content-imports-app', m.index, `${from} imports app ${target.pkg} ("${spec}")`);
        else if (target.kind !== 'engine' || target.module === from) continue;
        else if (target.module !== null && CONTENT_MODULES.has(target.module)) add('content-imports-content', m.index, `${from} imports ${target.module} ("${spec}")`);
        else if (target.module === null || !CONTENT_MAY_IMPORT.has(target.module)) {
          add('content-imports-engine', m.index, `${from} imports engine ${target.module ?? 'root entry'} ("${spec}"); only ${[...CONTENT_MAY_IMPORT].join(', ')}`);
        }
      } else if (owner.kind === 'engine') {
        if (target.kind === 'app') {
          add('engine-imports-content', m.index, `engine imports app ${target.pkg} ("${spec}")`);
          continue;
        }
        if (target.kind === 'engine' && target.module !== null && CONTENT_MODULES.has(target.module)) {
          add('engine-imports-content', m.index, `${owner.module ?? 'root entry'} imports content module ${target.module} ("${spec}")`);
          continue;
        }
        if (target.kind !== 'engine' || owner.module === null) continue;
        if (target.module === null) {
          add('upward', m.index, `module ${owner.module} imports the root entry ("${spec}")`);
          continue;
        }
        if (target.module === owner.module) continue;
        if (owner.module === 'sim' && !SIM_MAY_IMPORT.has(target.module)) {
          add('sim-headless', m.index, `sim imports ${target.module} ("${spec}"); only ${[...SIM_MAY_IMPORT].join(', ')}`);
        }
        const a = LAYERS[owner.module];
        const b = LAYERS[target.module];
        if (b === undefined) {
          add('unknown-module', m.index, `import of unknown engine folder "${target.module}" ("${spec}")`);
          continue;
        }
        if (a === undefined) continue;
        if (b > a) add('upward', m.index, `${owner.module} (layer ${a}) imports ${target.module} (layer ${b})`);
        else if (b === a) add('same-layer', m.index, `${owner.module} imports ${target.module}, both layer ${a}`);
      } else if (owner.kind === 'example') {
        // A package's dev-server config may use the workspace's dev tooling (tools/); it is not example code.
        if (path.basename(file) === 'vite.config.ts' && spec.startsWith('.') && path.resolve(path.dirname(file), spec).startsWith(path.join(root, 'tools') + path.sep)) continue;
        const engineOnly = ENGINE_ONLY_EXAMPLES.has(owner.pkg);
        const toContent = target.kind === 'engine' && target.module !== null && CONTENT_MODULES.has(target.module);
        const toExample = target.kind === 'example' && (target.pkg === owner.pkg || target.pkg === SHARED_EXAMPLE);
        const allowed = (target.kind === 'engine' && !(engineOnly && toContent)) || toExample;
        if (!allowed) {
          const what = target.kind === 'engine' ? `content module ${target.module}` : target.kind === 'other' ? spec : target.pkg;
          const may = owner.pkg === SHARED_EXAMPLE ? 'only the engine without its content modules' : `only the engine${engineOnly ? ' without its content modules' : ''} and examples/${SHARED_EXAMPLE}`;
          add('example-imports', m.index, `example ${owner.pkg} imports ${what} ("${spec}"); ${may}`);
        }
      }
    }

    // Use-case words: the engine is generic, only the content modules may name what they generate.
    if (owner.kind === 'engine' && !content) {
      const words = (s: string): string[] =>
        s.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2').toLowerCase().split(/[^\p{L}]+/u);
      const banned = (s: string): string | undefined => words(s).find((w) => USE_CASE_WORDS.has(w) && !(owner.module === 'platform' && /^windows?$/.test(w)));
      const inName = banned(path.relative(engineSrc, file));
      if (inName) add('use-case-word', 0, `file name names a use case: "${inName}"`);
      const exported = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([\p{L}_$][\p{L}\d_$]*)|\bexport\s+(?:type\s+)?\{([^}]*)\}/gu;
      for (const m of code.matchAll(exported)) {
        const names = m[1] !== undefined ? [m[1]] : m[2]!.split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, ''));
        for (const name of names) {
          const w = name && banned(name);
          if (w) add('use-case-word', m.index, `exported identifier "${name}" names a use case: "${w}"`);
        }
      }
      for (const [a, b] of comments) {
        const w = banned(src.slice(a, b));
        if (w) add('use-case-word', a, `comment names a use case: "${w}"`);
      }
    }

    // WebGL and DOM are checked in the engine (content modules included); examples get the WebGL rule only (they own a
    // page). Apps are programs: they may use both.
    if (owner.kind === 'engine' && owner.module === 'sim') {
      const nondet = /\bMath\s*\.\s*(?:random|a?sinh?|a?cosh?|a?tanh?|atan2|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt)\b|\bDate\b|\bperformance\s*\.\s*now\b/g;
      for (const m of code.matchAll(nondet)) add('sim-nondeterministic', m.index, `not deterministic in sim: "${m[0].replace(/\s+/g, '')}"`);
    }
    if (owner.kind !== 'engine' && owner.kind !== 'example') continue;
    const mod = owner.kind === 'engine' ? owner.module : null;
    if (mod !== 'gpu') {
      for (const m of code.matchAll(/\bWebGL\w*|\bgl\s*\.\s*[A-Za-z_]\w*|\.getContext\s*\(/g)) add('webgl', m.index, `WebGL outside gpu: "${m[0].replace(/\s+/g, '')}"`);
      for (const m of src.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        if (code.slice(m.index, m.index + 6) !== 'import') continue;
        const t = targetOf(file, m[2]!);
        const fromGpu = t?.kind === 'engine' && (t.module === 'gpu' || t.module === null);
        if (fromGpu && /(^|[\s,])(type\s+)?GL(\s|,|$)/.test(m[1]!)) add('webgl', m.index, 'imports the raw WebGL context type GL');
      }
    }
    if (mod !== 'platform' && owner.kind !== 'example') {
      const dom = /(?<![.\w$])(?:document|window)\s*[.[]|\bHTML\w*Element\b|\b(?:requestAnimationFrame|cancelAnimationFrame|ResizeObserver|PointerEvent|KeyboardEvent|WheelEvent)\b/g;
      for (const m of code.matchAll(dom)) add('dom', m.index, `browser DOM outside platform: "${m[0].replace(/\s+/g, '')}"`);
      const worker = /\bnew\s+(?:Shared)?Worker\s*\(|\bimportScripts\s*\(|\.postMessage\s*\(|\.onmessage\b|\bMessageChannel\b/g;
      for (const m of code.matchAll(worker)) add('worker', m.index, `Worker API outside platform: "${m[0].replace(/\s+/g, '')}"`);
    }
  }
  return violations;
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(opt('root') ?? path.join(HERE, '..', '..'));
  const violations = check(root);
  if (argv.includes('--list')) for (const [m, l] of Object.entries(LAYERS)) console.log(`layer ${l}  ${m}`);
  for (const v of violations) console.log(`${v.file}:${v.line}  [${v.rule}]  ${v.message}`);
  console.log(`layers: ${violations.length} violation(s)`);
  process.exit(violations.length > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
