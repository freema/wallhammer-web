// A store of byte arrays by name that outlives the page, kept in the browser's own storage (IndexedDB). It holds
// what is expensive to make and cheap to keep: for example finished cells of a streamed world, so the second visit
// does not build them again. Everything here may fail (private windows, a full disk, a browser without storage);
// a store that cannot be opened is `null` and every read of a store that broke later answers "not there".

/** Byte arrays by key. Reads of a missing key give `null`; writes that fail are dropped. */
export interface ByteStore {
  readonly name: string;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Deletes every key that does not start with `prefix` (what an older version of the content left behind). */
  keepOnly(prefix: string): Promise<void>;
  /** Deletes everything. */
  clear(): Promise<void>;
  /** Keys and bytes held, counted by reading every entry. */
  usage(): Promise<{ keys: number; bytes: number }>;
  close(): void;
}

const TABLE = 'bytes';
/** The longest an open may take, ms. */
const OPEN_WAIT_MS = 3000;

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('storage transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
  });
}

/**
 * Opens (or creates) the store called `name`. Resolves to `null` where the browser has no storage for the page or
 * refuses it; the caller then simply works without a store.
 */
export async function openByteStore(name: string): Promise<ByteStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase;
  try {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(TABLE)) open.result.createObjectStore(TABLE);
    };
    // A browser may leave the request without an answer (blocked by another tab, a storage that hangs). Callers wait
    // for the store before every read, so an open that takes too long counts as "no storage".
    const opened = await Promise.race([
      done(open),
      new Promise<null>((resolve) => {
        open.onblocked = () => resolve(null);
        setTimeout(() => resolve(null), OPEN_WAIT_MS);
      }),
    ]);
    if (!opened) {
      // Should it open after all, it is closed again at once.
      open.onsuccess = () => open.result.close();
      open.onerror = () => {};
      return null;
    }
    db = opened;
  } catch {
    return null;
  }
  // Another tab asking for a newer layout must not be blocked by this one.
  db.onversionchange = () => db.close();
  const table = (mode: IDBTransactionMode): { tx: IDBTransaction; store: IDBObjectStore } => {
    const tx = db.transaction(TABLE, mode);
    return { tx, store: tx.objectStore(TABLE) };
  };
  return {
    name,
    async get(key) {
      try {
        const v = (await done(table('readonly').store.get(key))) as ArrayBuffer | Uint8Array | undefined;
        if (!v) return null;
        return v instanceof Uint8Array ? v : new Uint8Array(v);
      } catch {
        return null;
      }
    },
    async put(key, bytes) {
      try {
        const { tx, store } = table('readwrite');
        // An exact copy of the bytes: a view may sit inside a larger buffer.
        store.put(bytes.slice().buffer, key);
        await finished(tx);
      } catch {
        // A full or failing store only means the entry is built again next time.
      }
    },
    async keepOnly(prefix) {
      try {
        const { tx, store } = table('readwrite');
        const keys = (await done(store.getAllKeys())) as IDBValidKey[];
        for (const k of keys) if (typeof k !== 'string' || !k.startsWith(prefix)) store.delete(k);
        await finished(tx);
      } catch {
        // As for `put`.
      }
    },
    async clear() {
      try {
        const { tx, store } = table('readwrite');
        store.clear();
        await finished(tx);
      } catch {
        // As for `put`.
      }
    },
    async usage() {
      try {
        const { store } = table('readonly');
        let keys = 0;
        let bytes = 0;
        await new Promise<void>((resolve, reject) => {
          const cursor = store.openCursor();
          cursor.onerror = () => reject(cursor.error ?? new Error('storage cursor failed'));
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c) {
              resolve();
              return;
            }
            keys++;
            bytes += (c.value as ArrayBuffer).byteLength ?? 0;
            c.continue();
          };
        });
        return { keys, bytes };
      } catch {
        return { keys: 0, bytes: 0 };
      }
    },
    close() {
      db.close();
    },
  };
}
