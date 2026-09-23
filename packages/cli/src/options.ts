/**
 * Option parsing and flag-to-field helpers shared by the single-object commands.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { type BuildFieldsOptions, buildFields, FieldError, parseOverrides } from "@edutools/core/objects";
import { InvalidArgumentError } from "commander";
import type { Cli } from "./cli";
import { expandHome } from "./format";
import { RenderError, renderMarkdownBody } from "./render";

export const KIND_HELP = "page, assignment, discussion, quiz, or module";
export const OBJECT_ID_HELP = "Object ID, or the url slug for a page";

/** A repeatable option: every occurrence collected in order. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** click's FLOAT type: a finite decimal, or a usage error. */
export function parseFloatOption(value: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`'${value}' is not a valid float.`);
  }
  return parsed;
}

/** click's INT type: a whole number, or a usage error. */
export function parseIntOption(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new InvalidArgumentError(`'${value}' is not a valid integer.`);
  }
  return Number(trimmed);
}

export function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

/**
 * Resolve --body / --body-file into the title from the source and the html.
 *
 * A .md file goes through the same Canvas-safe pipeline as `push`, and its H1
 * becomes the default title so the two paths agree on what a document is called.
 */
export async function loadBody(
  cli: Cli,
  body: string | undefined,
  bodyFile: string | undefined,
): Promise<{ title: string | null; html: string | null }> {
  if (body !== undefined && bodyFile !== undefined) throw cli.fail("Pass --body or --body-file, not both.");
  if (body !== undefined) return { title: null, html: body };
  if (bodyFile === undefined) return { title: null, html: null };

  const file = expandHome(bodyFile);
  if (!isFile(file)) throw cli.fail(`No such file: ${file}`);
  if (![".md", ".markdown"].includes(path.extname(file).toLowerCase())) {
    return { title: null, html: readFileSync(file, "utf-8") };
  }
  try {
    const rendered = await renderMarkdownBody(file);
    return { title: rendered.title || null, html: rendered.html };
  } catch (error) {
    if (error instanceof RenderError) throw cli.fail(error.message);
    throw error;
  }
}

/** Map flags onto Canvas field names, reporting a bad combination cleanly. */
export function build(cli: Cli, kind: string, options: BuildFieldsOptions): Record<string, string> {
  try {
    return buildFields(kind, options);
  } catch (error) {
    if (error instanceof FieldError) throw cli.fail(error.message);
    throw error;
  }
}

export function overrides(cli: Cli, pairs: readonly string[] | undefined): Record<string, string> {
  try {
    return parseOverrides(pairs);
  } catch (error) {
    if (error instanceof FieldError) throw cli.fail(error.message);
    throw error;
  }
}
