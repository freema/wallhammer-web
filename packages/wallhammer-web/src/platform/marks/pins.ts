// The pins: a small numbered label per saved mark, placed over the canvas where its point lands, every frame. Plain DOM
// over the canvas (never in a mark's picture) that the pointer passes through. A pin is drawn whether or not something
// stands between it and the eye: it shows where a mark is, not whether it is in sight (the host's `toScreen` may hide
// it). Its colour is the mark's status (`MARK_STATUS_COLOURS`, shown as a legend in the panel); closed marks (accepted,
// wontfix) are dimmed.

import { statusOf } from '../../base/marks.ts';
import type { Mark, MarkStatus } from '../../base/marks.ts';
import type { MarkHost } from './host.ts';

/** The colour of each status: background, and the text colour that reads on it. */
export const MARK_STATUS_COLOURS: Readonly<Record<MarkStatus, { bg: string; fg: string }>> = {
  new: { bg: '#d93025', fg: '#fff' },
  seen: { bg: '#e8710a', fg: '#fff' },
  working: { bg: '#f9ab00', fg: '#111' },
  fixed: { bg: '#1a73e8', fg: '#fff' },
  accepted: { bg: '#188038', fg: '#fff' },
  reopened: { bg: '#a142f4', fg: '#fff' },
  wontfix: { bg: '#5f6368', fg: '#fff' },
};

const STYLE = `
.mk-pins { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 4; }
.mk-pin { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); display: flex; flex-direction: column;
  align-items: center; font: 600 11px/1 system-ui, sans-serif; color: #fff; white-space: nowrap; }
.mk-pin b { padding: 2px 5px; border-radius: 8px; background: var(--mk-bg, #d93025); color: var(--mk-fg, #fff);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.55); }
.mk-pin i { width: 1px; height: 10px; background: var(--mk-bg, #d93025); }
.mk-pin span { display: none; margin-bottom: 2px; padding: 2px 5px; max-width: 220px; overflow: hidden;
  text-overflow: ellipsis; font-weight: 400; background: rgba(0,0,0,0.6); border-radius: 3px; }
.mk-pin.mk-closed { opacity: 0.45; }
.mk-on .mk-pin span { display: block; }
`;

export class Pins {
  readonly root: HTMLDivElement;
  private readonly els = new Map<string, HTMLDivElement>();
  private marks: readonly Mark[] = [];
  private readonly host: MarkHost;

  constructor(host: MarkHost) {
    this.host = host;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'mk-pins';
    document.body.append(this.root);
  }

  /** The marks to show; pins of marks no longer listed go away. */
  set(marks: readonly Mark[]): void {
    this.marks = marks;
    for (const [id, el] of this.els)
      if (!marks.some((m) => m.id === id && m.point)) {
        el.remove();
        this.els.delete(id);
      }
    for (const m of marks) {
      if (!m.point) continue;
      let el = this.els.get(m.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mk-pin';
        const num = document.createElement('b');
        num.textContent = String(m.seq);
        el.append(document.createElement('span'), num, document.createElement('i'));
        el.style.display = 'none';
        this.root.append(el);
        this.els.set(m.id, el);
      }
      // The note and the status may change after the pin was made (the panel, an agent through the store).
      const status = statusOf(m);
      const c = MARK_STATUS_COLOURS[status];
      el.style.setProperty('--mk-bg', c.bg);
      el.style.setProperty('--mk-fg', c.fg);
      el.classList.toggle('mk-closed', status === 'accepted' || status === 'wontfix');
      el.title = status;
      el.firstElementChild!.textContent = m.note;
    }
  }

  /** Places the pins for the frame; `visible` false hides them all, `notes` shows each pin's note above it. */
  frame(visible: boolean, notes: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    this.root.classList.toggle('mk-on', notes);
    if (!visible) return;
    const [w, h] = this.host.size();
    const rect = this.host.canvas.getBoundingClientRect();
    for (const m of this.marks) {
      const el = this.els.get(m.id);
      if (!el || !m.point) continue;
      const s = this.host.toScreen(m.point.world);
      if (!s || s[0] < -50 || s[1] < -50 || s[0] > w + 50 || s[1] > h + 50) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.left = `${rect.left + (s[0] * rect.width) / w}px`;
      el.style.top = `${rect.top + (s[1] * rect.height) / h}px`;
    }
  }
}
