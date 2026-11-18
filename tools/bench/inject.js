// Page-side measurement probe for Wallhammer Web pages. Injected by bench.mjs before any page script runs
// (puppeteer evaluateOnNewDocument), so it sees every WebGL call from the first one. It changes no output: it only
// wraps WebGL methods and, after the page is ready, the renderer's prototypes (imported from the same module URLs the
// page loaded, so they are the same module instances) to time and count what already happens.
//
// window.__bench:
//   attach()                 patch Renderer / layers / EnvironmentLink prototypes (after __wh.ready)
//   frames(opts)             render n frames synchronously with per-pass / per-layer CPU and GPU timing
//   counts()                 counters and memory from the WebGL hooks (if installed)
//   longTasks(since)         long main-thread tasks seen by the PerformanceObserver
//   memory()                 live GPU objects by owner (bytes), from the hooks
//
// Config (second argument of evaluateOnNewDocument): { hooks: bool } — install the per-call WebGL counters.
// The counters cost CPU per GL call, so timing runs leave them off and counting runs turn them on.

// eslint-disable-next-line no-unused-vars
function __benchInstall(config) {
  const B = (window.__bench = {
    config,
    gl: null,
    ext: null,
    pass: 'startup',
    layer: '',
    counts: {},
    mem: new Map(),
    shader: { compileMs: 0, linkMs: 0, statusMs: 0, programs: 0, shaders: 0 },
    upload: { bufferMs: 0, bufferBytes: 0, textureMs: 0, textureBytes: 0, subBytes: 0 },
    tasks: [],
    renderer: null,
    view: null,
    link: null,
    rendersSeen: 0,
    timing: null,
    query: null,
    skip: new Set(),
  });

  // --- Long tasks ---------------------------------------------------------------------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) B.tasks.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* not supported */
  }
  B.longTasks = (since = 0) => B.tasks.filter((t) => t.start + t.ms >= since);

  // --- Context capture ------------------------------------------------------------------------------------------------
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (type === 'webgl2' && ctx && attrs && attrs.powerPreference === 'high-performance' && !B.gl) {
      B.gl = ctx;
      B.ctxAttrs = attrs;
      B.ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
      B.contextAt = performance.now();
    }
    return ctx;
  };

  // --- Owner of an allocation: the first stack frames outside the probe and the GPU upload path. ----------------------
  const SKIP_FRAME = /__bench|pptr:|\/gpu\/|render\/renderer\.ts|<anonymous>|evaluate|getContext/;
  function owner() {
    const lines = (new Error().stack || '').split('\n').slice(1);
    const out = [];
    for (const l of lines) {
      if (SKIP_FRAME.test(l)) continue;
      const m = /at (?:new )?([^\s(]+)? ?\(?(?:https?:\/\/[^/]+)?([^:)]*)/.exec(l.trim());
      if (!m) continue;
      const file = (m[2] || '').split('/').pop().split('?')[0];
      out.push(`${m[1] || '?'}@${file}`);
      if (out.length >= 4) break;
    }
    return out.join(' < ');
  }

  if (!config.hooks) return;

  // --- WebGL hooks ---------------------------------------------------------------------------------------------------
  const P = WebGL2RenderingContext.prototype;
  const C = WebGL2RenderingContext;
  const bucket = () => {
    const k = B.pass;
    let c = B.counts[k];
    if (!c) c = B.counts[k] = { draws: 0, tris: 0, instances: 0, instancedDraws: 0, state: 0, programs: 0, vaos: 0, textures: 0, uniforms: 0, subBytes: 0, byLayer: {} };
    return c;
  };
  const layerBucket = (c) => {
    const k = B.layer || '-';
    let l = c.byLayer[k];
    if (!l) l = c.byLayer[k] = { draws: 0, tris: 0, instances: 0 };
    return l;
  };
  const tri = (mode, count) => (mode === C.TRIANGLES ? count / 3 : mode === C.TRIANGLE_STRIP ? Math.max(0, count - 2) : 0);
  const wrap = (name, fn) => {
    const orig = P[name];
    if (!orig) return;
    P[name] = function (...a) {
      if (this === B.gl) fn.call(this, a);
      return orig.apply(this, a);
    };
  };
  const draw = (mode, count, inst) => {
    const c = bucket();
    const l = layerBucket(c);
    const t = tri(mode, count) * inst;
    c.draws++;
    c.tris += t;
    l.draws++;
    l.tris += t;
    if (inst > 1 || inst === 0) {
      c.instances += inst;
      c.instancedDraws++;
      l.instances += inst;
    }
  };
  wrap('drawElements', (a) => draw(a[0], a[1], 1));
  wrap('drawArrays', (a) => draw(a[0], a[2], 1));
  wrap('drawElementsInstanced', (a) => draw(a[0], a[1], a[4]));
  wrap('drawArraysInstanced', (a) => draw(a[0], a[2], a[3]));
  for (const n of ['enable', 'disable', 'depthFunc', 'depthMask', 'blendFunc', 'blendFuncSeparate', 'polygonOffset', 'cullFace', 'bindFramebuffer', 'viewport', 'activeTexture', 'bindBuffer']) {
    wrap(n, () => bucket().state++);
  }
  wrap('useProgram', () => {
    const c = bucket();
    c.state++;
    c.programs++;
  });
  wrap('bindVertexArray', () => {
    const c = bucket();
    c.state++;
    c.vaos++;
  });
  for (const n of Object.getOwnPropertyNames(P)) {
    if (/^uniform(\d|Matrix)/.test(n)) wrap(n, () => bucket().uniforms++);
  }

  // Bindings for memory accounting.
  const boundBuf = new Map();
  let activeUnit = 0;
  const boundTex = new Map();
  const origBindBuffer = P.bindBuffer;
  P.bindBuffer = function (target, buf) {
    if (this === B.gl) boundBuf.set(target, buf);
    return origBindBuffer.call(this, target, buf);
  };
  const origActive = P.activeTexture;
  P.activeTexture = function (u) {
    if (this === B.gl) activeUnit = u;
    return origActive.call(this, u);
  };
  const origBindTex = P.bindTexture;
  P.bindTexture = function (target, t) {
    if (this === B.gl) {
      bucket().textures++;
      boundTex.set(`${activeUnit}:${target}`, t);
    }
    return origBindTex.call(this, target, t);
  };
  const origBindVao = P.bindVertexArray;
  const vaoElement = new Map();
  let curVao = null;
  P.bindVertexArray = function (v) {
    if (this === B.gl) {
      curVao = v;
      boundBuf.set(C.ELEMENT_ARRAY_BUFFER, vaoElement.get(v) ?? null);
    }
    return origBindVao.call(this, v);
  };
  const origBindBuffer2 = P.bindBuffer;
  P.bindBuffer = function (target, buf) {
    if (this === B.gl && target === C.ELEMENT_ARRAY_BUFFER && curVao) vaoElement.set(curVao, buf);
    return origBindBuffer2.call(this, target, buf);
  };

  const record = (obj, kind, bytes) => {
    if (!obj) return;
    const prev = B.mem.get(obj);
    B.mem.set(obj, { kind, bytes, owner: prev?.owner ?? owner(), at: performance.now() });
  };
  const origBufferData = P.bufferData;
  P.bufferData = function (target, src, usage, srcOffset, length) {
    if (this !== B.gl) return origBufferData.apply(this, arguments);
    const t0 = performance.now();
    const r = origBufferData.apply(this, arguments);
    const bytes = typeof src === 'number' ? src : length ? length * (src.BYTES_PER_ELEMENT ?? 1) : src.byteLength - (srcOffset ?? 0) * (src.BYTES_PER_ELEMENT ?? 1);
    B.upload.bufferMs += performance.now() - t0;
    B.upload.bufferBytes += bytes;
    record(boundBuf.get(target), target === C.UNIFORM_BUFFER ? 'uniform' : target === C.ELEMENT_ARRAY_BUFFER ? 'index' : 'vertex', bytes);
    return r;
  };
  const origBufferSub = P.bufferSubData;
  P.bufferSubData = function (target, off, src, srcOffset, length) {
    if (this === B.gl) {
      const bpe = src.BYTES_PER_ELEMENT ?? 1;
      const bytes = length ? length * bpe : src.byteLength - (srcOffset ?? 0) * bpe;
      bucket().subBytes += bytes;
      B.upload.subBytes += bytes;
    }
    return origBufferSub.apply(this, arguments);
  };
  const BPP = new Map([
    [C.R8, 1], [C.R8UI, 1], [C.RG8, 2], [C.RGBA8, 4], [C.RGB8, 3], [C.SRGB8_ALPHA8, 4], [C.R16F, 2], [C.RG16F, 4], [C.RGBA16F, 8],
    [C.R32F, 4], [C.RG32F, 8], [C.RGBA32F, 16], [C.R16UI, 2], [C.R32UI, 4], [C.DEPTH_COMPONENT24, 4], [C.DEPTH_COMPONENT32F, 4], [C.DEPTH_COMPONENT16, 2],
    [C.DEPTH24_STENCIL8, 4], [C.RGBA, 4], [C.RGB, 3], [C.LUMINANCE, 1], [C.ALPHA, 1],
  ]);
  const origTexImage2D = P.texImage2D;
  P.texImage2D = function (target, level, internal, w, h) {
    if (this !== B.gl || arguments.length < 9 || level !== 0) return origTexImage2D.apply(this, arguments);
    const t0 = performance.now();
    const r = origTexImage2D.apply(this, arguments);
    const bytes = w * h * (BPP.get(internal) ?? 4);
    B.upload.textureMs += performance.now() - t0;
    B.upload.textureBytes += bytes;
    record(boundTex.get(`${activeUnit}:${target}`), 'texture', bytes);
    return r;
  };
  const origTexStorage = P.texStorage2D;
  P.texStorage2D = function (target, levels, internal, w, h) {
    if (this === B.gl) record(boundTex.get(`${activeUnit}:${target}`), 'texture', w * h * (BPP.get(internal) ?? 4) * (levels > 1 ? 4 / 3 : 1));
    return origTexStorage.apply(this, arguments);
  };
  const origMip = P.generateMipmap;
  P.generateMipmap = function (target) {
    if (this === B.gl) {
      const t = boundTex.get(`${activeUnit}:${target}`);
      const e = B.mem.get(t);
      if (e && !e.mip) {
        e.bytes = Math.round((e.bytes * 4) / 3);
        e.mip = true;
      }
    }
    return origMip.apply(this, arguments);
  };
  const origRbs = P.renderbufferStorageMultisample;
  const rbBound = { rb: null };
  const origBindRb = P.bindRenderbuffer;
  P.bindRenderbuffer = function (t, rb) {
    if (this === B.gl) rbBound.rb = rb;
    return origBindRb.apply(this, arguments);
  };
  P.renderbufferStorageMultisample = function (t, samples, internal, w, h) {
    if (this === B.gl) record(rbBound.rb, 'renderbuffer', w * h * (BPP.get(internal) ?? 4) * Math.max(1, samples));
    return origRbs.apply(this, arguments);
  };
  for (const n of ['deleteBuffer', 'deleteTexture', 'deleteRenderbuffer']) {
    const orig = P[n];
    P[n] = function (o) {
      if (this === B.gl) B.mem.delete(o);
      return orig.apply(this, arguments);
    };
  }

  // Shader work. ANGLE compiles lazily: the cost lands on the first status query (or the first draw).
  const timed = (name, key) => {
    const orig = P[name];
    P[name] = function () {
      if (this !== B.gl) return orig.apply(this, arguments);
      const t0 = performance.now();
      const r = orig.apply(this, arguments);
      B.shader[key] += performance.now() - t0;
      return r;
    };
  };
  timed('compileShader', 'compileMs');
  timed('linkProgram', 'linkMs');
  timed('getProgramParameter', 'statusMs');
  timed('getShaderParameter', 'statusMs');
  wrap('createProgram', () => B.shader.programs++);
  wrap('createShader', () => B.shader.shaders++);

  B.resetCounts = () => {
    B.counts = {};
  };
  B.memory = () => {
    const byOwner = {};
    let total = 0;
    for (const e of B.mem.values()) {
      const k = `${e.kind}|${e.owner}`;
      const o = (byOwner[k] ??= { kind: e.kind, owner: e.owner, bytes: 0, objects: 0 });
      o.bytes += e.bytes;
      o.objects++;
      total += e.bytes;
    }
    return { total, objects: B.mem.size, byOwner: Object.values(byOwner).sort((a, b) => b.bytes - a.bytes) };
  };
}

// Patching after the page is ready: lives outside __benchInstall so it can be evaluated later as well.
// eslint-disable-next-line no-unused-vars
async function __benchAttach() {
  const B = window.__bench;
  if (B.attached) return B.attached;
  const urls = performance.getEntriesByType('resource').map((e) => e.name);
  const find = (re) => urls.find((u) => re.test(u));
  const rUrl = find(/\/render\/renderer\.ts/);
  const lUrl = find(/\/runtime\/environment-link\.ts/);
  if (!rUrl) throw new Error('renderer.ts not among loaded resources');
  const R = await import(rUrl);
  const L = lUrl ? await import(lUrl) : null;
  const proto = R.Renderer.prototype;
  const origRender = proto.render;
  const origDrawPass = proto.drawPass;
  const origFit = proto.fitLight;
  const T = (B.timing = null);
  void T;
  const gl = () => B.gl;
  const ext = () => B.ext;

  // Query pool for GPU timing.
  const qpool = [];
  const pending = [];
  const beginQ = (label) => {
    const g = gl();
    const e = ext();
    if (!B.query || !g || !e) return null;
    const q = qpool.pop() ?? g.createQuery();
    g.beginQuery(e.TIME_ELAPSED_EXT, q);
    return { q, label };
  };
  const endQ = (h) => {
    if (!h) return;
    gl().endQuery(ext().TIME_ELAPSED_EXT);
    pending.push({ ...h, frame: B.frameNo ?? 0 });
  };
  B.collectQueries = async (maxWaitMs = 3000) => {
    const g = gl();
    const e = ext();
    const out = [];
    const t0 = performance.now();
    while (pending.length) {
      const p = pending[0];
      if (!g.getQueryParameter(p.q, g.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() - t0 > maxWaitMs) break;
        await new Promise((r) => setTimeout(r, 4));
        continue;
      }
      const disjoint = g.getParameter(e.GPU_DISJOINT_EXT);
      out.push({ label: p.label, frame: p.frame, ms: g.getQueryParameter(p.q, g.QUERY_RESULT) / 1e6, disjoint });
      qpool.push(p.q);
      pending.shift();
    }
    return { results: out, lost: pending.splice(0).length };
  };

  const wrapLayer = (layer, i) => {
    if (layer.__benchWrapped) return;
    layer.__benchWrapped = true;
    const name = `${i}:${layer.name || `${layer.constructor?.name ?? 'Layer'}${layer.material?.name ? `(${layer.material.name})` : ''}`}`;
    layer.__benchName = name;
    const draw = layer.draw;
    layer.draw = function (ctx) {
      const t = B.timing;
      if (B.skip.has(name) || B.skip.has(`${ctx.pass}:${name}`)) return;
      if (!t) return draw.call(this, ctx);
      const prevLayer = B.layer;
      B.layer = name;
      const q = B.query === 'layer' ? beginQ(`${ctx.pass}|${name}`) : null;
      // A context whose count() also notes that this layer drew something in this pass.
      let drew = 0;
      const c2 = Object.create(ctx);
      c2.count = (tris) => {
        drew++;
        ctx.count(tris);
      };
      const t0 = performance.now();
      draw.call(this, c2);
      const dt = performance.now() - t0;
      endQ(q);
      B.layer = prevLayer;
      const k = `${ctx.pass}|${name}`;
      t.layers[k] = (t.layers[k] ?? 0) + dt;
      if (drew) t.drew[k] = (t.drew[k] ?? 0) + drew;
    };
    if (layer.cull) {
      const cull = layer.cull;
      layer.cull = function (vol, purpose) {
        const t = B.timing;
        const t0 = performance.now();
        const r = cull.call(this, vol, purpose);
        if (t) {
          const k = `cull-${purpose}|${name}`;
          t.layers[k] = (t.layers[k] ?? 0) + performance.now() - t0;
        }
        return r;
      };
    }
  };

  proto.render = function (view) {
    B.renderer = this;
    B.view = view;
    B.rendersSeen++;
    this.layers.forEach(wrapLayer);
    const t = B.timing;
    const prevPass = B.pass;
    B.pass = 'frame';
    const t0 = performance.now();
    const r = origRender.call(this, view);
    if (t) {
      t.renderMs += performance.now() - t0;
      t.frames++;
      if (r.shadowDrawCalls > 0) t.shadowFrames++;
    }
    B.pass = prevPass === 'startup' ? 'idle' : prevPass;
    return r;
  };
  proto.drawPass = function (pass, view, stats) {
    const t = B.timing;
    B.pass = pass;
    const q = B.query === 'pass' ? beginQ(`${pass}|all`) : null;
    const t0 = performance.now();
    origDrawPass.call(this, pass, view, stats);
    const dt = performance.now() - t0;
    endQ(q);
    B.pass = 'frame';
    if (t) t.passes[pass] = (t.passes[pass] ?? 0) + dt;
  };
  proto.fitLight = function (...a) {
    const t = B.timing;
    const t0 = performance.now();
    const r = origFit.apply(this, a);
    if (t) t.passes.fitLight = (t.passes.fitLight ?? 0) + performance.now() - t0;
    return r;
  };
  if (L) {
    const lp = L.EnvironmentLink.prototype;
    const origUpdate = lp.update;
    lp.update = function (renderer, view) {
      B.link = this;
      const t = B.timing;
      const t0 = performance.now();
      origUpdate.call(this, renderer, view);
      if (t) t.passes.environment = (t.passes.environment ?? 0) + performance.now() - t0;
    };
  }
  B.attached = { rUrl, lUrl };
  return B.attached;
}

// Synchronous frame loop with full breakdown. opts: { n, forceShadow, query: null|'pass'|'layer', step: seconds of env
// time per frame, finishEach: bool }
// eslint-disable-next-line no-unused-vars
async function __benchFrames(opts) {
  const B = window.__bench;
  const r = B.renderer;
  const view = B.view;
  if (!r || !view) throw new Error('no render seen yet');
  const g = B.gl;
  const px = new Uint8Array(4);
  const finish = () => g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
  const n = opts.n ?? 30;
  const env = B.link?.env;
  const t0env = env ? env.time.time : 0;
  // Warm-up frame (also takes the shadow map if needed), then measure.
  r.render(view);
  finish();
  B.query = opts.query ?? null;
  const timing = (B.timing = { frames: 0, shadowFrames: 0, renderMs: 0, passes: {}, layers: {}, drew: {} });
  if (B.resetCounts) B.resetCounts();
  const wall = [];
  const cpu = [];
  const tAll0 = performance.now();
  for (let i = 0; i < n; i++) {
    B.frameNo = i;
    if (opts.step && env) env.time.set(env.time.time + opts.step);
    if (opts.forceShadow) r.invalidateShadows();
    const f0 = performance.now();
    const before = timing.renderMs;
    r.render(view);
    cpu.push(timing.renderMs - before);
    if (opts.finishEach !== false) {
      finish();
      wall.push(performance.now() - f0);
    }
  }
  finish();
  const totalMs = performance.now() - tAll0;
  // Cost of the synchronising read itself with nothing pending: subtract it from 'wall' to get CPU + GPU.
  const sync = [];
  for (let i = 0; i < 9; i++) {
    const s0 = performance.now();
    finish();
    sync.push(performance.now() - s0);
  }
  sync.sort((a, b) => a - b);
  B.timing = null;
  B.query = null;
  const counts = B.counts;
  const q = opts.query ? await B.collectQueries() : null;
  if (env && opts.step) env.time.set(t0env);
  const per = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / n]));
  let gpu = null;
  if (q) {
    const by = {};
    let disjoint = false;
    for (const x of q.results) {
      by[x.label] = (by[x.label] ?? 0) + x.ms / n;
      disjoint ||= x.disjoint;
    }
    gpu = { by, lost: q.lost, disjoint, sum: Object.values(by).reduce((a, b) => a + b, 0) };
  }
  const perCounts = {};
  for (const [k, c] of Object.entries(counts)) {
    const byLayer = {};
    for (const [lk, lv] of Object.entries(c.byLayer)) byLayer[lk] = { draws: lv.draws / n, tris: lv.tris / n, instances: lv.instances / n };
    perCounts[k] = { draws: c.draws / n, tris: c.tris / n, instances: c.instances / n, instancedDraws: c.instancedDraws / n, state: c.state / n, programs: c.programs / n, vaos: c.vaos / n, textures: c.textures / n, uniforms: c.uniforms / n, subBytes: c.subBytes / n, byLayer };
  }
  return {
    n,
    canvas: [g.drawingBufferWidth, g.drawingBufferHeight],
    totalMsPerFrame: totalMs / n,
    syncMs: sync[4],
    wall,
    cpu,
    renderCpuMs: timing.renderMs / n,
    shadowFrames: timing.shadowFrames,
    passes: per(timing.passes),
    layers: per(timing.layers),
    drew: per(timing.drew),
    gpu,
    counts: perCounts,
    stats: r.lastStats,
  };
}
