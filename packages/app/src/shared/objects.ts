/**
 * What Edit object shows and sends for each kind, and the payload readers behind
 * it. Pure and shared: the renderer uses the field table to decide which inputs
 * to show, main uses the readers, and a test checks the table against core's
 * SPECS so the two cannot drift apart.
 */

import type { EditKind, ObjectDetail, ObjectSummary } from "./ipc";

type Payload = Record<string, unknown>;

export interface KindFields {
  readonly label: string;
  readonly body: boolean;
  readonly points: boolean;
  readonly dates: boolean;
}

/** Mirrors core's objects.ts SPECS: which of body, points and dates a kind takes. */
export const KIND_FIELDS: Readonly<Record<EditKind, KindFields>> = {
  page: { label: "Page", body: true, points: false, dates: false },
  assignment: { label: "Assignment", body: true, points: true, dates: true },
  discussion: { label: "Discussion", body: true, points: true, dates: true },
  quiz: { label: "Quiz", body: true, points: false, dates: true },
  module: { label: "Module", body: false, points: false, dates: false },
};

/**
 * Deleting these can take submissions and grades with it. A discussion only
 * when graded, but the warning is cheap and a missed one is not.
 */
export const DELETE_TAKES_GRADES: ReadonlySet<EditKind> = new Set(["assignment", "quiz", "discussion"]);

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canvas's title field for each kind: an assignment and a module have a name. */
function titleOf(kind: EditKind, payload: Payload): string {
  return text(kind === "assignment" || kind === "module" ? payload.name : payload.title);
}

/** A page is addressed by its url slug, everything else by its numeric id. */
export function idOf(kind: EditKind, payload: Payload): string {
  return text(kind === "page" ? payload.url : payload.id);
}

export function toObjectSummary(kind: EditKind, payload: Payload): ObjectSummary {
  return { id: idOf(kind, payload), title: titleOf(kind, payload), published: payload.published === true };
}

/**
 * One object as the form edits it. A graded discussion keeps its points and
 * dates on the assignment Canvas hangs off it, not on the topic.
 */
export function toObjectDetail(
  kind: EditKind,
  payload: Payload,
  fallbackUrl: string,
  managedBy: string | null,
): ObjectDetail {
  const dated = kind === "discussion" ? (isRecord(payload.assignment) ? payload.assignment : {}) : payload;
  const bodyField = { page: "body", assignment: "description", discussion: "message", quiz: "description" } as const;
  return {
    kind,
    id: idOf(kind, payload),
    title: titleOf(kind, payload),
    body: kind === "module" ? null : text(payload[bodyField[kind]]),
    points: KIND_FIELDS[kind].points ? numberOrNull(dated.points_possible) : null,
    dueAt: KIND_FIELDS[kind].dates ? textOrNull(dated.due_at) : null,
    unlockAt: KIND_FIELDS[kind].dates ? textOrNull(dated.unlock_at) : null,
    lockAt: KIND_FIELDS[kind].dates ? textOrNull(dated.lock_at) : null,
    published: payload.published === true,
    htmlUrl: text(payload.html_url) || fallbackUrl,
    managedBy,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A Canvas timestamp as a `datetime-local` input value, in this computer's time
 * zone, or "" for none.
 */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A `datetime-local` value as ISO 8601 with this computer's offset,
 * `2026-09-30T23:59:00-06:00`, the form Canvas and the push both use. "" stays ""
 * (which clears the date in Canvas); anything unreadable is null.
 */
export function localInputToIso(value: string): string | null {
  if (value === "") {
    return "";
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const d = new Date(year, month - 1, day, hour, minute);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
