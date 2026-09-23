/**
 * Human output: tables, panels and the small conversions every command shares.
 * None of this runs under --json, which prints the raw payload instead.
 */

import os from "node:os";
import path from "node:path";
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
  // cli-table3 colours through its own library, which decides colour support for
  // itself; switching its styles off leaves every colour to picocolors.
  const table = new Table({
    head: columns.map((col) => c.bold(c.magenta(col.name))),
    colAligns: columns.map((col) => col.align ?? "left"),
    style: { head: [], border: [] },
  });
  for (const row of rows) {
    table.push(row.map((cell, i) => columns[i]?.style?.(cell) ?? cell));
  }
  if (title) cli.print(c.bold(title));
  cli.print(table.toString());
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
  const title = stored.title || stored.name || "";
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
