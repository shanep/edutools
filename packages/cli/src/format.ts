/**
 * Human output: tables, panels and the small conversions every command shares.
 * None of this runs under --json, which prints the raw payload instead.
 */

import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Payload } from "@edutools/core/types";
import Table from "cli-table3";
import type { Cli } from "./cli";

export type Align = "left" | "right";

export interface Column {
  readonly name: string;
  readonly align?: Align;
  /** Colours every cell of the column, as a Rich column style did. */
  readonly style?: (text: string) => string;
}

/** Print a table with a title line above it, as Rich's Table(title=...) did. */
export function printTable(
  cli: Cli,
  title: string | null,
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
): void {
  const { c } = cli;
  const names = columns.map((col) => col.name);
  const widths = fitColumns(names, rows, cli.width);
  // Cells are wrapped here, before they are coloured, rather than by cli-table3:
  // its word wrap truncates a word longer than the column, and on a laptop's
  // terminal that word is often the slug or path the reader needs.
  const cell = (text: string, i: number): string => {
    const lines = widths ? wrap(text, (widths[i] ?? 3) - 2) : [text];
    const style = columns[i]?.style;
    return style ? lines.map(style).join("\n") : lines.join("\n");
  };
  // cli-table3 colours through its own library, which decides colour support for
  // itself; switching its styles off leaves every colour to picocolors.
  const table = new Table({
    head: names.map((name, i) => cell(name, i).split("\n").map((line) => c.bold(c.magenta(line))).join("\n")),
    colAligns: columns.map((col) => col.align ?? "left"),
    style: { head: [], border: [] },
    ...(widths && { colWidths: widths }),
  });
  for (const row of rows) table.push(row.map(cell));
  if (title) cli.print(c.bold(title));
  cli.print(table.toString());
}

/**
 * Column widths that fit the table in `width`, or undefined when it already fits
 * or the width is unknown. cli-table3 never shrinks a table on its own, so one
 * long cell (an audit detail, a file path) made every row wider than the
 * terminal and the terminal's own wrapping broke the box apart; Rich used to
 * wrap cells instead. Only the widest columns are capped, all at the same
 * width, so short columns such as ids stay on one line.
 *
 * A column first keeps its longest word whole, so slugs and paths read in one
 * piece. When that still does not fit, as on a laptop, long words are broken
 * instead, and only a table too wide even for its column headers overflows.
 */
function fitColumns(
  head: readonly string[],
  rows: readonly (readonly string[])[],
  width: number | undefined,
): number[] | undefined {
  if (width === undefined) return undefined;
  const all = [head, ...rows];
  const count = Math.max(0, ...all.map((row) => row.length));
  const measure = (i: number, size: (text: string) => number): number =>
    // One space of padding either side of every cell, which colWidths includes.
    Math.max(0, ...all.map((row) => size(row[i] ?? ""))) + 2;
  const natural = Array.from({ length: count }, (_, i) => measure(i, longest(/\n/)));
  const words = Array.from({ length: count }, (_, i) => measure(i, longest(/\s+/)));
  const headers = Array.from({ length: count }, (_, i) => Math.max(longest(/\s+/)(head[i] ?? ""), MIN_COLUMN) + 2);
  // A border to the left of every column, and one closing the right edge.
  const available = width - (count + 1);
  if (natural.reduce((sum, w) => sum + w, 0) <= available) return undefined;
  const fit = (floor: readonly number[]): number[] => {
    const widths = (cap: number): number[] => natural.map((w, i) => Math.min(w, Math.max(cap, floor[i] ?? 0)));
    const total = (cap: number): number => widths(cap).reduce((sum, w) => sum + w, 0);
    let cap = Math.max(...natural);
    while (cap > 1 && total(cap) > available) cap -= 1;
    return widths(cap);
  };
  const whole = fit(words);
  return whole.reduce((sum, w) => sum + w, 0) <= available ? whole : fit(headers);
}

/** The narrowest a column shrinks to, in characters, when words have to break. */
const MIN_COLUMN = 4;

/** The length of the longest piece of `text` split on `separator`. */
function longest(separator: RegExp): (text: string) => number {
  return (text) => Math.max(0, ...text.split(separator).map((piece) => stripVTControlCharacters(piece).length));
}

/**
 * `text` as lines no longer than `width`, broken between words where it can be
 * and inside a word only when that word alone is wider than the column.
 */
function wrap(text: string, width: number): string[] {
  const size = Math.max(1, width);
  // A cell a command coloured itself keeps its colour when it fits; one that has
  // to wrap loses it, since cutting between escape codes would garble the line.
  if (longest(/\n/)(text) <= size) return text.split("\n");
  const lines: string[] = [];
  for (const paragraph of stripVTControlCharacters(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length <= size) {
        line = `${line} ${word}`;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (line.length > size) {
        // Break a path or slug after a separator, when one comes late enough.
        const cut = Math.max(line.lastIndexOf("/", size - 1), line.lastIndexOf("-", size - 1)) + 1;
        const at = cut > size / 2 ? cut : size;
        lines.push(line.slice(0, at));
        line = line.slice(at);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A boxed block of lines with a title, standing in for Rich's Panel. */
export function printPanel(cli: Cli, title: string, lines: readonly string[]): void {
  const table = new Table({
    head: [cli.c.bold(title)],
    style: { head: [], border: [] },
  });
  table.push([lines.join("\n")]);
  cli.print(table.toString());
}

/** `~` and `~/...` expanded, as Python's Path.expanduser() did. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Python's str() of a payload value, for table cells. */
export function str(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The handle you would pass back in: a page's url slug, otherwise its id. */
export function identify(kind: string, stored: Payload): string {
  return str(kind === "page" ? stored.url : stored.id);
}

export function describe(cli: Cli, kind: string, stored: Payload, colour = cli.c): string {
  const title = stored.title || stored.name || stored.display_name || "";
  return `${kind} ${colour.cyan(identify(kind, stored))} ${colour.green(str(title))}`;
}

type Colours = Cli["c"];
const STYLES = ["dim", "bold", "red", "green", "yellow", "cyan", "magenta"] as const;
type Style = (typeof STYLES)[number];
const MARKUP_RE = /\\\[|\[(\/?)([a-z]+)?\]/g;

/**
 * Render the Rich-style markup core's Publisher reports in (`[dim]...[/dim]`),
 * the one place markup crosses from core into the CLI. `\[` is a literal
 * bracket, a closing tag with no name closes the latest, and a tag that is not a
 * known style is left as text.
 */
export function markup(colour: Colours, text: string): string {
  const stack: Style[] = [];
  let out = "";
  let last = 0;
  const paint = (segment: string): string =>
    stack.reduceRight((painted, style) => colour[style](painted), segment);
  for (const match of text.matchAll(MARKUP_RE)) {
    const at = match.index ?? 0;
    const [whole, closing, name] = match;
    const known = name === undefined || (STYLES as readonly string[]).includes(name);
    if (whole !== "\\[" && (!known || (!closing && name === undefined))) continue;
    out += paint(text.slice(last, at));
    last = at + whole.length;
    if (whole === "\\[") out += paint("[");
    else if (closing) stack.pop();
    else if (name !== undefined) stack.push(name as Style); // checked against STYLES just above
  }
  return out + paint(text.slice(last));
}

/** A core progress event as one spinner line: "Publishing a.md (3/40)". */
export function progressLine(progress: { message: string; done?: number; total?: number }): string {
  const count = progress.total !== undefined ? ` (${progress.done ?? 0}/${progress.total})` : "";
  return `${progress.message}${count}`;
}

export function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
