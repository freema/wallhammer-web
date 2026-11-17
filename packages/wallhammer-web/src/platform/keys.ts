// Held keys, for continuous movement (fly or walk controls). Only raw key state: what a key does is the app's choice.

export interface HeldKeys {
  /** Is the key (KeyboardEvent.code, for example 'KeyW' or 'ShiftLeft') held now? */
  has(code: string): boolean;
  /** Any key held now? */
  readonly any: boolean;
  /** Forgets every held key (a hand-over of the controls); a key still held counts again on its next key-down. */
  clear(): void;
  /** Detaches the listeners. */
  dispose(): void;
}

/** Tracks held keys on the window. Typing into form fields is ignored; losing focus releases everything. */
export function trackHeldKeys(onChange?: () => void): HeldKeys {
  const held = new Set<string>();
  const abort = new AbortController();
  const signal = abort.signal;
  const typing = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (!held.has(e.code)) {
        held.add(e.code);
        onChange?.();
      }
    },
    { signal },
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (held.delete(e.code)) onChange?.();
    },
    { signal },
  );
  window.addEventListener('blur', () => held.clear(), { signal });
  return {
    has: (code) => held.has(code),
    get any() {
      return held.size > 0;
    },
    clear: () => held.clear(),
    dispose: () => abort.abort(),
  };
}
