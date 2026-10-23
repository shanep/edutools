/**
 * Pure: a course repository as a Google Drive folder of Docs.
 *
 * The same repo that becomes a Canvas course becomes a folder colleagues can
 * read, comment on and copy: the syllabus at the top, one folder per
 * [[module]] in order, every page, assignment, discussion and quiz as a Google
 * Doc, every course file stored as it is, and the objective alignment sheet as
 * a Google Sheet when objectives.md has one. Unlike Canvas, the copy keeps the
 * instructor-only sections and the never_publish modules, because it is for
 * instructors.
 *
 * This module decides the layout, renders each Doc's HTML and keeps the
 * manifest; drive-push.ts does the talking to Drive.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DateTime } from "luxon";
import {
  type AlignmentCell,
  type AlignmentRow,
  alignmentCells,
  alignmentCsv,
  asTemplateChoices,
  parseObjectives,
} from "./alignment";
import { DateConfigError, type ItemDates, moduleTitle } from "./dates";
import { isFile, repoKey, toPosix } from "./paths";
import { moduleEntries, renderMarkdown, stripTitle, ValueError } from "./publish";
import type { Plan, Publisher } from "./publisher";
import { fingerprint, fingerprintBytes } from "./sync";

/** A folder under the course root. `key` is stable across pushes; `name` is what Drive shows. */
export interface DriveFolder {
  readonly key: string;
  readonly name: string;
}

/** One repo file as Drive holds it. */
export interface DriveItem {
  readonly key: string;
  /** A Google Doc made from markdown, a file uploaded as it is, or a Google Sheet made from a table. */
  readonly kind: "doc" | "file" | "sheet";
  /** The name in Drive, with a position prefix inside a module folder. */
  readonly name: string;
  /** The title as the Doc shows it. */
  readonly title: string;
  /** The folder key, or "" for the course root. */
  readonly folder: string;
  readonly source: string;
  readonly dates: ItemDates | null;
}

export interface DriveLayout {
  readonly folders: readonly DriveFolder[];
  readonly items: readonly DriveItem[];
}

export const FILES_FOLDER = "files";
export const OTHER_FOLDER = "other";
/** The objective alignment sheet's key: built from objectives.md, but not that page's Doc. */
export const ALIGNMENT_KEY = "sheet:objectives.md";
const ALIGNMENT_NAME = "Objective Alignment Sheet";

/**
 * eCampus's template workbook, which a course can keep beside objectives.md (a
 * link to one shared copy is fine). With it, the sheet is built in the template,
 * with its styling, dropdowns and notes, rather than as plain cells.
 */
export const ALIGNMENT_TEMPLATE = "objective-alignment-template.xlsx";

/** The repo's alignment template, or null when it has none. */
export function alignmentTemplate(repo: string): string | null {
  const file = path.join(repo, ALIGNMENT_TEMPLATE);
  return isFile(repo, ALIGNMENT_TEMPLATE) ? file : null;
}

/** The alignment sheet's rows from the repo's objectives.md, or none. */
export function alignmentRows(repo: string): AlignmentRow[] {
  const file = path.join(repo, "objectives.md");
  return existsSync(file) ? parseObjectives(readFileSync(file, "utf8")) : [];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function titleOf(plan: Plan): string {
  if (plan.kind === "syllabus") return "Syllabus";
  if (plan.kind === "file") return path.basename(plan.key);
  if (plan.dates) return plan.dates.title;
  const source = plan.source ?? "";
  const [title] = existsSync(source) ? stripTitle(readFileSync(source, "utf8")) : [""];
  return title || path.parse(plan.key).name;
}

/**
 * Where every planned item goes.
 *
 * The syllabus sits at the root, and so does the objective alignment sheet
 * when objectives.md is written as one. Each [[module]] table, never_publish ones
 * included, is a folder named with its position and its Canvas title, and holds
 * the items it lists, in order. An item listed by two modules lives in the
 * first. A course file no module lists goes in Files; anything else unlisted
 * goes in Other. Text headers and Canvas-native items have no repo file and are
 * left out, and so are the [icons] images, which only decorate Canvas headings.
 */
export function driveLayout(publisher: Publisher, plans: readonly Plan[]): DriveLayout {
  const byKey = new Map(plans.map((plan) => [plan.key, plan]));
  const folders: DriveFolder[] = [];
  const items: DriveItem[] = [];
  const placed = new Set<string>();
  const add = (plan: Plan, folder: string, position: number | null): void => {
    const title = titleOf(plan);
    items.push({
      key: plan.key,
      kind: plan.kind === "file" ? "file" : "doc",
      name: position === null ? title : `${pad(position)} ${title}`,
      title,
      folder,
      source: plan.source ?? path.join(publisher.repo, plan.key),
      dates: plan.dates,
    });
    placed.add(plan.key);
  };

  const syllabus = plans.find((plan) => plan.kind === "syllabus");
  if (syllabus) add(syllabus, "", 0);
  if (alignmentRows(publisher.repo).length > 0) {
    items.push({
      key: ALIGNMENT_KEY,
      kind: "sheet",
      name: ALIGNMENT_NAME,
      title: ALIGNMENT_NAME,
      folder: "",
      source: path.join(publisher.repo, "objectives.md"),
      dates: null,
    });
  }

  const seen = new Set<string>();
  publisher.moduleTables().forEach((module, index) => {
    const base = String(module.title ?? `Module ${index + 1}`);
    let key = `module:${base}`;
    if (seen.has(key)) key = `${key}#${index + 1}`;
    seen.add(key);
    let title: string;
    try {
      title = moduleTitle(module, publisher.config.term);
    } catch (error) {
      if (!(error instanceof DateConfigError)) throw error;
      title = base;
    }
    folders.push({ key, name: `${pad(index + 1)} ${title}` });
    let entries: ReturnType<typeof moduleEntries>;
    try {
      entries = moduleEntries(module);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      entries = [];
    }
    let position = 0;
    for (const line of entries) {
      const plan = line.key ? byKey.get(line.key) : undefined;
      if (plan === undefined || placed.has(plan.key)) continue;
      position += 1;
      add(plan, key, position);
    }
  });

  const icons = new Set(publisher.config.icons.map((icon) => repoKey(publisher.repo, icon.path)));
  const rest = plans.filter((plan) => !placed.has(plan.key) && !icons.has(plan.key));
  const files = rest.filter((plan) => plan.kind === "file");
  const others = rest.filter((plan) => plan.kind !== "file");
  if (files.length > 0) {
    folders.push({ key: FILES_FOLDER, name: "Files" });
    for (const plan of files) add(plan, FILES_FOLDER, null);
  }
  if (others.length > 0) {
    folders.push({ key: OTHER_FOLDER, name: "Other" });
    for (const plan of others) add(plan, OTHER_FOLDER, null);
  }
  return { folders, items };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function docUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

export function sheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

export function fileUrl(id: string): string {
  return `https://drive.google.com/file/d/${id}/view`;
}

export function folderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...IMAGE_TYPES,
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
  ".zip": "application/zip",
  ".html": "text/html",
};

/** The Content-Type a course file is uploaded with. */
export function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A raster image as a data URI, which a Doc imports as an embedded picture, or
 * null for anything else. Docs cannot show SVG, so an SVG stays a link.
 */
export function imageDataUri(file: string): string | null {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (type === undefined || !existsSync(file)) return null;
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}

/** Turns a repo key into where a link to it should go, or null when it cannot. */
export type DriveResolver = (key: string, attribute: "href" | "src") => string | null;

const HREF_RE = /(href|src)="([^"]+)"/g;
const LINKED_IMAGE_RE = /<img\b[^>]*?\bsrc="(https:\/\/drive\.google\.com\/file\/d\/[^"]+)"[^>]*>/g;
const ALT_RE = /\balt="([^"]*)"/;

/**
 * An image a Doc cannot embed (an SVG, say) as a link to its Drive file, named
 * by its alt text. A decorative image, with an empty alt, is dropped.
 */
function linkImages(html: string): string {
  return html.replace(LINKED_IMAGE_RE, (tag: string, url: string) => {
    const alt = ALT_RE.exec(tag)?.[1] ?? "";
    return alt ? `<a href="${url}">${alt}</a>` : "";
  });
}

/**
 * Point every repo-relative link at its Drive copy, as rewriteLinks does for
 * Canvas. Returns the HTML and the links that could not be resolved. A
 * #fragment is dropped: a Doc's heading anchors are not known until Drive
 * builds it.
 */
export function rewriteDriveLinks(
  html: string,
  source: string,
  repo: string,
  resolve: DriveResolver,
): [string, string[]] {
  const unresolved: string[] = [];
  const out = html.replace(HREF_RE, (whole: string, attribute: string, target: string) => {
    const url = driveTarget(target, source, repo, resolve, attribute === "src" ? "src" : "href");
    if (url === undefined) return whole;
    if (url === null) {
      unresolved.push(target);
      return whole;
    }
    return `${attribute}="${url}"`;
  });
  return [out, unresolved];
}

/**
 * Where a link in `source` goes in Drive: a URL, null when it points into the
 * repo at nothing Drive holds, or undefined when it is not a repo link at all.
 */
function driveTarget(
  target: string,
  source: string,
  repo: string,
  resolve: DriveResolver,
  attribute: "href" | "src",
): string | null | undefined {
  if (["http://", "https://", "mailto:", "#", "/", "data:"].some((prefix) => target.startsWith(prefix))) {
    return undefined;
  }
  const hash = target.indexOf("#");
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  if (!pathPart) return undefined;
  const joined = path.normalize(path.join(path.resolve(path.dirname(source)), pathPart));
  const relative = path.relative(path.resolve(repo), joined);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolve(toPosix(relative), attribute);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** "Sunday, October 12, 2026 at 11:59 PM MDT" */
export function formatDue(stamp: DateTime): string {
  return stamp.toFormat("cccc, LLLL d, yyyy 'at' h:mm a ZZZZ");
}

// Docs keeps a little of a stylesheet on import: enough for code to stay monospace.
const DOC_STYLE =
  "pre, code { font-family: 'Roboto Mono', 'Courier New', monospace; } " +
  "table { border-collapse: collapse; } th, td { border: 1px solid #555; padding: 4px 8px; }";

export interface RenderedDoc {
  readonly html: string;
  readonly unresolved: readonly string[];
}

/**
 * The HTML a Doc is made from: the title, the due date for a gradable item,
 * then the page with its instructor-only sections kept and its links pointed
 * at Drive.
 */
export function renderDoc(item: DriveItem, repo: string, resolve: DriveResolver): RenderedDoc {
  const [, body] = renderMarkdown(item.source, repo, { keepInstructor: true });
  const due = item.dates ? `<p><strong>Due:</strong> ${escapeHtml(formatDue(item.dates.dueAt))}</p>\n` : "";
  const [rewritten, unresolved] = rewriteDriveLinks(body, item.source, repo, resolve);
  const linked = linkImages(rewritten);
  const title = escapeHtml(item.title);
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${DOC_STYLE}</style></head>` +
    `<body><h1>${title}</h1>\n${due}${linked}</body></html>`;
  return { html, unresolved };
}

export interface RenderedSheet {
  /** The template workbook the rows go into, or null to send them as CSV. */
  readonly template: string | null;
  readonly rows: readonly AlignmentRow[];
  readonly cells: readonly (readonly AlignmentCell[])[];
  readonly csv: string;
  /** The same rows as an HTML table, for --preview. */
  readonly html: string;
  readonly unresolved: readonly string[];
}

/**
 * The alignment sheet's rows and cells. A link to a course item points at its
 * Drive copy, a web link stays, and any other link is kept as its text. With a
 * template, the facets are spelled as its dropdowns spell them.
 */
export function renderSheet(item: DriveItem, repo: string, resolve: DriveResolver): RenderedSheet {
  const template = alignmentTemplate(repo);
  const parsed = parseObjectives(readFileSync(item.source, "utf8"));
  const rows = template === null ? parsed : parsed.map(asTemplateChoices);
  const unresolved: string[] = [];
  const cells = alignmentCells(rows, (target) => {
    if (target.startsWith("http://") || target.startsWith("https://")) return target;
    const url = driveTarget(target, item.source, repo, resolve, "href");
    if (url === null) unresolved.push(target);
    return url ?? null;
  });
  const body = cells
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell.text)}</td>`).join("")}</tr>`)
    .join("\n");
  return { template, rows, cells, csv: alignmentCsv(cells), html: `<table>\n${body}\n</table>`, unresolved };
}

/**
 * The resolver for a set of Drive ids: a link to a course item goes to its Doc
 * or file, and an image is embedded from the repo whether or not the course
 * uploads it.
 */
export function driveResolver(
  repo: string,
  items: readonly DriveItem[],
  idOf: (key: string) => string | null,
): DriveResolver {
  const kinds = new Map(items.map((item) => [item.key, item.kind]));
  return (key, attribute) => {
    if (attribute === "src") {
      const embedded = isFile(repo, key) ? imageDataUri(path.join(repo, key)) : null;
      if (embedded !== null) return embedded;
    }
    const kind = kinds.get(key);
    const id = kind === undefined ? null : idOf(key);
    if (kind === undefined || id === null) return null;
    return kind === "doc" ? docUrl(id) : kind === "sheet" ? sheetUrl(id) : fileUrl(id);
  };
}

/** What a Doc's or file's content fingerprints to, to tell whether it needs sending. */
export function contentFingerprint(content: string | Uint8Array): string {
  return typeof content === "string" ? fingerprint(content) : fingerprintBytes(content);
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** What the last push left in Drive for one item or folder. */
export interface DriveEntry {
  id: string;
  name: string;
  /** The Drive id of the folder it was put in. */
  parent: string;
  /** The fingerprint of the content last sent; "" for a folder or a Doc still empty. */
  sent: string;
  /** Drive's modifiedTime after edutools last wrote it. A later one means someone edited it in Drive. */
  modified: string;
}

/** The folder the course folder goes in, picked with `drive folder`. */
export interface DriveParent {
  id: string;
  name: string;
}

interface ManifestJson {
  parent?: DriveParent;
  root?: DriveEntry;
  folders?: Record<string, DriveEntry>;
  items?: Record<string, DriveEntry>;
}

function sortedRecord(map: ReadonlyMap<string, DriveEntry>): Record<string, DriveEntry> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * `.drive/manifest.json` in the course repo: the folder the course goes in,
 * the Drive id of the course folder, of every module folder and of every item,
 * with what was last sent.
 * Committed, like `.canvas/`, so a push from another machine updates the same
 * Docs instead of making a second copy.
 */
export class DriveManifest {
  readonly path: string;
  /** Where the course folder goes; null puts it at the top of My Drive. */
  parent: DriveParent | null = null;
  root: DriveEntry | null = null;
  readonly folders = new Map<string, DriveEntry>();
  readonly items = new Map<string, DriveEntry>();

  constructor(file: string) {
    this.path = file;
    if (!existsSync(file)) return;
    // Written by save() below as exactly this shape.
    const data = JSON.parse(readFileSync(file, "utf8")) as ManifestJson;
    this.parent = data.parent ?? null;
    this.root = data.root ?? null;
    for (const [key, entry] of Object.entries(data.folders ?? {})) this.folders.set(key, entry);
    for (const [key, entry] of Object.entries(data.items ?? {})) this.items.set(key, entry);
  }

  static forRepo(repo: string): DriveManifest {
    return new DriveManifest(path.join(repo, ".drive", "manifest.json"));
  }

  save(): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const payload: ManifestJson = {
      ...(this.parent ? { parent: this.parent } : {}),
      ...(this.root ? { root: this.root } : {}),
      folders: sortedRecord(this.folders),
      items: sortedRecord(this.items),
    };
    writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
