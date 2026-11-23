#!/bin/sh
# Check of the published shape of the wallhammer-web package: packs it (build included, as `pnpm publish` would),
# installs the tarball into an empty project outside the workspace and, there,
#   - imports every entry of the package in plain Node (the built JavaScript resolves and loads),
#   - finds the files a user needs (the README, the licence, the agent pages docs/agents.md and docs/cookbook.md that
#     the Claude Code plugin points to),
#   - runs the package's `bin` (`wallhammer-marks list`) on an empty folder,
#   - type-checks a small program against the packed declarations (module resolution `nodenext`), the Node-only entry
#     `wallhammer-web/marks-store` included (without Node's or Vite's types).
# Needs the network for the package's own dependency. Run in the dev container: pnpm check:pack
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT/packages/wallhammer-web"
pnpm pack --pack-destination "$WORK" >/dev/null
TARBALL=$(ls "$WORK"/wallhammer-web-*.tgz)
FILES=$(tar -tzf "$TARBALL" | wc -l | tr -d ' ')
BYTES=$(wc -c < "$TARBALL" | tr -d ' ')
echo "pack: $(basename "$TARBALL"), $FILES files, $BYTES bytes"
if tar -tzf "$TARBALL" | grep -q '^package/src/'; then echo "pack: FAIL the tarball contains src/"; exit 1; fi
for f in package/LICENSE package/README.md package/dist/index.js package/dist/index.d.ts package/dist/marks-store/cli.js package/docs/agents.md package/docs/cookbook.md; do
  tar -tzf "$TARBALL" | grep -qx "$f" || { echo "pack: FAIL the tarball lacks $f"; exit 1; }
done

mkdir "$WORK/consumer"
cd "$WORK/consumer"
printf '{ "name": "consumer", "private": true, "type": "module" }\n' > package.json
npm install --no-audit --no-fund --loglevel=error "$TARBALL" >/dev/null

# The bin: a shebang, executable once installed, and it runs from dist on an empty store folder.
CLI=node_modules/wallhammer-web/dist/marks-store/cli.js
head -n 1 "$CLI" | grep -qx '#!/usr/bin/env node' || { echo "pack: FAIL $CLI has no node shebang"; exit 1; }
[ -x node_modules/.bin/wallhammer-marks ] || { echo "pack: FAIL the bin wallhammer-marks is not installed as an executable"; exit 1; }
mkdir "$WORK/marks"
OUT=$(node_modules/.bin/wallhammer-marks list --dir "$WORK/marks")
echo "$OUT" | grep -q '^No marks yet' || { echo "pack: FAIL wallhammer-marks list on an empty folder said: $OUT"; exit 1; }
[ "$(node_modules/.bin/wallhammer-marks list --json --dir "$WORK/marks")" = "[]" ] || { echo "pack: FAIL wallhammer-marks list --json on an empty folder"; exit 1; }
echo "bin: wallhammer-marks list runs from dist on an empty folder"

cat > smoke.mjs <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('node_modules/wallhammer-web/package.json', 'utf8'));
let names = 0;
for (const key of Object.keys(pkg.exports)) {
  const entry = key === '.' ? 'wallhammer-web' : `wallhammer-web/${key.slice(2)}`;
  const mod = await import(entry);
  const n = Object.keys(mod).length;
  if (n === 0) throw new Error(`${entry} exports nothing`);
  names += n;
}
const { marksStore } = await import('wallhammer-web/marks-store');
const plugin = marksStore({ dir: '.marks' });
if (plugin.apply !== 'serve' || typeof plugin.configureServer !== 'function') throw new Error('marksStore is not a dev-server plugin');
const { HeightField } = await import('wallhammer-web/gen-core');
const { CollisionWorld } = await import('wallhammer-web/world');
const field = new HeightField(4, 3, 3, Float32Array.from({ length: 9 }, (_, i) => i));
const world = new CollisionWorld({ heightAt: (x, z) => field.heightAt(x, z) });
if (typeof world.groundAt !== 'function') throw new Error('CollisionWorld has no groundAt');
console.log(`smoke: ${Object.keys(pkg.exports).length} entries imported in Node ${process.version}, ${names} exported names (package ${pkg.name}@${pkg.version})`);
JS
node smoke.mjs

cat > types.ts <<'TS'
import { HeightField } from 'wallhammer-web/gen-core';
import { CollisionWorld, Walker } from 'wallhammer-web/world';
import type { MeshData } from 'wallhammer-web/base';
import { Simulation } from 'wallhammer-web/sim';
import * as engine from 'wallhammer-web';
import { marksStore } from 'wallhammer-web/marks-store';
import type { MarksStorePlugin } from 'wallhammer-web/marks-store';
import { installMarking } from 'wallhammer-web/platform';
import type { Mark } from 'wallhammer-web/base';

const field: HeightField = new HeightField(4, 3, 3, new Float32Array(9));
const world = new CollisionWorld({ heightAt: (x: number, z: number) => field.heightAt(x, z) });
export type { MeshData };
const plugin: MarksStorePlugin = marksStore({ dir: '.marks' });
export type { Mark };
export { world, Walker, Simulation, engine, plugin, installMarking };
TS
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "skipLibCheck": false, "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": [] }, "files": ["types.ts"] }
JSON
"$ROOT/packages/wallhammer-web/node_modules/.bin/tsc" -p tsconfig.json
echo "types: a program type-checks against the packed declarations (nodenext, skipLibCheck off)"
echo "ok: the packed package installs, loads and type-checks"
