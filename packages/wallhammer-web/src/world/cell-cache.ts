// A provider in front of another one that keeps finished cells in a byte store: a cell asked for a second time (in
// this visit or a later one) is read back instead of being built again. The store is a port; in a browser it is the
// byte store of `platform`, in a test a plain map. What is stored are the bytes of the cell format, so a cell from the
// cache is exactly the cell the inner provider made.
//
// The key of a cell holds a caller-given version (whatever its content depends on: the data's fingerprint, the
// generator's domain version, the world seed), so content made from other data is never read back.

import type { CellId } from '../gen-core/cell.ts';
import { cellKey } from '../gen-core/cell.ts';
import { decodeCell, encodeCell } from './cell-format.ts';
import type { CellProvider, CellResult } from './providers.ts';

/** Where cached cells are kept. `get` answers `null` for a key it does not hold; neither call may reject. */
export interface CellStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** Counters of a cached provider, for a status line. */
export interface CellCacheStats {
  /** Cells read back from the store, and cells the inner provider had to make. */
  hits: number;
  misses: number;
  /** Stored cells that could not be decoded (they are made again and written over). */
  broken: number;
  /** Bytes read from and written to the store. */
  bytesRead: number;
  bytesWritten: number;
}

function aborted(): Error {
  const e = new Error('cell request cancelled');
  e.name = 'AbortError';
  return e;
}

export class CachedCellProvider implements CellProvider {
  readonly name: string;
  readonly blocking = false;
  readonly stats: CellCacheStats = { hits: 0, misses: 0, broken: 0, bytesRead: 0, bytesWritten: 0 };
  private readonly inner: CellProvider;
  private readonly store: CellStore;
  private readonly version: string;

  /** `version` names what the cells were made from; cells stored under another version are not read. */
  constructor(inner: CellProvider, store: CellStore, version: string) {
    this.inner = inner;
    this.store = store;
    this.version = version;
    this.name = `cache (${inner.name})`;
  }

  /** The store key of a cell: the version, then the cell. A store can drop every key without this prefix. */
  get prefix(): string {
    return `${this.version}/`;
  }

  key(cell: CellId): string {
    return `${this.prefix}${cellKey(cell)}`;
  }

  async request(cell: CellId, signal: AbortSignal): Promise<CellResult> {
    const key = this.key(cell);
    const stored = await this.store.get(key);
    if (signal.aborted) throw aborted();
    if (stored) {
      try {
        const content = decodeCell(stored);
        this.stats.hits++;
        this.stats.bytesRead += stored.byteLength;
        return { content, bytes: stored, origin: 'file' };
      } catch {
        this.stats.broken++;
      }
    }
    const made = await this.inner.request(cell, signal);
    this.stats.misses++;
    const bytes = made.bytes ?? encodeCell(made.content);
    this.stats.bytesWritten += bytes.byteLength;
    // Not awaited: the cell is drawn while the store writes.
    void this.store.put(key, bytes);
    return made;
  }
}
