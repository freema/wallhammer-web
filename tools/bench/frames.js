// Aggregate frames-*.json across reps: median of per-rep values and spread (max-min)/median.
const j = require(process.argv[2]);
const med = a => { const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = a => { const m = med(a); const sp = (Math.max(...a) - Math.min(...a)) / m; return `${m.toFixed(2)} ±${(sp * 100).toFixed(0)}%${sp > 0.2 ? '!' : ''}`; };
const by = {};
for (const r of j.runs) (by[r.scenario] ??= []).push(r);
console.log(`size ${j.size} dpr ${j.dpr} n ${j.n}`);
for (const [sc, rs] of Object.entries(by)) {
  const row = {
    still: rs.map(r => med(r.still.wall)),
    stillTot: rs.map(r => r.still.totalMsPerFrame),
    shadowF: rs.map(r => med(r.shadow.wall)),
    pipe: rs.map(r => r.pipelined.totalMsPerFrame),
    cpuStill: rs.map(r => r.still.renderCpuMs),
    cpuShadow: rs.map(r => r.shadow.renderCpuMs),
    gShadow: rs.map(r => r.gpuPass?.gpu?.by?.['shadow|all'] ?? NaN),
    gColor: rs.map(r => r.gpuPass?.gpu?.by?.['color|all'] ?? NaN),
    gOverlay: rs.map(r => r.gpuPass?.gpu?.by?.['overlay|all'] ?? NaN),
    gColorStill: rs.map(r => r.gpuPassStill?.gpu?.by?.['color|all'] ?? NaN),
    own: rs.map(r => typeof r.own === 'number' ? r.own : NaN),
  };
  console.log(`\n== ${sc} (reps ${rs.length}) shadowFrames still ${rs[0].still.shadowFrames}/${rs[0].still.n}`);
  for (const [k, v] of Object.entries(row)) if (v.some(Number.isFinite)) console.log(`  ${k.padEnd(12)} ${fmt(v)}   [${v.map(x => x.toFixed(2)).join(' ')}]`);
  const keys = Object.keys(rs[0].off ?? {});
  for (const k of keys) {
    const base = k.startsWith('shadow') ? rs.map(r => med(r.shadow.wall)) : rs.map(r => med(r.still.wall));
    const d = rs.map((r, i) => base[i] - (r.off?.[k]?.wall ?? NaN));
    const dp = rs.map((r, i) => (k.startsWith('shadow') ? r.shadow.totalMsPerFrame : r.pipelined.totalMsPerFrame) - (r.off?.[k]?.pipelined ?? NaN));
    console.log(`  off ${k.padEnd(42)} save wall ${fmt(d)}  pipe ${fmt(dp)}`);
  }
}
