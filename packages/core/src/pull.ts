/**
 * Snapshot a whole Canvas course to disk, exactly as Canvas stores it.
 *
 * This is not the reverse of `push`. Nothing is converted: each object is written
 * as its raw JSON payload, its body as the HTML Canvas holds, and each course file
 * as its bytes. That keeps the snapshot lossless, so it serves as a backup, as
 * something to diff between two dates, and as input an agent can read without a
 * token.
 *
 * `index.json` records every path a pull wrote. A later pull into the same
 * directory uses it to remove what it wrote before and did not write again (a
 * deleted page, a renamed assignment), and never touches anything else in the
 * directory. Whatever could not be fetched this time keeps its previous copy, so a
 * single 403 does not quietly erase part of the last good snapshot.
 */

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { CanvasLMS } from "./canvas";
import type { Payload } from "./types";

export type Reporter = (message: string) => void;

/** The client methods a pull calls, so a test can hand in a plain object. */
export type PullCanvas = Pick<
  CanvasLMS,
  | "getCourseWithSyllabus"
  | "listPages"
  | "getPage"
  | "listAssignments"
  | "listDiscussions"
  | "listAnnouncements"
  | "listQuizzes"
  | "listQuizQuestions"
  | "listModules"
  | "listModuleItems"
  | "listAssignmentGroups"
  | "listRubrics"
  | "listFolders"
  | "listFiles"
  | "downloadAttachment"
>;

/** What `--only` accepts, in the order a pull walks them. */
export const KINDS: readonly string[] = [
  "syllabus",
  "pages",
  "assignments",
  "discussions",
  "announcements",
  "quizzes",
  "modules",
  "groups",
  "rubrics",
  "files",
];

export const INDEX_NAME = "index.json";

// The index kind of course.json, which every pull writes whatever --only says.
const COURSE = "course";

// Every course folder hangs off this root, which would otherwise prefix every
// path in the snapshot without saying anything.
const ROOT_FOLDER = "course files";

/** Raised when a pull is asked for something it cannot do. */
export class PullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullError";
  }
}

/** One thing a pull wrote, and where. */
export interface Pulled {
  readonly kind: string;
  readonly ident: string;
  readonly title: string;
  readonly paths: string[];
}

export interface PullResult {
  entries: Pulled[];
  errors: string[];
  downloaded: number;
  /** Course files already on disk at the size and time Canvas reports. */
  unchanged: number;
  removed: string[];
}

/**
 * What a failed fetch throws. Python caught RuntimeError (an HTTP error) and
 * OSError (a dropped connection); JavaScript has no such split, since a failed
 * fetch is a TypeError and an HTTP error a plain Error, so any Error counts.
 */
function isFetchError(error: unknown): error is Error {
  return error instanceof Error;
}

// ---------------------------------------------------------------------------
// Pure path rules
// ---------------------------------------------------------------------------

export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `<id>-<slug>`: the id keeps it unique, the slug keeps it readable. */
export function stem(ident: string, title: string): string {
  const tail = slug(title);
  return tail ? `${ident}-${tail}` : ident;
}

// Characters Windows refuses in a file name, and the control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const ILLEGAL_RE = /[:*?"<>|\u0000-\u001f]/g;
// Device names Windows reserves, alone or with any extension ("con.txt").
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(\..*)?$/i;

/**
 * One path component that cannot climb out of the snapshot or split in two, and
 * that Windows will accept as a file name.
 */
export function safeComponent(name: string): string {
  let cleaned = name.replace(/[/\\\0]/g, "_").trim();
  cleaned = cleaned.replace(ILLEGAL_RE, "_");
  // Windows silently drops trailing dots and spaces, so "a." and "a" collide.
  cleaned = cleaned.replace(/[. ]+$/, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_";
  if (RESERVED_RE.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

/** Where a course file lands, under files/, mirroring its Canvas folder. POSIX. */
export function filePath(folder: string, name: string): string {
  let parts = folder.split("/").filter((p) => p);
  if (parts[0] === ROOT_FOLDER) parts = parts.slice(1);
  return path.posix.join("files", ...parts.map(safeComponent), safeComponent(name));
}

/** Epoch seconds for a Canvas timestamp, or null if it is not one. */
export function parseTime(value: unknown): number | null {
  // Date.parse accepts far more than ISO 8601 ("March 7"), so insist on the shape.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * True if a downloaded file already matches what Canvas reports.
 *
 * Size and modification time, as rsync does. The time is set from Canvas after
 * each download, so an unchanged file costs no bytes on the next pull.
 */
export function isCurrent(dest: string, size: unknown, modified: number | null): boolean {
  if (typeof size !== "number" || !Number.isInteger(size) || modified === null) return false;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dest);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  return stat.size === size && Math.trunc(stat.mtimeMs / 1000) === Math.trunc(modified);
}

function isPlainObject(value: unknown): value is Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadIndex(out: string): Payload {
  let loaded: unknown;
  try {
    loaded = JSON.parse(readFileSync(path.join(out, INDEX_NAME), "utf-8"));
  } catch {
    return {};
  }
  return isPlainObject(loaded) ? loaded : {};
}

export function indexEntries(index: Payload): Pulled[] {
  const raw = index.entries;
  const entries: Pulled[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isPlainObject(item)) continue;
    const paths = item.paths;
    entries.push({
      kind: String(item.kind ?? ""),
      ident: String(item.ident ?? ""),
      title: String(item.title ?? ""),
      paths: Array.isArray(paths) ? paths.map(String) : [],
    });
  }
  return entries;
}

/** Paths an earlier pull of these kinds wrote that this one did not. */
export function stalePaths(
  previous: readonly Pulled[],
  current: readonly Pulled[],
  kinds: ReadonlySet<string>,
): string[] {
  const kept = new Set(current.flatMap((entry) => entry.paths));
  const stale = new Set(
    previous
      .filter((entry) => kinds.has(entry.kind))
      .flatMap((entry) => entry.paths)
      .filter((p) => !kept.has(p)),
  );
  return [...stale].sort();
}

function titleOf(payload: Payload): string {
  return String(payload.title || payload.name || payload.display_name || "");
}

// ---------------------------------------------------------------------------
// The pull
// ---------------------------------------------------------------------------

export class Puller {
  readonly canvas: PullCanvas;
  readonly courseId: string;
  readonly out: string;
  readonly kinds: string[];
  readonly report: Reporter;
  readonly previous: Pulled[];
  readonly result: PullResult;
  private readonly previousByKey: Map<string, Pulled>;
  // Kinds whose listing came back whole. Only these are pruned: a listing
  // that failed says nothing about what was deleted.
  private readonly listed = new Set<string>();
  // Case-folded, since two files differing only in case collide on macOS.
  private readonly claimed = new Set<string>();

  constructor(
    canvas: PullCanvas,
    courseId: string,
    out: string,
    options: { kinds?: readonly string[]; report?: Reporter } = {},
  ) {
    const requested = options.kinds ?? [];
    const unknown = requested.filter((k) => !KINDS.includes(k));
    if (unknown.length > 0) {
      throw new PullError(
        `unknown kind ${unknown.join(", ")}; expected one of ${KINDS.join(", ")}`,
      );
    }
    this.canvas = canvas;
    this.courseId = courseId;
    this.out = out;
    this.kinds = KINDS.filter((k) => requested.length === 0 || requested.includes(k));
    this.report = options.report ?? (() => {});
    this.previous = indexEntries(loadIndex(out));
    this.previousByKey = new Map(this.previous.map((e) => [key(e.kind, e.ident), e]));
    this.result = { entries: [], errors: [], downloaded: 0, unchanged: 0, removed: [] };
  }

  // -- writing ---------------------------------------------------------

  private writeJson(rel: string, payload: unknown): string {
    const target = path.join(this.out, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    return rel;
  }

  private writeText(rel: string, text: string): string {
    const target = path.join(this.out, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, "utf-8");
    return rel;
  }

  /** Write one object's payload, and its body as HTML if it has one. */
  private object(
    kind: string,
    ident: string,
    title: string,
    base: string,
    payload: Payload,
    bodyField: string | null,
  ): Pulled {
    const paths = [this.writeJson(`${base}.json`, payload)];
    const body = bodyField ? payload[bodyField] : undefined;
    if (typeof body === "string" && body) paths.push(this.writeText(`${base}.html`, body));
    return { kind, ident, title, paths };
  }

  /** Record the failure and keep whatever the last pull had for this object. */
  private failed(kind: string, ident: string, title: string, error: Error): void {
    this.result.errors.push(`${kind} ${title || ident}: ${error.message}`);
    const previous = this.previousByKey.get(key(kind, ident));
    if (previous !== undefined) this.result.entries.push(previous);
  }

  // -- kinds -----------------------------------------------------------

  /** course.json on every pull, since it names what the snapshot is of. */
  private async course(): Promise<Payload> {
    const course = await this.canvas.getCourseWithSyllabus(this.courseId);
    const title = titleOf(course);
    this.result.entries.push({
      kind: COURSE,
      ident: this.courseId,
      title,
      paths: [this.writeJson("course.json", course)],
    });
    this.listed.add(COURSE);
    if (this.kinds.includes("syllabus")) {
      const body = course.syllabus_body;
      const paths =
        typeof body === "string" && body ? [this.writeText("syllabus.html", body)] : [];
      this.result.entries.push({ kind: "syllabus", ident: this.courseId, title, paths });
      this.listed.add("syllabus");
    }
    return course;
  }

  private async pages(): Promise<void> {
    for (const listed of await this.canvas.listPages(this.courseId)) {
      // The listing leaves the body out, so each page is fetched on its own.
      const pageUrl = String(listed.url ?? "");
      const title = titleOf(listed);
      let page: Payload;
      try {
        page = await this.canvas.getPage(this.courseId, pageUrl);
      } catch (error) {
        if (!isFetchError(error)) throw error;
        this.failed("pages", pageUrl, title, error);
        continue;
      }
      const base = `pages/${safeComponent(pageUrl)}`;
      this.result.entries.push(this.object("pages", pageUrl, title, base, page, "body"));
    }
  }

  private collection(kind: string, items: Payload[], bodyField: string): void {
    for (const item of items) {
      const ident = String(item.id ?? "");
      const title = titleOf(item);
      const base = `${kind}/${stem(ident, title)}`;
      this.result.entries.push(this.object(kind, ident, title, base, item, bodyField));
    }
  }

  private async quizzes(): Promise<void> {
    for (const quiz of await this.canvas.listQuizzes(this.courseId)) {
      const ident = String(quiz.id ?? "");
      const title = titleOf(quiz);
      const base = `quizzes/${stem(ident, title)}`;
      let questions: Payload[];
      try {
        questions = await this.canvas.listQuizQuestions(this.courseId, ident);
      } catch (error) {
        if (!isFetchError(error)) throw error;
        this.failed("quizzes", ident, title, error);
        continue;
      }
      const entry = this.object("quizzes", ident, title, base, quiz, "description");
      entry.paths.push(this.writeJson(`${base}.questions.json`, questions));
      this.result.entries.push(entry);
    }
  }

  private async modules(): Promise<void> {
    const modules = await this.canvas.listModules(this.courseId);
    for (const module of modules) {
      module.items = await this.canvas.listModuleItems(this.courseId, String(module.id ?? ""));
    }
    this.result.entries.push({
      kind: "modules",
      ident: "",
      title: "modules",
      paths: [this.writeJson("modules.json", modules)],
    });
  }

  private async files(): Promise<void> {
    const folders = await this.canvas.listFolders(this.courseId);
    const files = await this.canvas.listFiles(this.courseId);
    const names = new Map(folders.map((f) => [String(f.id ?? ""), String(f.full_name ?? "")]));
    this.result.entries.push({
      kind: "files",
      ident: "",
      title: "files",
      paths: [this.writeJson("folders.json", folders), this.writeJson("files.json", files)],
    });
    for (const stored of files) {
      const ident = String(stored.id ?? "");
      const name = String(stored.display_name || stored.filename || ident);
      let rel = filePath(names.get(String(stored.folder_id ?? "")) ?? "", name);
      if (this.claimed.has(fold(rel))) {
        rel = path.posix.join(path.posix.dirname(rel), `${ident}-${path.posix.basename(rel)}`);
      }
      this.claimed.add(fold(rel));

      const url = stored.url;
      if (typeof url !== "string" || !url) {
        this.failed("files", ident, name, new Error("Canvas gave no download url"));
        continue;
      }
      const dest = path.join(this.out, rel);
      const modified = parseTime(stored.modified_at || stored.updated_at);
      this.report(`Downloading ${rel}`);
      if (isCurrent(dest, stored.size, modified)) {
        this.result.unchanged += 1;
      } else {
        try {
          await this.canvas.downloadAttachment(url, dest);
        } catch (error) {
          if (!isFetchError(error)) throw error;
          this.failed("files", ident, name, error);
          continue;
        }
        if (modified !== null) utimesSync(dest, modified, modified);
        this.result.downloaded += 1;
      }
      this.result.entries.push({ kind: "files", ident, title: name, paths: [rel] });
    }
  }

  // -- driver ----------------------------------------------------------

  /** Pull every selected kind, prune what went away, and return the index. */
  async run(): Promise<Payload> {
    mkdirSync(this.out, { recursive: true });
    this.report("Reading course");
    const course = await this.course();

    const steps: Record<string, () => Promise<void>> = {
      pages: () => this.pages(),
      assignments: async () =>
        this.collection(
          "assignments",
          await this.canvas.listAssignments(this.courseId),
          "description",
        ),
      discussions: async () =>
        this.collection("discussions", await this.canvas.listDiscussions(this.courseId), "message"),
      announcements: async () =>
        this.collection(
          "announcements",
          await this.canvas.listAnnouncements(this.courseId),
          "message",
        ),
      quizzes: () => this.quizzes(),
      modules: () => this.modules(),
      groups: async () => {
        const groups = await this.canvas.listAssignmentGroups(this.courseId);
        this.result.entries.push({
          kind: "groups",
          ident: "",
          title: "assignment groups",
          paths: [this.writeJson("assignment_groups.json", groups)],
        });
      },
      rubrics: async () => {
        const rubrics = await this.canvas.listRubrics(this.courseId);
        this.result.entries.push({
          kind: "rubrics",
          ident: "",
          title: "rubrics",
          paths: [this.writeJson("rubrics.json", rubrics)],
        });
      },
      files: () => this.files(),
    };
    for (const kind of this.kinds) {
      const step = steps[kind];
      if (step === undefined) continue;
      this.report(`Reading ${kind}`);
      try {
        await step();
      } catch (error) {
        if (!isFetchError(error)) throw error;
        // A course with a tool switched off answers 404 for its listing.
        // Report it and carry on, and keep the last snapshot of that kind.
        this.result.errors.push(`${kind}: ${error.message}`);
        const done = new Set(this.result.entries.map((e) => key(e.kind, e.ident)));
        this.result.entries.push(
          ...this.previous.filter((e) => e.kind === kind && !done.has(key(e.kind, e.ident))),
        );
        continue;
      }
      this.listed.add(kind);
    }

    this.prune();

    // A partial pull (--only) must not forget the kinds it did not visit, or
    // the next full pull could not prune them.
    const visited = new Set([...this.kinds, COURSE]);
    const entries = [
      ...this.previous.filter((e) => !visited.has(e.kind)),
      ...this.result.entries,
    ];
    const index: Payload = {
      course_id: this.courseId,
      course_name: titleOf(course),
      pulled_at: `${new Date().toISOString().slice(0, 19)}+00:00`,
      kinds: this.kinds,
      entries: entries.map((e) => ({
        kind: e.kind,
        ident: e.ident,
        title: e.title,
        paths: [...e.paths],
      })),
      errors: this.result.errors,
    };
    this.writeJson(INDEX_NAME, index);
    return index;
  }

  private prune(): void {
    const root = realpathSync(this.out);
    for (const rel of stalePaths(this.previous, this.result.entries, this.listed)) {
      // Resolve symlinks, so a linked directory cannot carry a delete outside.
      let resolved: string;
      try {
        resolved = realpathSync(path.join(this.out, rel));
      } catch {
        continue; // already gone
      }
      // index.json is only a file on disk; never follow it outside the snapshot.
      const inside = path.relative(root, resolved);
      if (
        inside === "" ||
        inside === ".." ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside) ||
        resolved === path.join(root, INDEX_NAME) ||
        !statSync(resolved).isFile()
      ) {
        continue;
      }
      unlinkSync(resolved);
      this.result.removed.push(rel);
    }
  }
}

function key(kind: string, ident: string): string {
  return JSON.stringify([kind, ident]);
}

/** Python's str.casefold(), close enough for file names. */
function fold(rel: string): string {
  return rel.toLowerCase();
}
