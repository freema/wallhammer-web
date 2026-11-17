// The provider port (Wallhammer Zero `gen_provider` / `asset_provider`): where the content of a cell comes from.
// A cell can come from a generator or from a pre-baked file in the same format; the streaming manager does not know
// which. The level of detail is the cell's quadtree level, so `request(cell)` names both the place and the detail.
//
// Implementations here are plain logic and run in Node: a generator on the calling thread (the fallback for headless
// runs and tests, and for browsers without workers) and a file provider over any fetch function. The worker-backed
// generator lives in `runtime`, because workers belong to `platform`.
//
// Edits: a generator provider may get a source of edits text per cell (`CellEdits`) and hands a non-empty text to the
// generator as its third argument. The file provider and the cache (cell-cache.ts) know nothing of edits.

import type { CellContent, CellId } from '../gen-core/cell.ts';
import { decodeCell, encodeCell, cellFilePath } from './cell-format.ts';

/** A pure generator: world seed and cell in, content out. It reads nothing else (no clock, no files, no globals). */
export type CellGenerator = (seed: number, cell: CellId) => CellContent;

/**
 * A pure generator that also takes edits: opaque text of what changed in the cell since it was generated (the content
 * decides its form). Absent or '' means the cell as generated, the same bytes as the call without it. The content is a
 * function of (seed, cell, edits) alone. A separate type, so generators whose own optional third argument means
 * something else stay plain `CellGenerator`s.
 */
export type EditableCellGenerator = (seed: number, cell: CellId, edits?: string) => CellContent;

/** Source of the edits text of a cell for a provider; '' when nothing changed there. Read when a request starts. */
export type CellEdits = (cell: CellId) => string;

/** Where a finished request came from (Luanti-style emerge origins). */
export type CellOrigin = 'generated' | 'file' | 'memory';

export interface CellResult {
  content: CellContent;
  /** The encoded bytes the content was decoded from, when there were any (a worker or a file). */
  bytes: Uint8Array | null;
  origin: CellOrigin;
}

export interface CellProvider {
  readonly name: string;
  /**
   * True when `request` does its work synchronously on the calling thread. The execution part then calls it only
   * within the frame's time budget.
   */
  readonly blocking: boolean;
  /** Content of a cell. Rejects with an `AbortError`-named error when the signal fires first. */
  request(cell: CellId, signal: AbortSignal): Promise<CellResult>;
}

function aborted(): Error {
  const e = new Error('cell request cancelled');
  e.name = 'AbortError';
  return e;
}

/** Runs a pure generator on the calling thread. */
export class GeneratorCellProvider implements CellProvider {
  readonly name = 'generator (main thread)';
  readonly blocking = true;
  readonly seed: number;
  private readonly generate: EditableCellGenerator;
  private readonly edits: CellEdits | undefined;

  /** With `edits`, a cell whose edits text is not empty is generated with it; every other call is `generate(seed, cell)`. */
  constructor(seed: number, generate: CellGenerator);
  constructor(seed: number, generate: EditableCellGenerator, edits?: CellEdits);
  constructor(seed: number, generate: EditableCellGenerator, edits?: CellEdits) {
    this.seed = seed;
    this.generate = generate;
    this.edits = edits;
  }

  /** Synchronous core, also used by bakers and tests. */
  generateNow(cell: CellId): CellContent {
    return this.run(cell);
  }

  /** Encoded bytes of a cell, exactly what a worker or a baked file hands over. */
  bytes(cell: CellId): Uint8Array {
    return encodeCell(this.run(cell));
  }

  request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
    if (signal.aborted) return Promise.reject(aborted());
    try {
      return Promise.resolve({ content: this.run(cell), bytes: null, origin: 'generated' });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private run(cell: CellId): CellContent {
    const text = this.edits ? this.edits(cell) : '';
    return text ? this.generate(this.seed, cell, text) : this.generate(this.seed, cell);
  }
}

/** Fetches bytes of a URL; rejects on a missing file. A browser passes `fetchBytes` from platform. */
export type BytesFetcher = (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;

/**
 * Reads pre-baked cells (`<baseUrl>/<face>/<level>/<x>/<y>.whc`) through a fetch function. With `shapeHash` (the hash
 * of the world shape, `shapeHash` of gen-core) the files are read from `<baseUrl>/s<hash>/…` and a file that states
 * another shape is rejected.
 */
export class FileCellProvider implements CellProvider {
  readonly name: string;
  readonly blocking = false;
  readonly baseUrl: string;
  readonly shapeHash: number | undefined;
  private readonly fetch: BytesFetcher;

  constructor(baseUrl: string, fetch: BytesFetcher, options: { shapeHash?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetch;
    this.shapeHash = options.shapeHash;
    this.name = `files (${this.baseUrl})`;
  }

  url(cell: CellId): string {
    return `${this.baseUrl}/${cellFilePath(cell, this.shapeHash)}`;
  }

  async request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
    const buf = await this.fetch(this.url(cell), signal);
    if (signal.aborted) throw aborted();
    const bytes = new Uint8Array(buf);
    const content = decodeCell(bytes);
    if (this.shapeHash !== undefined && content.shapeHash !== this.shapeHash) {
      throw new Error(`cell file ${this.url(cell)} was built for another world shape (${content.shapeHash ?? 'none'}, expected ${this.shapeHash})`);
    }
    return { content, bytes, origin: 'file' };
  }
}
