// What a page's address says about its marks: where the store answers, whether the marks are wanted and whether the
// pins are drawn, and the URL hash as it stands. Read from `location` and `navigator`, so it lives here with the panel.
//
// A page driven by a script (`navigator.webdriver`: picture and benchmark tools) has no marks unless its hash says
// `marks=1`, so its pictures do not change; `marks=0` hides the pins.

/** What the address of the page says about the marks. */
export interface PageMarking {
  /** The store's URL path: `__marks` in the folder of the page's path (`/scene/__marks` for `/scene/` and `/scene/b.html`). */
  endpoint: string;
  /** False in a page driven by a script whose hash does not say `marks=1`. */
  enabled: boolean;
  /** False when the hash says `marks=0`. */
  pins: boolean;
  /** The page's path (`/scene/`), as a mark records it. */
  page: string;
  /** The URL hash now, without `#`. */
  hash(): string;
}

/** A parameter of a URL hash written as `k=v&k=v`, or null. */
export function hashParam(hash: string, name: string): string | null {
  for (const part of hash.replace(/^#/, '').split('&')) {
    const k = part.indexOf('=');
    if ((k < 0 ? part : part.slice(0, k)) === name) return k < 0 ? '' : decodeURIComponent(part.slice(k + 1));
  }
  return null;
}

/** The marks as the page's address asks for them. */
export function pageMarking(): PageMarking {
  const path = location.pathname;
  const hash = (): string => location.hash.replace(/^#/, '');
  const asked = hashParam(hash(), 'marks');
  return {
    endpoint: `${path.slice(0, path.lastIndexOf('/') + 1)}__marks`,
    enabled: !navigator.webdriver || asked === '1',
    pins: asked !== '0',
    page: path,
    hash,
  };
}
