/**
 * Compare the manifest against what a course actually contains.
 *
 * `verify` walks the manifest and proves each tracked object is still in Canvas
 * and intact. It never looks the other way, so an exam quiz built by hand, a page
 * someone added in the Canvas UI, or a file uploaded from a laptop is invisible
 * to it. This module takes both inventories and reports the differences in both
 * directions:
 *
 *     stale      the manifest points at something Canvas no longer has
 *     untracked  Canvas has something no repo file produced
 *     pending    canvas.toml declares a module the next push will create
 *
 * Modules are not in the manifest at all; the push pairs them with the
 * `[[module]]` tables in canvas.toml by name, so they are compared by name here
 * too, and their items are checked against the manifest one by one.
 *
 * Everything here is pure: the caller fetches the live inventory and hands it in.
 */

import { moduleTitle, type Term } from "./dates";
import { pyRepr } from "./objects";
import { type Manifest, type NativeItem, moduleEntries, parseNativeItems, ValueError } from "./publish";
import type { Payload } from "./types";

export type Side = "stale" | "untracked" | "pending";

/** One [[module]] table from canvas.toml, as far as the audit cares. */
export interface DeclaredModule {
  readonly title: string;
  readonly native: readonly NativeItem[];
}

/** One thing that exists in the course right now. */
export interface LiveObject {
  readonly kind: string;
  readonly ident: string;
  readonly title: string;
  readonly published: boolean;
  readonly detail: string;
}

export interface Difference {
  readonly side: Side;
  readonly kind: string;
  readonly ident: string;
  readonly title: string;
  readonly key: string;
  readonly detail: string;
}

/**
 * The Python version keys its sets by `(kind, ident)` tuples. A JavaScript Set
 * compares arrays by identity, so the pair is joined into one string instead.
 * No kind contains a colon, so the first colon always splits it back.
 */
export function kindIdent(kind: string, ident: string): string {
  return `${kind}:${ident}`;
}

// ---------------------------------------------------------------------------
// Python semantics for loosely typed Canvas payloads and TOML tables
// ---------------------------------------------------------------------------

/** `isinstance(x, dict)` for parsed TOML or JSON: a plain table, not a date or a list. */
function isTable(value: unknown): value is Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `str(obj.get(key, ""))`: "" when the key is absent, Python's str() otherwise. */
function str(obj: Payload, key: string): string {
  if (!Object.hasOwn(obj, key)) return "";
  const value = obj[key];
  return typeof value === "string" ? value : pyRepr(value);
}

/** Python's `<` on two strings, by code point. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  const x = Array.from(a, (c) => c.codePointAt(0) as number);
  const y = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

// ---------------------------------------------------------------------------
// The declared side
// ---------------------------------------------------------------------------

/**
 * The [[module]] tables of a parsed canvas.toml.
 *
 * A malformed `canvas` list is the push's problem to report; here it just
 * contributes no native items, so its module's hand placed items show up as
 * untracked, which is the truthful answer.
 */
export function declaredModules(raw: Payload, term: Term | null = null): DeclaredModule[] {
  const modules = Object.hasOwn(raw, "module") ? raw.module : [];
  if (!Array.isArray(modules)) return [];
  const out: DeclaredModule[] = [];
  for (const module of modules) {
    if (!isTable(module)) continue;
    let native: NativeItem[];
    try {
      native = parseNativeItems(module);
      for (const e of moduleEntries(module)) if (e.native !== null) native.push(e.native);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      native = [];
    }
    const title = term !== null ? moduleTitle(module, term) : str(module, "title");
    out.push({ title, native });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The live side
// ---------------------------------------------------------------------------

function ident(kind: string, entryId: string, pageUrl: string): string {
  return kind === "page" ? pageUrl : entryId;
}

function live(kind: string, ident: string, title: string, published: boolean, detail = ""): LiveObject {
  return { kind, ident, title, published, detail };
}

export function livePages(pages: readonly Payload[]): LiveObject[] {
  return pages.map((p) => live("page", str(p, "url"), str(p, "title"), truthy(p.published)));
}

/**
 * Plain assignments only.
 *
 * Canvas lists a quiz and a graded discussion as assignments too, with the
 * real object hanging off them. Those are tracked as quizzes and discussions,
 * so they are left out here rather than reported twice.
 */
export function liveAssignments(assignments: readonly Payload[]): LiveObject[] {
  const out: LiveObject[] = [];
  for (const a of assignments) {
    if (truthy(a.is_quiz_assignment) || truthy(a.quiz_id)) continue;
    if (truthy(a.discussion_topic)) continue;
    out.push(live("assignment", str(a, "id"), str(a, "name"), truthy(a.published)));
  }
  return out;
}

export function liveDiscussions(topics: readonly Payload[]): LiveObject[] {
  return topics.map((t) => live("discussion", str(t, "id"), str(t, "title"), truthy(t.published)));
}

export function liveQuizzes(quizzes: readonly Payload[]): LiveObject[] {
  return quizzes.map((q) => live("quiz", str(q, "id"), str(q, "title"), truthy(q.published)));
}

export function liveFiles(files: readonly Payload[]): LiveObject[] {
  return files.map((f) =>
    live(
      "file",
      str(f, "id"),
      truthy(f.display_name) ? str(f, "display_name") : str(f, "filename"),
      !truthy(f.locked) && !truthy(f.hidden),
      `${str(f, "size")} bytes`,
    ),
  );
}

/** Modules, with the count of items each holds in `detail`. */
export function liveModules(
  modules: readonly Payload[],
  items: Readonly<Record<string, readonly Payload[]>>,
): LiveObject[] {
  return modules.map((m) => {
    const id = str(m, "id");
    const held = Object.hasOwn(items, id) ? (items[id] ?? []) : [];
    return live("module", id, str(m, "name"), truthy(m.published), `${held.length} items`);
  });
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** Manifest entries against the live pages, assignments, discussions, quizzes and files. */
export function auditObjects(
  manifest: Manifest,
  liveObjects: readonly LiveObject[],
  drafts: ReadonlySet<string>,
): Difference[] {
  const tracked = new Map<string, { kind: string; ident: string; key: string }>();
  for (const [key, entry] of manifest.entries) {
    if (entry.kind === "module" || entry.kind === "syllabus") continue;
    const id = ident(entry.kind, entry.canvasId, entry.pageUrl);
    tracked.set(kindIdent(entry.kind, id), { kind: entry.kind, ident: id, key });
  }

  const present = new Set(liveObjects.map((obj) => kindIdent(obj.kind, obj.ident)));
  const differences: Difference[] = [];

  const byKey = [...tracked.entries()].sort(([, a], [, b]) => compare(a.key, b.key));
  for (const [pair, { kind, ident: id, key }] of byKey) {
    if (present.has(pair)) continue;
    const entry = manifest.entries.get(key);
    const note = drafts.has(key) ? "draft, so the next push will not recreate it" : "";
    differences.push({ side: "stale", kind, ident: id, title: entry?.title ?? "", key, detail: note });
  }

  const ordered = [...liveObjects].sort((a, b) => compare(a.kind, b.kind) || compare(a.title, b.title));
  for (const obj of ordered) {
    if (tracked.has(kindIdent(obj.kind, obj.ident))) continue;
    const state = obj.published ? "published" : "unpublished";
    const detail = obj.detail ? `${state}; ${obj.detail}` : state;
    differences.push({ side: "untracked", kind: obj.kind, ident: obj.ident, title: obj.title, key: "", detail });
  }

  return differences;
}

/**
 * The [[module]] tables against the live modules, and each module's items
 * against the manifest and the module's own `canvas` list.
 *
 * A module item that neither the manifest nor the `canvas` list knows is
 * reported, because the next push deletes every item in a tracked module and
 * rebuilds it from canvas.toml, so anything added by hand is about to
 * disappear. Naming it under `canvas` is what keeps it.
 */
export function auditModules(
  declared: readonly DeclaredModule[],
  modules: readonly LiveObject[],
  items: Readonly<Record<string, readonly Payload[]>>,
  manifest: Manifest,
): Difference[] {
  const differences: Difference[] = [];
  const liveByName = new Map(modules.map((m) => [m.title, m]));
  const declaredByTitle = new Map(declared.map((d) => [d.title, d]));

  // A declared module Canvas lacks is not an inconsistency: modules have no
  // manifest entry, and the next push creates it. It is listed so nobody is
  // surprised when it appears.
  for (const title of declaredByTitle.keys()) {
    if (!liveByName.has(title)) {
      differences.push({
        side: "pending",
        kind: "module",
        ident: "",
        title,
        key: "",
        detail: "declared in canvas.toml; the next push creates it",
      });
    }
  }

  const tracked = new Set<string>();
  for (const entry of manifest.entries.values()) {
    tracked.add(kindIdent(entry.kind, ident(entry.kind, entry.canvasId, entry.pageUrl)));
  }

  for (const module of modules) {
    const declaredModule = declaredByTitle.get(module.title);
    if (declaredModule === undefined) {
      const state = module.published ? "published" : "unpublished";
      differences.push({
        side: "untracked",
        kind: "module",
        ident: module.ident,
        title: module.title,
        key: "",
        detail: `${state}; ${module.detail}`,
      });
      continue;
    }
    const known = new Set(tracked);
    for (const n of declaredModule.native) known.add(kindIdent(n.kind, n.ident));
    const held = Object.hasOwn(items, module.ident) ? (items[module.ident] ?? []) : [];
    for (const item of held) {
      const kind = str(item, "type").toLowerCase();
      let id: string;
      if (kind === "page") {
        id = str(item, "page_url");
      } else if (["assignment", "discussion", "quiz", "file"].includes(kind)) {
        id = str(item, "content_id");
      } else {
        // Headers, external links and tools have no repo counterpart.
        id = "";
      }
      if (!id || known.has(kindIdent(kind, id))) continue;
      differences.push({
        side: "untracked",
        kind: "module item",
        ident: str(item, "id"),
        title: str(item, "title"),
        key: "",
        detail:
          `${kind} in module ${pyRepr(module.title)}; the next push removes it ` +
          `unless canvas.toml lists it as { ${kind} = ${id} }`,
      });
    }
  }

  return differences;
}

export function summarise(differences: readonly Difference[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of differences) {
    const label = `${d.side} ${d.kind}`;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Clean sync: what a start-of-term push --clean removes
// ---------------------------------------------------------------------------

// Files are left out on purpose. A course card or a hand-uploaded handout is
// referenced from course settings and from pages the repo does not know about,
// and a stray file costs nothing, so a clean sync never deletes one.
export const CLEANABLE: readonly string[] = ["page", "assignment", "discussion", "quiz", "module"];

/**
 * Everything a clean sync must leave: every native item a [[module]] names,
 * plus the `[clean] keep` list, written like a module's native items:
 *
 *     [clean]
 *     keep = [{ quiz = 393731 }, { page = "home-page" }]
 *
 * Returned as `kindIdent` strings.
 */
export function cleanKeep(raw: Payload, declared: readonly DeclaredModule[]): Set<string> {
  const keep = new Set<string>();
  for (const module of declared) for (const n of module.native) keep.add(kindIdent(n.kind, n.ident));
  const section = Object.hasOwn(raw, "clean") ? raw.clean : {};
  if (!isTable(section)) throw new ValueError("canvas.toml [clean] must be a table");
  const listed = Object.hasOwn(section, "keep") ? section.keep : [];
  for (const n of parseNativeItems({ canvas: listed })) keep.add(kindIdent(n.kind, n.ident));
  return keep;
}

/**
 * The untracked objects a clean sync deletes, in a safe order.
 *
 * Modules go last, so a failure part-way through never leaves a module
 * pointing at content that is already gone.
 */
export function cleanTargets(differences: readonly Difference[], keep: ReadonlySet<string>): Difference[] {
  const chosen = differences.filter(
    (d) => d.side === "untracked" && CLEANABLE.includes(d.kind) && !keep.has(kindIdent(d.kind, d.ident)),
  );
  const isModule = (d: Difference): number => (d.kind === "module" ? 1 : 0);
  return chosen.sort((a, b) => isModule(a) - isModule(b) || compare(a.kind, b.kind) || compare(a.title, b.title));
}

/**
 * Why this object holds student work, or "" if it holds none.
 *
 * A clean sync is for a course nobody has used yet. Deleting a graded object
 * takes its submissions and grades with it, so anything with work in it is
 * refused rather than deleted.
 */
export function studentWork(kind: string, stored: Payload, assignment: Payload | null): string {
  if (assignment !== null && truthy(assignment.has_submitted_submissions)) return "has submissions";
  if (kind === "assignment" && truthy(stored.has_submitted_submissions)) return "has submissions";
  if (kind === "discussion") {
    const replies = stored.discussion_subentry_count;
    if (typeof replies === "number" && Number.isInteger(replies) && replies > 0) return `has ${replies} post(s)`;
  }
  return "";
}
