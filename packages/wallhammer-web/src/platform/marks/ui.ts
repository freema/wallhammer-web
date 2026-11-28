// The mark mode. A key switches it; while it is on, a layer over the canvas takes the pointer (a crosshair; no pointer
// lock and no mouse look, while the movement keys keep working). A click picks the point under the cursor, snapshots
// the picture and opens a small text box there: Enter saves the mark through the store, Escape drops it. Keys typed
// into a text field of the marks stay in it. A panel lists the marks with their status, category and newest log line
// (go to one, edit its note, set its category, accept, reopen, wontfix, delete, compare a fixed one with its
// after-picture), filtered (open, fixed and waiting for a look, all) and read again from the store every few seconds
// while the mode is on, so a change an agent makes shows without a reload. The pins show the marks in the scene,
// coloured by status. Everything is asked in the panel itself (a text field in the mark's row for a note or for the
// reason of a reopen or a wontfix, two buttons for a delete): no dialog of the browser opens, so a page driven by a
// script is never blocked by one.
//
// `installMarking` is the whole of it; it returns the script interface (`MarkingApi`). A developer tool of the engine:
// its labels are its own, in English; it shows nothing of the page it is installed in.

import { MARK_CATEGORIES, MARK_STATUSES, lastAfterPicture, lastLog, statusOf } from '../../base/marks.ts';
import type { Mark, MarkCategory, MarkDraft, MarkPatch, MarkStatus } from '../../base/marks.ts';
import { captureCanvas } from './capture.ts';
import type { CanvasCapture } from './capture.ts';
import type { MarkHost, MarkingOptions } from './host.ts';
import { MARK_STATUS_COLOURS, Pins } from './pins.ts';
import { markStore } from './store.ts';

const STYLE = `
.mk-layer { position: fixed; inset: 0; z-index: 6; cursor: crosshair; display: none; }
.mk-panel { position: fixed; top: 12px; right: 12px; z-index: 7; width: 380px; max-width: calc(100vw - 32px);
  max-height: 70vh; overflow: auto; display: none; padding: 8px 10px; border-radius: 6px; cursor: default;
  background: rgba(10, 12, 16, 0.82); color: #eee; font: 12px/1.4 system-ui, sans-serif; }
.mk-panel h1 { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.mk-panel p { margin: 0 0 6px; opacity: 0.75; }
.mk-panel .mk-status { color: #ffd479; opacity: 1; }
.mk-legend { display: flex; flex-wrap: wrap; gap: 3px; margin: 0 0 6px; }
.mk-chip { display: inline-block; padding: 0 5px; border-radius: 7px; font-size: 11px; line-height: 16px; white-space: nowrap; }
.mk-cat { background: rgba(255,255,255,0.16); color: #ddd; }
.mk-filter { display: flex; gap: 4px; margin: 0 0 6px; }
.mk-filter button.mk-sel { background: rgba(255,255,255,0.4); color: #000; }
.mk-item { padding: 3px 0; border-top: 1px solid rgba(255,255,255,0.08); }
.mk-row { display: flex; gap: 5px; align-items: center; }
.mk-row b { color: #ff8a80; min-width: 26px; }
.mk-row span.mk-note { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mk-row input, .mk-cmp-bar input { flex: 1; min-width: 0; padding: 1px 4px; border: 1px solid #888; border-radius: 3px;
  background: #fff; color: #111; font: 12px system-ui, sans-serif; }
.mk-panel button.mk-danger { background: #b3261e; }
.mk-last { margin: 1px 0 0 31px; opacity: 0.7; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mk-acts { display: flex; flex-wrap: wrap; gap: 3px; margin: 2px 0 0 31px; }
.mk-panel button, .mk-compare button { font: inherit; padding: 0 5px; border: 0; border-radius: 3px;
  background: rgba(255,255,255,0.14); color: #fff; cursor: pointer; }
.mk-panel select { font: inherit; font-size: 11px; padding: 0; border-radius: 3px; background: rgba(255,255,255,0.14);
  color: #fff; border: 0; }
.mk-panel select option { color: #111; }
.mk-box { position: fixed; z-index: 8; width: 300px; display: none; padding: 6px; border-radius: 6px;
  background: rgba(10, 12, 16, 0.85); color: #eee; font: 12px/1.4 system-ui, sans-serif; cursor: default; }
.mk-box input { box-sizing: border-box; width: 100%; padding: 4px 6px; border: 1px solid #888; border-radius: 3px;
  background: #fff; color: #111; font: 13px system-ui, sans-serif; }
.mk-box div { margin-top: 3px; opacity: 0.75; }
.mk-compare { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 9; display: none; padding: 8px;
  border-radius: 6px; background: rgba(10, 12, 16, 0.88); color: #eee; font: 12px/1.4 system-ui, sans-serif; cursor: default; }
.mk-compare .mk-pair { display: flex; gap: 8px; justify-content: center; }
.mk-compare figure { margin: 0; flex: 1; min-width: 0; text-align: center; }
.mk-compare img { max-width: 100%; max-height: 42vh; border-radius: 3px; background: #000; }
.mk-compare figcaption { opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mk-compare .mk-cmp-bar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.mk-compare .mk-cmp-bar span:first-child { flex: 1; }
`;

/** How often the panel reads the store again while the mode is on. */
const POLL_MS = 4000;
/** The label the panel's own changes carry in a mark's log. */
const DEVELOPER = 'developer';

/** A click being turned into a mark: everything but the note, and the picture being encoded. */
interface Pending {
  draft: MarkDraft;
  capture: Promise<CanvasCapture>;
}

type Filter = 'open' | 'fixed' | 'all';
/** The changes of status the panel asks a reason for. */
type AskedStatus = 'reopened' | 'wontfix';
const QUESTION: Record<AskedStatus, string> = { reopened: 'what is still wrong? (optional)', wontfix: 'why leave it? (optional)' };
const OPEN: readonly MarkStatus[] = ['new', 'seen', 'working', 'reopened'];
const inFilter = (f: Filter, s: MarkStatus): boolean => (f === 'all' ? true : f === 'fixed' ? s === 'fixed' : OPEN.includes(s));

export interface MarkingApi {
  /** The saved marks of this page (`Mark.page` is its path), oldest first (copies). */
  list(): Mark[];
  /** Picks at a canvas point (physical pixels; the middle by default) and saves a mark with `note`, as a click would. */
  add(note: string, px?: number, py?: number): Promise<Mark>;
  /** Changes a mark (note, category, status) and appends an entry to its log, as the panel's buttons do. */
  update(id: string, patch: MarkPatch): Promise<Mark>;
  remove(id: string): Promise<boolean>;
  /** Puts the camera at a mark's view. */
  goto(id: string): boolean;
  /** Puts the camera at a mark's view and shows its picture beside its newest after-picture. */
  compare(id: string): boolean;
  /** Switches the mark mode (no argument: toggles); returns whether it is on. */
  mode(on?: boolean): boolean;
  /** Loads the list from the store again; returns how many marks there are. */
  reload(): Promise<number>;
  /** Renders a frame and returns the canvas as a PNG, as a mark's picture is taken (no circle); for after-pictures. */
  snapshot(): Promise<CanvasCapture>;
}

const fmtM = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`);
const typing = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** Keys pressed in a text field under `el` stay there: nothing on the window hears them (the page's own keys). */
function keepKeys(el: HTMLElement): void {
  const stop = (e: KeyboardEvent): void => {
    if (typing(e.target)) e.stopPropagation();
  };
  el.addEventListener('keydown', stop);
  el.addEventListener('keypress', stop);
}

function button(label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.onclick = () => {
    // A focused button would take Space and Enter from the page.
    b.blur();
    run();
  };
  return b;
}

function chip(text: string, cls: string, bg?: string, fg?: string): HTMLSpanElement {
  const c = document.createElement('span');
  c.className = `mk-chip ${cls}`;
  c.textContent = text;
  if (bg) c.style.background = bg;
  if (fg) c.style.color = fg;
  return c;
}

export function installMarking(host: MarkHost, options: MarkingOptions): MarkingApi {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  const store = markStore(options.endpoint);
  const pins = new Pins(host);
  let marks: Mark[] = [];
  let signature = '';
  let on = false;
  let pending: Pending | null = null;
  let status = '';
  let filter: Filter = 'all';
  /**
   * The mark a text is being typed for and the text so far: its note, or with `status` the reason of that change of
   * status. The field is in the mark's row of the panel, or in the bar of the comparison when asked from there.
   */
  let editing: { id: string; text: string; status?: AskedStatus; where: 'panel' | 'compare' } | null = null;
  /** The mark whose delete waits for a second click. */
  let confirming: string | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let comparing: string | null = null;

  const layer = document.createElement('div');
  layer.className = 'mk-layer';
  const panel = document.createElement('div');
  panel.className = 'mk-panel';
  const box = document.createElement('div');
  box.className = 'mk-box';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 2000;
  input.placeholder = 'what is wrong here?';
  const boxNote = document.createElement('div');
  box.append(input, boxNote);
  const cmp = document.createElement('div');
  cmp.className = 'mk-compare';
  document.body.append(layer, panel, box, cmp);
  keepKeys(panel);
  keepKeys(cmp);

  const keyName = options.key.replace(/^Key/, '');
  let statusEl: HTMLParagraphElement | null = null;

  /** The store keeps the marks of every page of the dev server; this page shows and lists its own (`Mark.page`). */
  const page = location.pathname;
  const own = (list: Mark[]): Mark[] => list.filter((m) => m.page === page);

  function setMarks(list: Mark[]): void {
    marks = list;
    signature = JSON.stringify(list);
    pins.set(marks);
    host.invalidate();
  }

  function replace(m: Mark): void {
    setMarks(marks.map((k) => (k.id === m.id ? m : k)));
  }

  function renderPanel(): void {
    panel.replaceChildren();
    const h = document.createElement('h1');
    h.textContent = `Marks (${marks.length})`;
    const p = document.createElement('p');
    p.textContent = `click: mark the point · ${keyName} or Esc: leave · the movement keys still work`;
    panel.append(h, p);
    statusEl = document.createElement('p');
    statusEl.className = 'mk-status';
    statusEl.textContent = status;
    statusEl.style.display = status ? '' : 'none';
    panel.append(statusEl);

    const legend = document.createElement('div');
    legend.className = 'mk-legend';
    for (const s of MARK_STATUSES) legend.append(chip(s, '', MARK_STATUS_COLOURS[s].bg, MARK_STATUS_COLOURS[s].fg));
    panel.append(legend);

    const counts: Record<Filter, number> = { open: 0, fixed: 0, all: marks.length };
    for (const m of marks) {
      const s = statusOf(m);
      if (inFilter('open', s)) counts.open++;
      if (s === 'fixed') counts.fixed++;
    }
    const bar = document.createElement('div');
    bar.className = 'mk-filter';
    const names: [Filter, string, string][] = [
      ['open', 'open', 'new, seen, working, reopened'],
      ['fixed', 'fixed: to look at', 'an agent says it is fixed; accept or reopen'],
      ['all', 'all', 'every mark'],
    ];
    for (const [f, label, title] of names) {
      const b = button(`${label} ${counts[f]}`, title, () => {
        filter = f;
        renderPanel();
      });
      if (f === filter) b.className = 'mk-sel';
      bar.append(b);
    }
    panel.append(bar);

    for (const m of [...marks].reverse()) {
      const st = statusOf(m);
      if (inFilter(filter, st)) panel.append(item(m, st));
    }
  }

  function item(m: Mark, st: MarkStatus): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'mk-item';
    const row = document.createElement('div');
    row.className = 'mk-row';
    const n = document.createElement('b');
    n.textContent = `#${m.seq}`;
    row.append(n, chip(st, '', MARK_STATUS_COLOURS[st].bg, MARK_STATUS_COLOURS[st].fg));
    if (m.category) row.append(chip(m.category, 'mk-cat'));
    const typed = editing?.id === m.id && editing.where === 'panel' ? editing : null;
    if (typed?.status) {
      row.append(...asked(m, typed.status));
    } else if (typed) {
      row.append(
        field('the note', (text) => {
          if (text !== m.note) void act(m, { by: DEVELOPER, note: text }, `note of #${m.seq} saved`);
          else renderPanel();
        }),
      );
    } else {
      const t = document.createElement('span');
      t.className = 'mk-note';
      t.textContent = m.note || '(no note)';
      t.title = `${m.note}\n${m.point ? `${m.point.surface}, ${fmtM(m.point.distanceM)} from the eye` : 'no point (the ray met nothing)'}\n#${m.view.hash}`;
      row.append(t);
    }
    const go = (): HTMLButtonElement => button('go', 'put the camera at this mark’s view', () => api.goto(m.id));
    if (typed) {
      // A row with a text field keeps its width for the text: the buttons come back when the edit ends.
    } else if (confirming === m.id) {
      const del = button('delete', `delete mark #${m.seq} for good`, () => {
        confirming = null;
        api.remove(m.id).catch((err: unknown) => say(`NOT deleted: ${String(err)}`));
      });
      del.className = 'mk-danger';
      row.append(
        go(),
        del,
        button('keep', 'do not delete', () => {
          confirming = null;
          renderPanel();
        }),
      );
    } else {
      row.append(
        go(),
        button('×', 'delete this mark (asks once more)', () => {
          confirming = m.id;
          renderPanel();
        }),
      );
    }
    el.append(row);

    const last = lastLog(m);
    if (last) {
      const l = document.createElement('div');
      l.className = 'mk-last';
      l.textContent = `${last.by}: ${last.text}${last.picture ? ' [picture]' : ''}`;
      l.title = (m.log ?? []).map((e) => `${e.seq}. ${e.status} · ${e.by}${e.at ? ` · ${e.at}` : ''}: ${e.text}${e.picture ? ` [${e.picture}]` : ''}`).join('\n');
      el.append(l);
    }

    const acts = document.createElement('div');
    acts.className = 'mk-acts';
    acts.append(
      button('note', 'edit the note (Enter saves, Esc cancels)', () => {
        editing = { id: m.id, text: m.note, where: 'panel' };
        renderPanel();
      }),
    );
    const cat = document.createElement('select');
    cat.title = 'category';
    for (const c of ['', ...MARK_CATEGORIES]) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c || 'category…';
      cat.append(o);
    }
    cat.value = m.category ?? '';
    cat.onchange = () => {
      const v = cat.value;
      cat.blur();
      void act(m, { by: DEVELOPER, category: v ? (v as MarkCategory) : null }, `category of #${m.seq}: ${v || 'none'}`);
    };
    acts.append(cat);
    if (st !== 'accepted') acts.append(button('accept', 'the fault is solved (the developer’s call)', () => void act(m, { by: DEVELOPER, status: 'accepted' }, `#${m.seq} accepted`)));
    if (st !== 'new' && st !== 'reopened') acts.append(button('reopen', 'not solved: back to the agents (asks what is still wrong)', () => ask(m, 'reopened', 'panel')));
    if (st !== 'wontfix') acts.append(button('wontfix', 'leave it as it is (asks why)', () => ask(m, 'wontfix', 'panel')));
    if (lastAfterPicture(m)) acts.append(button(st === 'fixed' ? 'compare ◂' : 'compare', 'go to the view; the picture beside the newest after-picture', () => api.compare(m.id)));
    el.append(acts);
    return el;
  }

  /** Opens the text field for the reason of a change of status, in the mark's row or in the comparison's bar. */
  function ask(m: Mark, s: AskedStatus, where: 'panel' | 'compare'): void {
    editing = { id: m.id, text: '', status: s, where };
    redraw();
  }

  /** What stands for the question of `ask`: the status asked for and the field (Enter saves, also empty; Esc drops). */
  function asked(m: Mark, s: AskedStatus): HTMLElement[] {
    return [
      chip(`→ ${s}`, '', MARK_STATUS_COLOURS[s].bg, MARK_STATUS_COLOURS[s].fg),
      field(QUESTION[s], (text) => void act(m, { by: DEVELOPER, status: s, ...(text ? { text } : {}) }, `#${m.seq} ${s}`)),
    ];
  }

  /**
   * The text field of `editing`: it keeps the text typed so far (so a rebuilt panel shows it again), gives the trimmed
   * text to `done` on Enter and drops the edit on Escape.
   */
  function field(placeholder: string, done: (text: string) => void): HTMLInputElement {
    const ed = document.createElement('input');
    ed.type = 'text';
    ed.maxLength = 2000;
    ed.placeholder = placeholder;
    ed.title = 'Enter saves, Esc cancels';
    ed.value = editing?.text ?? '';
    ed.oninput = () => {
      if (editing) editing.text = ed.value;
    };
    ed.onkeydown = (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        editing = null;
        redraw();
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        const text = ed.value.trim();
        editing = null;
        done(text);
      }
    };
    queueMicrotask(() => {
      ed.focus();
      ed.setSelectionRange(ed.value.length, ed.value.length);
    });
    return ed;
  }

  /** Builds the panel and the comparison again from the state (after an edit began or was dropped). */
  function redraw(): void {
    if (on) renderPanel();
    if (comparing) showCompare(comparing);
  }

  async function act(m: Mark, patch: MarkPatch, done: string): Promise<void> {
    say('saving…');
    try {
      replace(await store.update(m.id, patch));
      if (comparing === m.id) showCompare(m.id);
      say(done);
    } catch (err) {
      say(`NOT saved: ${String(err)}`);
    }
  }

  function say(text: string): void {
    status = text;
    // While a text is being typed the panel is not rebuilt (that would take the text field away): only the line.
    if (editing && statusEl) {
      statusEl.textContent = text;
      statusEl.style.display = text ? '' : 'none';
    } else if (on) renderPanel();
  }

  function showCompare(id: string): void {
    const m = marks.find((k) => k.id === id);
    const after = m ? lastAfterPicture(m) : null;
    if (!m || !after) return closeCompare();
    comparing = id;
    cmp.replaceChildren();
    const bar = document.createElement('div');
    bar.className = 'mk-cmp-bar';
    const title = document.createElement('span');
    const st = statusOf(m);
    title.textContent = `#${m.seq} · ${st} · ${m.note || '(no note)'}`;
    bar.append(title);
    const typed = editing?.id === m.id && editing.where === 'compare' ? editing.status : undefined;
    if (typed) {
      bar.append(...asked(m, typed));
    } else {
      if (st !== 'accepted') bar.append(button('accept', 'the fault is solved', () => void act(m, { by: DEVELOPER, status: 'accepted' }, `#${m.seq} accepted`)));
      if (st !== 'reopened') bar.append(button('reopen', 'not solved (asks what is still wrong)', () => ask(m, 'reopened', 'compare')));
    }
    bar.append(button('close', 'close (Esc)', closeCompare));
    const pair = document.createElement('div');
    pair.className = 'mk-pair';
    const entry = [...(m.log ?? [])].reverse().find((e) => e.picture === after);
    const fig = (src: string | null, caption: string): HTMLElement => {
      const f = document.createElement('figure');
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = caption;
        f.append(img);
      }
      const c = document.createElement('figcaption');
      c.textContent = caption;
      c.title = caption;
      f.append(c);
      return f;
    };
    pair.append(
      fig(m.picture ? store.pictureUrl(m.picture) : null, m.picture ? `before: ${m.picture}` : `before: no picture (${m.pictureNote ?? 'unknown'})`),
      fig(`${store.pictureUrl(after)}?v=${encodeURIComponent(entry?.at ?? String(entry?.seq ?? ''))}`, `after: ${after}${entry ? ` · ${entry.by}: ${entry.text}` : ''}`),
    );
    cmp.append(bar, pair);
    cmp.style.display = 'block';
  }

  function closeCompare(): void {
    if (editing?.where === 'compare') editing = null;
    comparing = null;
    cmp.style.display = 'none';
    cmp.replaceChildren();
  }

  async function refresh(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const list = own(await store.list());
      if (JSON.stringify(list) !== signature) {
        setMarks(list);
        if (comparing) showCompare(comparing);
        if (on && !editing) renderPanel();
      }
    } catch (err) {
      if (on) say(`store not reachable: ${String(err)}`);
    } finally {
      polling = false;
    }
  }

  function setMode(v: boolean): void {
    if (v && !host.allowed()) return;
    if (v === on) return;
    on = v;
    if (on && document.pointerLockElement) document.exitPointerLock();
    if (!on) {
      cancel();
      editing = null;
      confirming = null;
      closeCompare();
    }
    layer.style.display = on ? 'block' : 'none';
    panel.style.display = on ? 'block' : 'none';
    if (poll !== null) clearInterval(poll);
    poll = null;
    if (on) {
      renderPanel();
      void refresh();
      poll = setInterval(() => void refresh(), POLL_MS);
    }
    host.invalidate();
  }

  /** Snapshots the picture, picks the point and gathers the facts of a click at physical pixels (`px`, `py`). */
  function begin(px: number, py: number): Pending {
    // The frame is rendered and snapshotted first; the camera read after it is the camera of that picture.
    const capture = captureCanvas(host.canvas, () => host.renderNow());
    const [w, h] = host.size();
    const ray = host.ray(px, py);
    const point = host.pick(ray);
    const rect = host.canvas.getBoundingClientRect();
    const draft: MarkDraft = {
      note: '',
      page,
      point,
      // The click in the canvas's own pixels (the camera's pixels should be the same; scaled in case they are not).
      pixel: { x: Math.round(((px * host.canvas.width) / w) * 10) / 10, y: Math.round(((py * host.canvas.height) / h) * 10) / 10 },
      canvas: { width: host.canvas.width, height: host.canvas.height, cssWidth: Math.round(rect.width), cssHeight: Math.round(rect.height) },
      view: host.view(),
      facts: host.facts(point, ray),
    };
    return { draft, capture };
  }

  async function save(p: Pending, note: string): Promise<Mark> {
    const c = await p.capture;
    const mark = await store.save({ ...p.draft, note }, c.png, c.note);
    setMarks([...marks, mark]);
    return mark;
  }

  function cancel(): void {
    pending = null;
    box.style.display = 'none';
    input.value = '';
    if (document.activeElement === input) input.blur();
  }

  layer.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    cancel();
    const [w, h] = host.size();
    const rect = host.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) * w) / rect.width;
    const py = ((e.clientY - rect.top) * h) / rect.height;
    pending = begin(px, py);
    const hit = pending.draft.point;
    boxNote.textContent = `${hit ? `${hit.surface} · ${fmtM(hit.distanceM)}` : 'no point (the ray met nothing)'} · Enter saves · Esc cancels`;
    box.style.display = 'block';
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    box.style.left = `${Math.min(window.innerWidth - bw - 8, Math.max(8, e.clientX + 12))}px`;
    box.style.top = `${Math.min(window.innerHeight - bh - 8, Math.max(8, e.clientY + 12))}px`;
    input.focus();
  });
  layer.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  layer.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keys typed into the box stay in it: nothing on the window hears them. Key releases do go on, so a key held while
  // the box opened is not left held.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      const p = pending;
      const note = input.value.trim();
      cancel();
      if (!p) return;
      say('saving…');
      save(p, note).then(
        (m) => say(`saved #${m.seq}${m.picture ? '' : ` (no picture: ${m.pictureNote ?? 'unknown'})`}`),
        (err: unknown) => say(`NOT saved: ${String(err)}`),
      );
    }
  });
  input.addEventListener('keypress', (e) => e.stopPropagation());

  // The mode's key and Escape are taken before the page's own listeners (capture on the window). Escape closes the
  // comparison first, then the mode.
  window.addEventListener(
    'keydown',
    (e) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === options.key) {
        if (!host.allowed()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) setMode(!on);
      } else if (e.code === 'Escape' && comparing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeCompare();
      } else if (on && e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMode(false);
      }
    },
    true,
  );

  host.onFrame(() => {
    const ok = host.allowed();
    if (!ok && on) setMode(false);
    pins.frame(ok && options.pins, on);
  });

  async function load(): Promise<number> {
    try {
      setMarks(own(await store.list()));
      status = '';
    } catch (err) {
      status = `store not reachable: ${String(err)}`;
    }
    if (on && !editing) renderPanel();
    host.invalidate();
    return marks.length;
  }
  void load();

  const find = (id: string): Mark | undefined => marks.find((k) => k.id === id || String(k.seq) === id.replace(/^#/, ''));

  const api: MarkingApi = {
    list: () => marks.map((m) => structuredClone(m)),
    add: async (note, px, py) => {
      const [w, h] = host.size();
      return save(begin(px ?? w / 2, py ?? h / 2), note);
    },
    update: async (id, patch) => {
      const m = find(id);
      if (!m) throw new Error(`no mark ${id}`);
      const saved = await store.update(m.id, patch);
      replace(saved);
      if (on && !editing) renderPanel();
      return saved;
    },
    remove: async (id) => {
      const m = find(id);
      if (!m) return false;
      await store.remove(m.id);
      setMarks(marks.filter((k) => k.id !== m.id));
      if (comparing === m.id) closeCompare();
      if (on) say(`deleted ${m.id}`);
      return true;
    },
    goto: (id) => {
      const m = find(id);
      if (!m) return false;
      host.goto(m.view);
      host.invalidate();
      return true;
    },
    compare: (id) => {
      const m = find(id);
      if (!m || !lastAfterPicture(m)) return false;
      host.goto(m.view);
      host.invalidate();
      showCompare(m.id);
      return true;
    },
    mode: (v) => {
      setMode(v ?? !on);
      return on;
    },
    reload: load,
    snapshot: () => captureCanvas(host.canvas, () => host.renderNow()),
  };
  return api;
}
