/**
 * Two-way sync between a course repository and Canvas: what each side looked
 * like the last time the two agreed, and which side has moved since.
 *
 * verify can say that the repo and Canvas differ, but not who changed. A page
 * edited in the Canvas UI and a page edited in the repo look the same from
 * there. So every push records a baseline per object: a fingerprint of each
 * part it wrote (body, settings, rubric, questions, or a module's items), taken
 * once from the repo's side and once from what Canvas stored. Later, each side
 * is fingerprinted again and compared only with its own earlier self. The two
 * sides are never compared with each other through a fingerprint, so they do
 * not have to render alike: Canvas rewrites markup, and that is fine.
 *
 * The one place the sides are compared directly is when there is no baseline
 * yet, and then it is the same semantic comparison verify makes.
 *
 * Everything here is pure.
 */

import { createHash } from "node:crypto";
import { CANVAS_ADDED_ATTRS, type Criterion } from "./publish";
import type { Payload } from "./types";

/** The parts of an object a push writes, each fingerprinted on its own. */
export const COMPONENTS = ["body", "settings", "rubric", "questions", "items"] as const;
export type Component = (typeof COMPONENTS)[number];
export type Fingerprints = Partial<Record<Component, string>>;

/** Whether the repo and Canvas agree on a part right now, by verify's rules. */
export type Matches = Partial<Record<Component, boolean>>;

/**
 * The state of both sides the last time they agreed.
 *
 * `canvas` always covers a part `repo` covers. A part in `canvas` alone was
 * adopted while the two sides differed, so Canvas is the reference for it and
 * any difference the repo shows counts as a repo change.
 */
export interface Baseline {
  readonly repo: Fingerprints;
  readonly canvas: Fingerprints;
  /** When the baseline was last written, ISO 8601. */
  readonly at: string;
}

/** Everything known about one object's two sides, read at the same moment. */
export interface Sides {
  readonly repo: Fingerprints;
  readonly canvas: Fingerprints;
  readonly matches: Matches;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isTable(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

/**
 * A short, stable hash of any JSON value, with keys sorted.
 *
 * Sixteen hex digits: the manifest is committed and read in diffs, and a
 * collision between two versions of the same page is not a real risk.
 */
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)) ?? "null")
    .digest("hex")
    .slice(0, 16);
}

/** A file's bytes, fingerprinted the same way. */
export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * HTML as Canvas stored it, minus what Canvas adds or varies on its own.
 *
 * Canvas stamps data-api-* attributes on links when it saves a body, and can
 * hand back file links carrying a per-request verifier. Neither is an edit,
 * so neither may move the fingerprint.
 */
export function canvasHtml(html: string): string {
  let out = html;
  for (const attr of CANVAS_ADDED_ATTRS) out = out.replace(new RegExp(`\\s${attr}="[^"]*"`, "g"), "");
  out = out.replace(/\?verifier=[A-Za-z0-9]+&(amp;)?/g, "?");
  out = out.replace(/(\?|&(amp;)?)verifier=[A-Za-z0-9]+/g, "");
  return out.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

/** A Canvas date to the minute, the precision verify compares at. */
export function minute(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 60_000);
}

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&nbsp;", " "],
  ["&amp;", "&"],
];

/** Canvas hands rubric text back HTML-escaped; the repo writes it plain. */
export function unescapeHtml(text: string): string {
  let out = text;
  for (const [entity, char] of ENTITIES) out = out.replaceAll(entity, char);
  return out;
}

/** Canvas's rubric criteria in the repo's terms, for both the fingerprint and the match. */
export function plainCriteria(criteria: readonly Criterion[]): Criterion[] {
  return criteria.map((c) => ({
    description: unescapeHtml(c.description),
    points: c.points,
    ...(c.longDescription ? { longDescription: unescapeHtml(c.longDescription) } : {}),
  }));
}

/** The parts of a quiz question a Canvas edit would change. */
export function canvasQuestions(questions: readonly Payload[]): unknown[] {
  return questions.map((q) => ({
    name: q.question_name ?? null,
    type: q.question_type ?? null,
    text: typeof q.question_text === "string" ? canvasHtml(q.question_text) : null,
    points: q.points_possible ?? null,
    answers: (Array.isArray(q.answers) ? q.answers : []).filter(isTable).map((a) => ({
      text: a.text ?? a.answer_text ?? null,
      html: typeof a.html === "string" ? canvasHtml(a.html) : null,
      weight: a.weight ?? a.answer_weight ?? null,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Comparing against the baseline
// ---------------------------------------------------------------------------

/**
 * - `in-sync`: neither side moved, or both made the same change.
 * - `repo`: the repo moved; a push brings Canvas up to date.
 * - `canvas`: Canvas moved; the change has to come back into the repo, or a
 *   push will overwrite it.
 * - `conflict`: both moved, differently.
 * - `unknown`: no baseline, and the two sides differ, so there is no telling
 *   which one changed.
 */
export type SyncState = "in-sync" | "repo" | "canvas" | "conflict" | "unknown";

export interface Comparison {
  readonly state: SyncState;
  /** Parts the repo changed since the baseline. */
  readonly repo: readonly Component[];
  /** Parts Canvas changed since the baseline. */
  readonly canvas: readonly Component[];
  /** Parts that differ with no baseline to say which side moved. */
  readonly unknown: readonly Component[];
}

function partsOf(fingerprints: Fingerprints): Component[] {
  return COMPONENTS.filter((c) => fingerprints[c] !== undefined);
}

/**
 * Which side moved, part by part.
 *
 * Only the parts the repo manages are looked at: a rubric attached by hand to
 * an assignment whose file has no rubric table is Canvas's alone, and a push
 * never touches it.
 */
export function compareSides(baseline: Baseline | null, sides: Sides): Comparison {
  const repo: Component[] = [];
  const canvas: Component[] = [];
  const unknown: Component[] = [];
  for (const part of partsOf(sides.repo)) {
    const agree = sides.matches[part] === true;
    const before = baseline?.canvas[part];
    if (before === undefined) {
      if (!agree) unknown.push(part);
      continue;
    }
    const canvasMoved = sides.canvas[part] !== before;
    const repoBefore = baseline?.repo[part];
    if (repoBefore === undefined) {
      // Adopted while different: Canvas is the reference, so a repo that
      // still differs from it is a repo that has changed. With no repo
      // fingerprint to go on, the sides agreeing again is all there is.
      if (agree) continue;
      repo.push(part);
      if (canvasMoved) canvas.push(part);
      continue;
    }
    const repoMoved = sides.repo[part] !== repoBefore;
    if (canvasMoved && repoMoved && agree) continue;
    if (repoMoved) repo.push(part);
    if (canvasMoved) canvas.push(part);
  }
  let state: SyncState = "in-sync";
  if (repo.length > 0 && canvas.length > 0) state = "conflict";
  else if (canvas.length > 0) state = "canvas";
  else if (repo.length > 0) state = "repo";
  else if (unknown.length > 0) state = "unknown";
  return { state, repo, canvas, unknown };
}

/**
 * The baseline after a push wrote `parts`: both sides as they are now for
 * those, everything else as it was. A full push that skips rubrics must not
 * mark a rubric Canvas changed by hand as agreed.
 */
export function afterPush(previous: Baseline | null, sides: Sides, parts: Iterable<Component>, at: string): Baseline {
  const repo: Fingerprints = { ...(previous?.repo ?? {}) };
  const canvas: Fingerprints = { ...(previous?.canvas ?? {}) };
  for (const part of parts) {
    const r = sides.repo[part];
    const c = sides.canvas[part];
    if (r === undefined || c === undefined) continue;
    repo[part] = r;
    canvas[part] = c;
  }
  return { repo, canvas, at };
}

/**
 * The baseline after adopting the course as Canvas holds it now.
 *
 * A part with no baseline is recorded: on both sides where the two agree, and
 * on Canvas's side only where they differ, so the difference reads as a repo
 * change from here on. A part where both sides have moved and now agree is
 * recorded again on both, which is how a change copied from Canvas into the
 * repo by hand is marked as synced without pushing it back. A part the repo
 * alone changed is left alone, even when the two still look alike, since a
 * changed link target is invisible to that comparison. Returns null when
 * nothing changed.
 */
export function adopt(previous: Baseline | null, sides: Sides, at: string): Baseline | null {
  const repo: Fingerprints = { ...(previous?.repo ?? {}) };
  const canvas: Fingerprints = { ...(previous?.canvas ?? {}) };
  let changed = false;
  for (const part of partsOf(sides.repo)) {
    const c = sides.canvas[part];
    if (c === undefined) continue;
    const agree = sides.matches[part] === true;
    if (canvas[part] === undefined) {
      canvas[part] = c;
      if (agree) repo[part] = sides.repo[part];
      changed = true;
      continue;
    }
    const canvasMoved = c !== canvas[part];
    const repoMoved = repo[part] === undefined || sides.repo[part] !== repo[part];
    if (agree && canvasMoved && repoMoved) {
      canvas[part] = c;
      repo[part] = sides.repo[part];
      changed = true;
    } else if (agree && repo[part] === undefined) {
      repo[part] = sides.repo[part];
      changed = true;
    }
  }
  return changed ? { repo, canvas, at } : null;
}
