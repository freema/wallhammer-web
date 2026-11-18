// One port for all examples. `/` lists the examples, `/<name>/` is the example in examples/<name>. Every example keeps
// its own Vite dev server (its vite.config.ts, its root, its public folder, its workers), here in middleware mode with
// the base `/<name>/`, so the pages need no change: `import.meta.env.BASE_URL` and the URLs Vite writes carry the
// prefix. All of them share one HTTP server, also for the HMR web socket (Vite tells its socket apart by the base).
//
// A Vite server starts on the first request for its example: an example nobody opens costs nothing (no file watcher,
// no polling, no transforms). The list of examples is read from the folder on every request, so a new example (a
// folder with index.html) needs no restart.
//
//   node tools/serve/serve.ts        (scripts/dev-entrypoint.sh in the dev container; port 5281, or WH_PORT)
//
// `/__health` answers 200 as soon as the server listens (the health check of docker-compose.yml).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer, type ViteDevServer } from 'vite';

const EXAMPLES = fileURLToPath(new URL('../../examples/', import.meta.url));
const PORT = Number(process.env.WH_PORT ?? '5281');
const NAME = /^[a-z0-9][a-z0-9-]*$/;

interface Example {
  name: string;
  title: string;
  description: string;
  /** Further pages of the example (other .html files in its folder), e.g. endless/sphere.html. */
  pages: string[];
}

/** Whether examples/<name> is an example (a folder with index.html). */
function isExample(name: string): boolean {
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

function listExamples(): Example[] {
  return fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isExample(e.name))
    .map((e) => readExample(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function indexPage(): string {
  const items = listExamples()
    .map((e) => {
      const more = e.pages.map((p) => ` · <a href="/${e.name}/${esc(p)}">${esc(p)}</a>`).join('');
      return `<li><a href="/${e.name}/"><b>${esc(e.name)}</b></a> <span>${esc(e.title)}</span>${more}<p>${esc(e.description)}</p></li>`;
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
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 16px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 12px 0; border-top: 1px solid #2a2c33; }
  a { color: #8fb8ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  span { color: #9a9ca6; margin-left: 8px; }
  p { margin: 4px 0 0; color: #b4b6be; }
</style>
</head>
<body>
<main>
<h1>Wallhammer Web: examples</h1>
<ul>
${items}
</ul>
</main>
</body>
</html>
`;
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

const httpServer = http.createServer();

/** Vite servers by example name, created on first use; `started` holds those that are up. */
const vites = new Map<string, Promise<ViteDevServer>>();
const started = new Map<string, ViteDevServer>();

function viteFor(name: string): Promise<ViteDevServer> {
  let p = vites.get(name);
  if (p) return p;
  const root = path.join(EXAMPLES, name);
  const t0 = performance.now();
  p = createServer({
    root,
    base: `/${name}/`,
    clearScreen: false,
    customLogger: createLogger('info', { prefix: `[${name}]`, allowClearScreen: false }),
    server: { middlewareMode: true, port: PORT, ws: { server: httpServer } },
  }).then((vite) => {
    started.set(name, vite);
    console.log(`[serve] ${name}: dev server up in ${(performance.now() - t0).toFixed(0)} ms`);
    return vite;
  });
  // A failed start (a broken vite.config.ts) is retried on the next request.
  p.catch((e: unknown) => {
    vites.delete(name);
    console.error(`[serve] ${name}: dev server failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  });
  vites.set(name, p);
  return p;
}

httpServer.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (pathname === '/__health') return send(res, 200, 'text/plain', 'ok\n');
  if (pathname === '/' || pathname === '/index.html') return send(res, 200, 'text/html', indexPage());
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const name = m?.[1] ?? '';
  if (!isExample(name)) {
    return send(res, 404, 'text/html', `<!doctype html><title>Not found</title><p>No example at ${esc(pathname)}. <a href="/">All examples</a></p>`);
  }
  if (m?.[2] === undefined) {
    res.writeHead(302, { location: `/${name}/${url.search}` });
    res.end();
    return;
  }
  viteFor(name).then(
    (vite) => vite.middlewares(req, res, () => send(res, 404, 'text/plain', `not found: ${pathname}\n`)),
    (e: unknown) => send(res, 500, 'text/plain', `dev server of ${name} failed:\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`),
  );
});

// The HMR socket of a page is answered by the upgrade listener its Vite server added to httpServer. When that server
// does not run yet (an open tab after a restart pings for the server), start it and hand the request over again.
httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  const name = /^\/([^/?]+)\//.exec(req.url ?? '')?.[1] ?? '';
  if (started.has(name)) return;
  if (!isExample(name)) {
    socket.destroy();
    return;
  }
  viteFor(name).then(
    () => httpServer.emit('upgrade', req, socket, head),
    () => socket.destroy(),
  );
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const names = listExamples().map((e) => e.name);
  console.log(`[serve] examples on port ${PORT}: / lists them, /<name>/ opens one (${names.join(', ')})`);
});

function shutdown(): void {
  setTimeout(() => process.exit(0), 3000).unref();
  void Promise.allSettled([...started.values()].map((v) => v.close())).then(() => process.exit(0));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
