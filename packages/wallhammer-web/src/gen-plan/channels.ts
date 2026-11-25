// What can be read off a network of channels (`Channels` of `traceChannels`) without the grid: the stream order of every
// channel from the `into` links, the gathered flow along every channel, and a classifier that turns a value into the
// index of the band of thresholds it falls in. The caller gives the classes their meaning (a width, a profile, a way
// of drawing). Exact and order-fixed: integer arithmetic for the order, copies of float32 values for the flow, plain
// comparisons for the classes.

import type { Channels } from './drain.ts';

/**
 * Strahler order per channel. A channel that nothing runs into has order 1; one that channels run into takes the
 * highest order among them, plus 1 when two or more of them share that highest order. Channels must come before the
 * channels they run into (as `traceChannels` orders them, upstream first); otherwise it throws. An `into` below 0 (a
 * base node, a pool) ends the links. Orders above 255 are held at 255.
 */
export function channelOrder(ch: Pick<Channels, 'into'>): Uint8Array {
  const into = ch.into;
  const count = into.length;
  const order = new Uint8Array(count);
  // Per channel: the highest order among the channels that run into it, and how many share it (capped at 2).
  const top = new Uint8Array(count);
  const ties = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    const o = top[c] === 0 ? 1 : Math.min(255, top[c]! + (ties[c]! >= 2 ? 1 : 0));
    order[c] = o;
    const t = into[c]!;
    if (t < 0) continue;
    if (t <= c || t >= count) throw new Error(`gen-plan: channel ${c} runs into channel ${t}, which does not come after it`);
    if (o > top[t]!) {
      top[t] = o;
      ties[t] = 1;
    } else if (o === top[t]! && ties[t]! < 2) ties[t] = ties[t]! + 1;
  }
  return order;
}

/** What `channelFlow` returns. */
export interface ChannelFlow {
  /** Per entry of `Channels.nodes`: the gathered flow of that node. */
  along: Float32Array;
  /**
   * Per channel: the flow it hands on, the gathered flow of its last own node (the entry before its end node, which it
   * shares with what it runs into); the flow of its only node for a channel of one entry.
   */
  out: Float32Array;
}

/**
 * The gathered flow along every channel, read from one value per node (`Drainage.flow`, or any other field gathered
 * downstream). Flow grows downstream along `to`, so `along` never falls within a channel when `flow` is a gathered flow.
 */
export function channelFlow(ch: Pick<Channels, 'start' | 'nodes'>, flow: ArrayLike<number>): ChannelFlow {
  const { start, nodes } = ch;
  const along = new Float32Array(nodes.length);
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k]!;
    if (n >= flow.length) throw new Error(`gen-plan: node ${n} has no flow (${flow.length} values)`);
    along[k] = flow[n]!;
  }
  const count = start.length - 1;
  const out = new Float32Array(Math.max(0, count));
  for (let c = 0; c < count; c++) {
    const a = start[c]!;
    const b = start[c + 1]!;
    out[c] = b - a >= 2 ? along[b - 2]! : b > a ? along[a]! : 0;
  }
  return { along, out };
}

/**
 * The class of every value: how many of the ascending `thresholds` it reaches (value ≥ threshold), so 0 below the
 * first, `thresholds.length` from the last on. NaN is class 0. At most 255 thresholds; they must not decrease.
 */
export function classifyByThresholds(values: ArrayLike<number>, thresholds: ArrayLike<number>): Uint8Array {
  const m = thresholds.length;
  if (m > 255) throw new Error(`gen-plan: ${m} thresholds, at most 255`);
  for (let k = 0; k < m; k++) {
    if (Number.isNaN(thresholds[k]!)) throw new Error(`gen-plan: threshold ${k} is NaN`);
    if (k > 0 && thresholds[k]! < thresholds[k - 1]!) throw new Error('gen-plan: thresholds must not decrease');
  }
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    // Binary search for the first threshold above v.
    let lo = 0;
    let hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v >= thresholds[mid]!) lo = mid + 1;
      else hi = mid;
    }
    out[i] = lo;
  }
  return out;
}
