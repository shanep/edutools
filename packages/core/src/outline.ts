/**
 * The module outline a push will build, computed from the repo alone.
 *
 * A course website wants to show the same structure Canvas shows under Modules,
 * and it wants it at build time with no Canvas token in reach. Everything Canvas
 * will display is already in the repo: the `[[module]]` tables say what goes
 * where, each file's `# Title` is the item's name, and the meta line plus the
 * term skeleton give the due date and the points. This module assembles that
 * into one plain structure that a site can commit and render.
 *
 * Pure: the caller reads canvas.toml and the item dates and hands them in.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { type ItemDates, isoformat, moduleTitle, type Term } from "./dates";
import { pyRepr } from "./objects";
import { isFile } from "./paths";
import { isDraft, type ModuleEntry, moduleEntries, type NativeItem, parseNativeItems, stripTitle, ValueError } from "./publish";
import type { Payload } from "./types";

/** One row under a module, as Canvas will show it. */
export interface OutlineItem {
  readonly kind: string; // page, assignment, discussion, quiz, file, header
  readonly title: string;
  readonly path: string; // repo path without .md, for the site to link; "" for a native item
  readonly dueAt: string | null; // ISO 8601 with offset
  readonly points: number | null;
  readonly canvasId: string; // native items only
}

export interface OutlineModule {
  readonly title: string;
  readonly items: readonly OutlineItem[];
}

/** One item as it appears in the committed JSON, with the Python field names. */
export interface OutlineItemJson {
  kind: string;
  title: string;
  path: string;
  due_at: string | null;
  points: number | null;
  canvas_id: string;
}

export interface OutlineModuleJson {
  title: string;
  items: OutlineItemJson[];
}

/** `isinstance(x, dict)` for a parsed TOML value. */
function isTable(value: unknown): value is Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function row(fields: Partial<OutlineItem> & Pick<OutlineItem, "kind" | "title">): OutlineItem {
  return { path: "", dueAt: null, points: null, canvasId: "", ...fields };
}

function nativeRow(n: NativeItem): OutlineItem {
  return row({ kind: n.kind, title: n.title || `${n.kind} ${n.ident}`, canvasId: n.ident });
}

function titleOf(file: string): string {
  const [title] = stripTitle(readFileSync(file, "utf8"));
  return title || path.parse(file).name;
}

/**
 * Build the outline.
 *
 * `modules` are the raw `[[module]]` tables, `kinds` maps a repo key to the
 * Canvas kind the push gives it (page, assignment, quiz, ...), and `dates`
 * holds the computed dates of every gradable item. A draft is left out, the
 * same as the push leaves it out of its module. With `term`, a module that
 * declares a week is titled with its dates, as Canvas names it.
 */
export function outline(
  repo: string,
  modules: readonly unknown[],
  kinds: Readonly<Record<string, string>>,
  dates: Readonly<Record<string, ItemDates>>,
  term: Term | null = null,
): OutlineModule[] {
  const out: OutlineModule[] = [];
  for (const module of modules) {
    // A never_publish module is instructor-only; students never see it in
    // Canvas, so the site's copy of the module list leaves it out too.
    if (!isTable(module) || module.never_publish === true) continue;
    const rows: OutlineItem[] = [];
    let entries: ModuleEntry[];
    try {
      entries = moduleEntries(module);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      entries = [];
    }
    for (const line of entries) {
      if (line.header) {
        rows.push(row({ kind: "header", title: line.header }));
        continue;
      }
      if (line.native !== null) {
        rows.push(nativeRow(line.native));
        continue;
      }
      const key = line.key;
      const source = path.join(repo, key);
      if (!isFile(repo, key) || isDraft(readFileSync(source, "utf8"))) continue;
      const item = Object.hasOwn(dates, key) ? dates[key] : undefined;
      rows.push(
        row({
          kind: Object.hasOwn(kinds, key) ? (kinds[key] ?? "page") : "page",
          title: item ? item.title : titleOf(source),
          path: key.endsWith(".md") ? key.slice(0, -3) : key,
          dueAt: item ? isoformat(item.dueAt) : null,
          points: item ? item.points : null,
        }),
      );
    }
    let native: NativeItem[];
    try {
      native = parseNativeItems(module);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      native = [];
    }
    for (const n of native) rows.push(nativeRow(n));
    let title: string;
    if (term !== null) title = moduleTitle(module, term);
    else if (!Object.hasOwn(module, "title")) title = "";
    else title = typeof module.title === "string" ? module.title : pyRepr(module.title);
    out.push({ title, items: rows });
  }
  return out;
}

/** The outline as plain objects, keyed and ordered as the Python version wrote them. */
export function toJson(modules: readonly OutlineModule[]): OutlineModuleJson[] {
  return modules.map((m) => ({
    title: m.title,
    items: m.items.map((i) => ({
      kind: i.kind,
      title: i.title,
      path: i.path,
      due_at: i.dueAt,
      points: i.points,
      canvas_id: i.canvasId,
    })),
  }));
}

/** Python's `repr()` of a float: always a decimal point or an exponent. */
function floatRepr(value: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
    const sign = exponent.startsWith("-") ? "-" : "+";
    return `${mantissa}e${sign}${exponent.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return Number.isInteger(value) ? `${value.toFixed(0)}.0` : String(value);
}

/** A JSON string literal with every non-ASCII character escaped, as Python's ensure_ascii does. */
function jsonString(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function dump(value: unknown, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return floatRepr(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => inner + dump(v, inner)).join(",\n")}\n${indent}]`;
  }
  // Everything toJson builds is a string, number, null, list or plain object, so
  // what is left here is an object.
  const entries = Object.entries(value as Payload);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `${inner}${jsonString(k)}: ${dump(v, inner)}`).join(",\n")}\n${indent}}`;
}

/**
 * `json.dumps(to_json(modules), indent=2)`, byte for byte, which is the file a
 * course website commits. Points are floats in Python, so they carry a ".0"
 * that JSON.stringify would drop, and non-ASCII text is escaped. No trailing
 * newline, as json.dumps writes none.
 */
export function toJsonText(modules: readonly OutlineModule[]): string {
  return dump(toJson(modules), "");
}
