/**
 * Read published content back out of Canvas and prove it arrived intact.
 *
 * A 200 response does not mean the content landed. Canvas scrubs page bodies
 * against its own allowlist and returns success either way, throttling can leave a
 * run half-finished, and a quiz can end up with some of its questions. So after
 * writing, we go and look.
 *
 * Comparison is semantic rather than byte-for-byte: Canvas normalises markup and
 * adds its own data-api-* attributes, so both sides are reduced to visible text,
 * structural element counts, style declarations, and link targets before compare.
 */

import { formatG, pyRepr } from "./objects";
import {
  canvasPath,
  type Entry,
  internalLinks,
  type Manifest,
  structureCounts,
  styleDeclarations,
  visibleText,
} from "./publish";
import type { Payload } from "./types";

/** One thing that is wrong in Canvas. */
export interface Failure {
  readonly key: string;
  readonly check: string;
  readonly detail: string;
}

/** What the publisher meant to put in Canvas, for one object. */
export interface Intent {
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly body?: string;
  readonly points?: number | null;
  readonly published?: boolean;
  readonly dueAt?: string | null;
  readonly unlockAt?: string | null;
  readonly lockAt?: string | null;
  readonly questionCount?: number;
  readonly fileSize?: number | null;
  readonly moduleItems?: number | null;
}

function failure(key: string, check: string, detail: string): Failure {
  return { key, check, detail };
}

/** Python's `repr()` of a float, which is how the messages print a number Canvas holds. */
function floatRepr(value: number | null): string {
  if (value === null) return "None";
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  const abs = Math.abs(value);
  if (abs !== 0 && Number.isFinite(value) && (abs >= 1e16 || abs < 1e-4)) {
    const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
    const sign = exponent.startsWith("-") ? "-" : "+";
    return `${mantissa}e${sign}${exponent.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return pyRepr(value);
}

/** `isinstance(x, (int, float))`, where a bool counts as an int. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

/** Python's `float()` of a JSON value; anything it would reject is NaN, which equals nothing. */
function toFloat(value: unknown): number {
  const number = asNumber(value);
  if (number !== null) return number;
  if (typeof value === "string" && value.trim() !== "") return Number(value.trim());
  return Number.NaN;
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's `str()` of a JSON value. */
function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/** `stored.get(key, default)`: the default only when the key is absent. */
function get(stored: Payload, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(stored, key) ? stored[key] : fallback;
}

/** Canvas returns UTC ISO 8601 with a Z; normalise for comparison. */
function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.replaceAll("+00:00", "Z");
}

/** First point of divergence between two visible-text renderings. */
function diffText(intended: string, stored: string): string | null {
  if (intended === stored) return null;
  // Indexed by code point, as Python indexes a str, so the offsets read the same.
  const want = Array.from(intended);
  const got = Array.from(stored);
  const limit = Math.min(want.length, got.length);
  let index = limit;
  for (let i = 0; i < limit; i++) {
    if (want[i] !== got[i]) {
      index = i;
      break;
    }
  }
  const around = (chars: string[]): string => chars.slice(Math.max(0, index - 40), index + 40).join("");
  return (
    `diverges at character ${index} of ${want.length}: ` +
    `expected …${pyRepr(around(want))}, ` +
    `Canvas has …${pyRepr(around(got))}`
  );
}

/** Checks 2, 3 and 4: text, structure, and surviving style declarations. */
export function checkBody(key: string, intended: string, stored: string): Failure[] {
  const failures: Failure[] = [];

  const difference = diffText(visibleText(intended), visibleText(stored));
  if (difference) failures.push(failure(key, "content", difference));

  const want = structureCounts(intended);
  const got = structureCounts(stored);
  const changed = Object.keys(want)
    .filter((tag) => want[tag] !== got[tag])
    .sort();
  if (changed.length > 0) {
    const summary = changed.map((tag) => `${tag}: sent ${want[tag]}, stored ${got[tag]}`).join(", ");
    failures.push(failure(key, "structure", summary));
  }

  const kept = new Set(styleDeclarations(stored));
  const lost = [...new Set(styleDeclarations(intended).filter((d) => !kept.has(d)))].sort();
  if (lost.length > 0) {
    const shown = lost.slice(0, 6).join(", ") + (lost.length > 6 ? ` (+${lost.length - 6} more)` : "");
    failures.push(failure(key, "styles", `${lost.length} declarations stripped: ${shown}`));
  }

  return failures;
}

/**
 * Check 5: every course-relative link points at something that exists.
 *
 * Async because `resolves` normally asks Canvas; links are checked one at a
 * time, since Canvas charges for parallel requests.
 */
export async function checkLinks(
  key: string,
  body: string,
  courseId: string,
  known: ReadonlySet<string>,
  resolves: (link: string) => boolean | Promise<boolean>,
): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const link of internalLinks(body, courseId)) {
    if (known.has(link)) continue;
    if (!(await resolves(link))) failures.push(failure(key, "link", `${link} does not resolve`));
  }
  return failures;
}

/** Checks 6 and 7: points, published state, and the three date fields. */
export function checkMetadata(key: string, intent: Intent, stored: Payload): Failure[] {
  const failures: Failure[] = [];

  const points = intent.points ?? null;
  if (points !== null) {
    const actual = asNumber(get(stored, "points_possible"));
    if (actual !== points) {
      failures.push(failure(key, "points", `expected ${formatG(points)}, Canvas has ${floatRepr(actual)}`));
    }
  }

  if (Object.hasOwn(stored, "published")) {
    const actualPublished = truthy(stored.published);
    const expected = intent.published ?? false;
    if (actualPublished !== expected) {
      failures.push(
        failure(
          key,
          "published",
          `expected published=${pyRepr(expected)}, Canvas has ${pyRepr(actualPublished)}`,
        ),
      );
    }
  }

  const fields: Array<[string, string | null | undefined]> = [
    ["due_at", intent.dueAt],
    ["unlock_at", intent.unlockAt],
    ["lock_at", intent.lockAt],
  ];
  for (const [fieldName, expected] of fields) {
    if (expected === null || expected === undefined) continue;
    const actualDate = iso(get(stored, fieldName));
    if (actualDate !== iso(expected)) {
      failures.push(failure(key, fieldName, `expected ${pyStr(iso(expected))}, Canvas has ${pyStr(actualDate)}`));
    }
  }

  return failures;
}

/** Check 8: every question present, correctly typed and correctly keyed. */
export function checkQuizQuestions(key: string, expectedCount: number, questions: readonly Payload[]): Failure[] {
  const failures: Failure[] = [];
  if (questions.length !== expectedCount) {
    failures.push(
      failure(key, "questions", `expected ${expectedCount} questions, Canvas has ${questions.length}`),
    );
  }

  for (const question of questions) {
    const name = pyStr(get(question, "question_name", "?"));
    const answers = question.answers;
    if (!Array.isArray(answers) || answers.length === 0) {
      failures.push(failure(key, "answers", `${name}: no answers stored`));
      continue;
    }
    const correct = answers.filter(
      (a: unknown) =>
        typeof a === "object" &&
        a !== null &&
        !Array.isArray(a) &&
        toFloat(truthy((a as Payload).weight) ? (a as Payload).weight : 0) === 100,
    );
    if (correct.length === 0) failures.push(failure(key, "answers", `${name}: no correct answer keyed`));
    const kind = pyStr(get(question, "question_type", ""));
    if (kind === "multiple_choice_question" && correct.length !== 1) {
      failures.push(failure(key, "answers", `${name}: multiple choice with ${correct.length} correct answers`));
    }
    // Canvas keeps the two forms in separate fields and fills only the one it
    // was given, so a rendered rationale leaves neutral_comments empty.
    const rationale =
      pyStr(get(question, "neutral_comments", "")) || pyStr(get(question, "neutral_comments_html", ""));
    if (!rationale.trim()) failures.push(failure(key, "rationale", `${name}: rationale missing`));
  }
  return failures;
}

/** Check 9: the upload finished and the bytes all arrived. */
export function checkFile(key: string, expectedSize: number, stored: Payload): Failure[] {
  const failures: Failure[] = [];
  const status = truthy(stored.upload_status) ? stored.upload_status : stored.workflow_state;
  const state = truthy(status) ? pyStr(status) : "";
  if (!["", "success", "available"].includes(state)) {
    failures.push(failure(key, "file", `upload state is ${pyRepr(state)}, not available`));
  }
  const raw = stored.size;
  let actual: number | null = null;
  if (typeof raw === "number" && Number.isInteger(raw)) actual = raw;
  else if (typeof raw === "boolean") actual = raw ? 1 : 0;
  else if (typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw)) actual = Number(raw);
  if (actual !== expectedSize) {
    failures.push(failure(key, "file", `expected ${expectedSize} bytes, Canvas has ${pyStr(actual)}`));
  }
  return failures;
}

/** Check 10: the module holds what it should, in order. */
export function checkModule(key: string, expectedItems: number, items: readonly Payload[]): Failure[] {
  const failures: Failure[] = [];
  if (items.length !== expectedItems) {
    failures.push(failure(key, "module", `expected ${expectedItems} items, Canvas has ${items.length}`));
  }
  const positions = items.map((i) => Number.parseInt(pyStr(get(i, "position", 0)), 10));
  if (positions.some((p, index) => index > 0 && p < (positions[index - 1] as number))) {
    failures.push(failure(key, "module", "items are out of order"));
  }
  return failures;
}

/** Check 11: nothing was lost between the repository and the gradebook. */
export function checkGradebookTotal(assignments: readonly Payload[], expected: number): Failure[] {
  let total = 0;
  for (const assignment of assignments) {
    const raw = asNumber(assignment.points_possible);
    if (raw !== null) total += raw;
  }
  if (total !== expected) {
    return [failure("<course>", "gradebook", `points total ${formatG(total)}, expected ${formatG(expected)}`)];
  }
  return [];
}

/**
 * Check 12: every gradable item is placed by some [[module]].
 *
 * Students navigate a course through Modules, so an assignment that no table
 * lists is published and yet invisible. This is a fact about the repo rather
 * than about Canvas, so the caller computes it with no network at all.
 */
export function checkModuleMembership(unlisted: readonly string[]): Failure[] {
  return unlisted.map((key) => failure(key, "module", "in no [[module]]; students will not find it"));
}

/** Check 1: the object still exists and is still the one we created. */
export function checkIdentity(key: string, entry: Entry, stored: Payload | null): Failure[] {
  if (stored === null) {
    return [failure(key, "missing", `${entry.kind} ${entry.canvasId} does not resolve in Canvas`)];
  }
  const raw = truthy(stored.title) ? stored.title : stored.name;
  const title = truthy(raw) ? pyStr(raw) : "";
  if (entry.title && title && title !== entry.title) {
    return [failure(key, "title", `expected ${pyRepr(entry.title)}, Canvas has ${pyRepr(title)}`)];
  }
  return [];
}

/** Failure counts by check name, for the report table. */
export function summarise(failures: readonly Failure[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of failures) counts[f.check] = (counts[f.check] ?? 0) + 1;
  return counts;
}

/** Every course-relative URL the manifest can vouch for. */
export function knownLinkTargets(manifest: Manifest, courseId: string): Set<string> {
  return new Set([...manifest.entries.values()].map((entry) => canvasPath(entry, courseId)));
}
