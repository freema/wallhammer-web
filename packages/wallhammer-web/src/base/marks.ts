// Marks: notes a developer pins to points of a 3D scene while moving through it, so that faults can be found and
// followed up later by people and agents. This file holds the plain data of a mark: the record, its statuses and
// categories, what a pick found and the camera of a mark, and small readers of a record. The page's part (the mark
// mode, the pins, the panel, the picture and the store client) is in `platform` (`installMarking`); the dev-server
// store and the command-line tool are the Node-only entry `wallhammer-web/marks-store`.
//
// A mark is kept as one JSON line by the store and read by the command-line tool (`wallhammer-marks`). Each mark is
// tracked: a status, an optional category and an append-only log of who did what.

import type { Vec3 } from './math.ts';

/** What a pick found under the cursor. */
export interface PickHit {
  /** The point in world metres, and its distance from the eye along the ray. */
  world: Vec3;
  distanceM: number;
  /** What was hit, in the host's words. */
  surface: string;
  /** The point in the host's own coordinates (latitude and longitude, a grid cell, …). */
  place: Record<string, number | string | null>;
  /** How the pick was made and how far it may be off, in the host's words. */
  accuracy: Record<string, number | string | null>;
}

/** The camera of a mark: a URL hash that puts the camera back exactly, and whatever else the host records of it. */
export interface MarkView {
  hash: string;
  [key: string]: unknown;
}

/** A mark as the page drafts it, before the store gives it an id. */
export interface MarkDraft {
  note: string;
  /** The path of the page the mark was made on (`/scene/`); the tools open it again with the view's hash. */
  page: string;
  /** Null when the ray hit nothing. */
  point: PickHit | null;
  /** The click in physical canvas pixels from the top-left corner, and the canvas size in physical and CSS pixels. */
  pixel: { x: number; y: number };
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number };
  view: MarkView;
  /** What the host can say about the place, cheaply and truthfully; `unknown` where it cannot. */
  facts: Record<string, unknown>;
}

/**
 * Where a mark stands: `new` (nobody has read it), `seen` (an agent has read it), `working`, `fixed` (an agent claims a
 * repair and has attached a picture of the same view after it; it waits for the developer's look), `accepted` (the
 * developer confirmed it), `reopened` (the developer says it is not solved), `wontfix`.
 */
export const MARK_STATUSES = ['new', 'seen', 'working', 'fixed', 'accepted', 'reopened', 'wontfix'] as const;
export type MarkStatus = (typeof MARK_STATUSES)[number];
export const MARK_CATEGORIES = ['bug', 'look', 'idea'] as const;
export type MarkCategory = (typeof MARK_CATEGORIES)[number];

/** One entry of a mark's log; the log only grows. */
export interface MarkLogEntry {
  /** 1, 2, 3, … within the mark. */
  seq: number;
  /** The status after this entry. */
  status: MarkStatus;
  /** Who: `developer`, `agent:<topic>`, … */
  by: string;
  text: string;
  /** An after-picture of the mark's view, a path as the store names it (`.marks/m0007-after-1.png`). */
  picture?: string;
  /** When the store wrote it (ISO), for reading only. */
  at?: string;
  /** The note or category before this entry changed it. */
  was?: { note?: string | null; category?: MarkCategory | null };
}

/** A saved mark. */
export interface Mark extends MarkDraft {
  /** `m` and the sequence number, four digits at least (`m0007`). */
  id: string;
  /** Counts up with every saved mark, never reused. */
  seq: number;
  /** When the store wrote it (ISO), for reading only. */
  savedAt: string;
  /** Path of its picture as the store names it (relative to the dev server's working folder when it lies in it), or null
   * when none could be made. */
  picture: string | null;
  /** Why there is no picture, when there is none. */
  pictureNote?: string;
  /** Missing on a mark nobody has touched: read it with `statusOf`. */
  status?: MarkStatus;
  category?: MarkCategory;
  log?: MarkLogEntry[];
}

/** A change to a saved mark: every one appends an entry to its log. `fixed` needs `png` (an after-picture). */
export interface MarkPatch {
  by: string;
  note?: string;
  /** null removes the category. */
  category?: MarkCategory | null;
  status?: MarkStatus;
  text?: string;
  /** An after-picture as base64 PNG. */
  png?: string;
}

/** The status of a mark; a mark without one (or with one this code does not know) is `new`. */
export function statusOf(m: Pick<Mark, 'status'>): MarkStatus {
  return (MARK_STATUSES as readonly string[]).includes(m.status ?? '') ? (m.status as MarkStatus) : 'new';
}

/** The newest log entry of a mark, or null. */
export function lastLog(m: Pick<Mark, 'log'>): MarkLogEntry | null {
  return Array.isArray(m.log) && m.log.length ? m.log[m.log.length - 1]! : null;
}

/** The newest after-picture of a mark (a path as the store names it), or null. */
export function lastAfterPicture(m: Pick<Mark, 'log'>): string | null {
  const log = Array.isArray(m.log) ? m.log : [];
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.picture) return log[i]!.picture!;
  return null;
}
