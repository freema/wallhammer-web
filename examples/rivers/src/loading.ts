// The loading bar over the canvas: plain DOM that shows a `ProgressReport` of the engine's `Progress` (the stage's
// label and the share done), fades out when the build is done and shows the error when it failed. The elements and
// their style are in index.html; this only writes into them.

import type { ProgressReport } from 'wallhammer-web/base';

export class LoadingBar {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly percent: HTMLElement;
  private readonly fill: HTMLElement;
  private shown = -1;

  constructor(root: HTMLElement) {
    this.root = root;
    this.label = root.querySelector<HTMLElement>('.label')!;
    this.percent = root.querySelector<HTMLElement>('.percent')!;
    this.fill = root.querySelector<HTMLElement>('.fill')!;
  }

  /** Shows a report: the stage's label, the whole percent and the bar. */
  show(r: ProgressReport): void {
    const pct = Math.floor(r.fraction * 100);
    if (this.label.textContent !== r.label) this.label.textContent = r.label;
    if (pct === this.shown) return;
    this.shown = pct;
    this.percent.textContent = `${pct} %`;
    this.fill.style.transform = `scaleX(${r.fraction})`;
    this.root.setAttribute('aria-valuenow', String(pct));
  }

  /** Fades the bar out and takes it out of the layout when the fade has run. */
  hide(): void {
    this.root.classList.add('done');
    const remove = (): void => void (this.root.hidden = true);
    this.root.addEventListener('transitionend', remove, { once: true });
    // A tab in the background runs no transitions: take it away in any case.
    setTimeout(remove, 1200);
  }

  /** Shows a failed build: the message in place of the stage, the bar stopped where it was. */
  fail(message: string): void {
    this.root.classList.add('failed');
    this.label.textContent = `Build failed: ${message}`;
    this.percent.textContent = '';
  }
}
