/**
 * Turn a course repository into Canvas objects.
 *
 * Markdown is rendered to HTML, decorated with stable CSS hooks, styled by
 * inlining a single stylesheet (Canvas strips <style> tags but permits style
 * attributes), and cross-linked using a manifest of what has already been created.
 *
 * Everything here is a pure function except `Manifest`, so the whole pipeline can
 * be exercised without a Canvas token.
 *
 * The Python version rendered with `pandoc --from gfm --to html --wrap=none`. This
 * one renders with markdown-it, configured to emit pandoc's HTML wherever the
 * regexes below look at it (heading ids, table markup and alignment, code block
 * classes, raw HTML passed through verbatim, footnotes, task lists, autolinks), so
 * no external program is needed on any platform.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inline as cssInline } from "@css-inline/css-inline";
import markdownit from "markdown-it";
import type { MarkdownIt, RendererRule, StateCore, Token } from "markdown-it";
import footnotePlugin from "markdown-it-footnote";
import { fnmatch, toPosix } from "./paths";
import type { Payload } from "./types";

// ---------------------------------------------------------------------------
// Canvas's HTML sanitizer allowlist.
//
// Transcribed from canvas-lms, gems/canvas_sanitize/lib/canvas_sanitize/
// canvas_sanitize.rb. Anything outside this set is stripped from a page body
// silently, so we filter locally and report instead of letting it vanish.
// ---------------------------------------------------------------------------

const CSS_BASE: readonly string[] = `
align-content align-items align-self background border border-radius clear clip color
column-gap cursor direction display flex flex-basis flex-direction flex-flow flex-grow
flex-shrink flex-wrap float font gap grid height justify-content justify-items justify-self
left line-height list-style margin max-height max-width min-height min-width order overflow
overflow-x overflow-y padding place-content place-items place-self position right row-gap
text-align table-layout text-decoration text-indent top user-select vertical-align
visibility white-space width z-index zoom
`
  .split(/\s+/)
  .filter((word) => word !== "");

const CSS_EXPANSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["grid-{}", ["area", "auto-columns", "auto-flow", "auto-rows", "column", "gap", "row", "template"]],
  ["grid-template-{}", ["areas", "columns", "rows"]],
  ["grid-column-{}", ["end", "gap", "start"]],
  ["grid-row-{}", ["end", "gap", "start"]],
  ["background-{}", ["attachment", "color", "image", "position", "repeat"]],
  ["background-position-{}", ["x", "y"]],
  ["border-{}", ["bottom", "collapse", "color", "left", "right", "spacing", "style", "top", "width"]],
  ["font-{}", ["family", "size", "stretch", "style", "variant", "width"]],
  ["list-style-{}", ["image", "position", "type"]],
  ["margin-{}", ["bottom", "left", "right", "top", "offset"]],
  ["padding-{}", ["bottom", "left", "right", "top"]],
];

function buildAllowlist(): ReadonlySet<string> {
  const allowed = new Set(CSS_BASE);
  for (const [pattern, parts] of CSS_EXPANSIONS) {
    for (const part of parts) allowed.add(pattern.replace("{}", part));
  }
  for (const side of ["bottom", "left", "right", "top"]) {
    for (const prop of ["color", "style", "width"]) allowed.add(`border-${side}-${prop}`);
  }
  return allowed;
}

export const CANVAS_CSS_PROPERTIES: ReadonlySet<string> = buildAllowlist();

// Canvas keeps class/id/style on every element but drops these entirely.
export const CANVAS_FORBIDDEN_TAGS: ReadonlySet<string> = new Set(["style", "link", "script"]);

export const INSTRUCTOR_MARKER = "Instructor note, not shown to students";

// ## heading text -> the class decorate() attaches to that section.
export const SECTION_CLASSES: Readonly<Record<string, string>> = {
  overview: "cs-overview",
  "objectives this week": "cs-objectives",
  "objectives assessed": "cs-objectives",
  read: "cs-read",
  "worked example": "cs-worked",
  "do this week": "cs-dothis",
  "key terms": "cs-terms",
  "time estimate": "cs-time",
  "looking ahead": "cs-ahead",
  goal: "cs-goal",
  "before you start": "cs-before",
  steps: "cs-steps",
  "what to submit": "cs-submit",
  rubric: "cs-rubric",
  "ai disclosure": "cs-ai",
  "initial post": "cs-steps",
  post: "cs-steps",
  replies: "cs-steps",
  reply: "cs-steps",
  "ground rules": "cs-ai",
  "the case": "cs-worked",
};

/** Raised when a repository cannot be turned into Canvas content. */
export class PublishError extends Error {
  override name = "PublishError";
}

/**
 * Python's ValueError, for a malformed [[module]] table in canvas.toml. Kept as its
 * own class so the publisher can report a bad table and carry on, while any other
 * error still stops the push.
 */
export class ValueError extends Error {
  override name = "ValueError";
}

// ---------------------------------------------------------------------------
// Small pieces of Python semantics the regexes below depend on
// ---------------------------------------------------------------------------

/** `str.splitlines()`: every line boundary Python knows, no trailing empty line. */
function splitlines(text: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Python's splitlines also breaks on the file, group and record separators.
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `str.strip(chars)`: remove any of `chars` from both ends. */
function stripChars(text: string, chars: string): string {
  const set = escapeRegExp(chars);
  return text.replace(new RegExp(`^[${set}]+|[${set}]+$`, "g"), "");
}

/** `repr()` of the values a canvas.toml or a frontmatter line can hold. */
function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isTable(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

/** Python truthiness, where an empty list or table is false as well. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isTable(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `isinstance(x, dict)` for parsed TOML: a plain table, not a date or a list. */
function isTable(value: unknown): value is Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Python's `float()` of a string: decimal or exponent notation, or inf and nan. */
function parseFloatStrict(text: string): number | null {
  const s = text.trim().replace(/(\d)_(?=\d)/g, "$1");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?(?:inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return Number.NaN;
  return null;
}

/** Python's `f"{x:g}"`: six significant digits, trailing zeros dropped. */
export function formatG(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value < 0 ? "-inf" : "inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa = "0", exponentText = "0"] = value.toExponential(5).split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 6) {
    const digits = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
    const sign = exponent < 0 ? "-" : "+";
    return `${digits}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const fixed = value.toFixed(Math.max(0, 5 - exponent));
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Drop any '## ...' section whose body carries the instructor-only marker. */
export function stripInstructorSections(markdown: string): string {
  const blocks = markdown.split(/^(?=## )/m);
  return blocks.filter((b) => !b.includes(INSTRUCTOR_MARKER)).join("");
}

/** Split the leading '# Title' off; Canvas shows the title separately. */
export function stripTitle(markdown: string): [string, string] {
  const lines = splitlines(markdown);
  let title = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      lines.splice(index, 1);
      break;
    }
  }
  return [title, lines.join("\n").replace(/^\n+/, "")];
}

// ---------------------------------------------------------------------------
// VitePress: the same markdown is a website and a Canvas object
// ---------------------------------------------------------------------------

// "---\nnext: false\n---\n" at the very top of the file.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

// "draft: true" as a top level key of that frontmatter. Parsed with a regex rather
// than a YAML library because this is the only key edutools reads out of the block
// and the block is otherwise VitePress's business.
const DRAFT_RE = /^draft[ \t]*:[ \t]*(?<value>true|yes|on)[ \t]*$/im;

/**
 * Whether a course file is marked `draft: true` in its frontmatter.
 *
 * A draft is work in progress that is not a Canvas object at all: it is not
 * pushed, it takes no due date, it is left out of its module and it is not
 * verified. The website hides it too, so a draft is invisible everywhere until
 * the flag comes off.
 */
export function isDraft(markdown: string): boolean {
  const block = FRONTMATTER_RE.exec(markdown);
  return block !== null && DRAFT_RE.test(block[0]);
}

// "submission: online_upload, online_text_entry" and "grading: pass_fail", also
// top level keys of the frontmatter, for the two assignment fields that vary from
// one assignment to the next. Everything else about an assignment comes from the
// meta line and canvas.toml.
const SUBMISSION_RE = /^submission[ \t]*:[ \t]*(?<value>[^\n]+?)[ \t]*$/im;
const GRADING_RE = /^grading[ \t]*:[ \t]*(?<value>[^\n]+?)[ \t]*$/im;

export const SUBMISSION_TYPES: readonly string[] = [
  "online_text_entry",
  "online_upload",
  "online_url",
  "media_recording",
  "student_annotation",
  "on_paper",
  "external_tool",
  "none",
];
export const GRADING_TYPES: readonly string[] = [
  "points",
  "pass_fail",
  "percent",
  "letter_grade",
  "gpa_scale",
  "not_graded",
];

/** The per-assignment Canvas fields a course file may set in its frontmatter. */
export interface AssignmentOptions {
  readonly submissionTypes: readonly string[];
  readonly gradingType: string | null;
}

/**
 * Read `submission:` and `grading:` out of a file's frontmatter.
 *
 * `submission` takes one or more Canvas submission types, separated by
 * commas or spaces, with or without YAML brackets; `grading` takes one
 * grading type. A value Canvas would reject is reported here, where the file
 * name is known, rather than as a 400 from the push.
 */
export function assignmentOptions(markdown: string): AssignmentOptions {
  const block = FRONTMATTER_RE.exec(markdown);
  let options: AssignmentOptions = { submissionTypes: ["online_text_entry"], gradingType: null };
  if (block === null) return options;
  const text = block[0];

  const submission = SUBMISSION_RE.exec(text);
  if (submission) {
    const value = submission.groups?.value ?? "";
    const raw = stripChars(value, "[]");
    const types = raw
      .split(/[,\s]+/)
      .filter((t) => t.trim() !== "")
      .map((t) => stripChars(t.trim(), "'\""));
    const bad = types.filter((t) => !SUBMISSION_TYPES.includes(t));
    if (bad.length > 0 || types.length === 0) {
      throw new PublishError(
        `submission: ${pyRepr(value)} is not a Canvas submission type; ` +
          `use one or more of ${SUBMISSION_TYPES.join(", ")}`,
      );
    }
    options = { submissionTypes: types, gradingType: options.gradingType };
  }

  const grading = GRADING_RE.exec(text);
  if (grading) {
    const value = stripChars(grading.groups?.value ?? "", "'\"");
    if (!GRADING_TYPES.includes(value)) {
      throw new PublishError(
        `grading: ${pyRepr(value)} is not a Canvas grading type; use one of ${GRADING_TYPES.join(", ")}`,
      );
    }
    options = { submissionTypes: options.submissionTypes, gradingType: value };
  }

  return options;
}

/**
 * `isDraft` for a file, treating anything unreadable as not a draft.
 *
 * A file that is not UTF-8 text, such as a PDF matched by `layout.files`,
 * has no front matter to read and is never a draft.
 */
export function pathIsDraft(file: string): boolean {
  try {
    return isDraft(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file)));
  } catch {
    return false;
  }
}

// "<!--@include: ../../parts/syllabus-boiler.md-->"
const INCLUDE_RE = /^[ \t]*<!--\s*@include:\s*(\S+?)\s*-->[ \t]*$/gm;

// "::: danger", "::: warning Custom Title", "::: tip", closed by a bare ":::".
const CONTAINER_RE =
  /^:::+[ \t]*(?<kind>[a-z-]+)[ \t]*(?<title>[^\n]*)\n(?<body>[\s\S]*?)^:::+[ \t]*$/gm;

// "<OfficeHoursLink />" or "<CourseSchedule :weeks="x" />": a capitalised tag is a
// Vue component, which means nothing outside the website.
const COMPONENT_RE = /<(?<tag>[A-Z]\w*)\b[^>]*?\/?>(?:<\/\k<tag>>)?/g;

// "<script setup> ... </script>" blocks that feed those components.
const SCRIPT_RE = /^<script\b[^>]*>[\s\S]*?<\/script>[ \t]*$/gm;

// The title Canvas should show for each container kind when the author gave none.
const CONTAINER_TITLES: Readonly<Record<string, string>> = {
  danger: "Warning",
  warning: "Caution",
  info: "Note",
  tip: "Tip",
  details: "Details",
};

const MAX_INCLUDE_DEPTH = 5;

/** Python's `str.title()`, for a container kind with no default title. */
function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, before: string, c: string) => before + c.toUpperCase());
}

/**
 * Resolve the VitePress-only syntax the renderer would otherwise pass through.
 *
 * A course directory is served as a website *and* pushed to Canvas, so the same
 * file carries VitePress constructs that mean nothing to a markdown renderer. Left
 * alone they reach Canvas as literal text: a reader sees `::: danger` and an
 * unrendered `<!--@include:-->` comment. Each one is resolved into plain markdown
 * here.
 */
export function stripVitepress(markdown: string, source: string, repo: string | null = null, depth = 0): string {
  let text = markdown.replace(FRONTMATTER_RE, "");
  text = text.replace(SCRIPT_RE, "");

  // Includes are resolved relative to the file that names them, and recursively,
  // since a boilerplate part may include another.
  text = text.replace(INCLUDE_RE, (_match: string, target: string) => {
    if (depth >= MAX_INCLUDE_DEPTH) {
      throw new PublishError(`${path.basename(source)}: @include nested more than ${MAX_INCLUDE_DEPTH} deep`);
    }
    const resolved = path.resolve(path.dirname(source), target);
    if (!existsSync(resolved)) {
      throw new PublishError(`${path.basename(source)}: @include target ${target} does not exist`);
    }
    return stripVitepress(readFileSync(resolved, "utf8"), resolved, repo, depth + 1);
  });

  // A container becomes a blockquote with a bold lead line. Canvas keeps both, so
  // the callout still reads as a callout without needing any custom CSS, and the
  // body has to be quoted line by line or the quote ends at the first blank line.
  const container = (...args: unknown[]): string => {
    // The named groups object is the last argument a replace callback receives.
    const groups = args[args.length - 1] as Record<string, string>;
    const kind = groups.kind ?? "";
    const title = (groups.title ?? "").trim() || (CONTAINER_TITLES[kind] ?? titleCase(kind));
    const body = stripChars(groups.body ?? "", "\n");
    const quoted = splitlines(body)
      .map((line) => `> ${line}`.trimEnd())
      .join("\n");
    // The marker is an HTML comment, which the renderer passes through untouched
    // and decorate() turns into a class. Without it every severity renders as the
    // same blockquote, so a "this fails the project" warning reads like an aside.
    //
    // It has to trail the title, never lead it: a comment at the start of a line
    // opens a CommonMark HTML *block*, which swallows the rest of that line and
    // emits "**Warning**" as literal text instead of bold.
    return `> **${title}**<!--cs-callout:${kind}-->\n>\n${quoted}\n`;
  };

  // Innermost first, so a container nested inside another is resolved before the
  // outer one quotes it.
  for (;;) {
    let count = 0;
    text = text.replace(CONTAINER_RE, (...args: unknown[]) => {
      count += 1;
      return container(...args);
    });
    if (count === 0) break;
  }

  return text.replace(COMPONENT_RE, "");
}

// ---------------------------------------------------------------------------
// The markdown renderer: GitHub flavoured markdown, emitted the way pandoc does
// ---------------------------------------------------------------------------

/** Escape text content as pandoc does: quotes stay literal outside attributes. */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an attribute value, or the body of a code block, as pandoc does. */
function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The plain text of a heading, as pandoc's `stringify` sees it. */
function stringify(tokens: readonly Token[]): string {
  let out = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") out += token.content;
    else if (token.type === "softbreak" || token.type === "hardbreak") out += " ";
    else if (token.type === "image") out += stringify(token.children ?? []);
  }
  return out;
}

/**
 * pandoc's `gfm_auto_identifiers`: lower case, each space a hyphen, and every
 * character that is not a letter, a digit, `_`, `-` or a combining mark dropped.
 */
function headingIdentifier(text: string): string {
  return Array.from(text.toLowerCase().replace(/\s/gu, "-"))
    .filter((c) => /[\p{L}\p{N}_\-\p{Mn}\p{Mc}\p{Me}\p{Pc}]/u.test(c))
    .join("");
}

/**
 * Give every heading pandoc's id. A repeat gets `-1`, `-2` and so on, and an
 * empty id counts as used, which is why pandoc names a heading of pure
 * punctuation that follows an empty one `-1`.
 */
function headingIds(state: StateCore): void {
  const used = new Set<string>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.type !== "heading_open") continue;
    const base = headingIdentifier(stringify(tokens[i + 1]?.children ?? []));
    let ident = base;
    for (let n = 1; used.has(ident); n++) ident = `${base}-${n}`;
    used.add(ident);
    if (ident !== "") token.attrSet("id", ident);
  }
}

/**
 * pandoc leaves out a table header whose cells are all empty, as in the
 * `| | |` header of a two column time estimate. Keeping it would add an empty
 * styled header row above the table in Canvas.
 */
function emptyTableHeads(state: StateCore): void {
  const tokens = state.tokens;
  for (let open = 0; open < tokens.length; open++) {
    if ((tokens[open] as Token).type !== "thead_open") continue;
    let close = open;
    while (close < tokens.length && (tokens[close] as Token).type !== "thead_close") close++;
    const cells = tokens.slice(open, close + 1);
    if (cells.every((t) => t.type !== "inline" || t.content.trim() === "")) {
      tokens.splice(open, close - open + 1);
      open--;
    }
  }
}

const TASK_RE = /^\[([ xX])\](?=[ \t]|$)[ \t]?/;

/**
 * GFM task lists in pandoc's shape: `<ul class="task-list">` holding
 * `<li><label><input type="checkbox" />text</label></li>`. Only bullet lists
 * carry tasks, as in pandoc, and pandoc splits a list that mixes task items
 * with plain ones into consecutive lists of one sort each.
 */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  // Lists already handled, including the ones a split creates, whose items have
  // lost their [ ] marker and would otherwise be taken for plain items.
  const done = new WeakSet<Token>();
  for (let open = 0; open < tokens.length; open++) {
    const list = tokens[open] as Token;
    if (list.type !== "bullet_list_open" || done.has(list)) continue;
    done.add(list);

    // The list's own items (not a nested list's), and whether each is a task.
    const items: Array<{ index: number; task: boolean }> = [];
    let depth = 0;
    for (let i = open + 1; i < tokens.length; i++) {
      const token = tokens[i] as Token;
      if (token.type === "bullet_list_open" || token.type === "ordered_list_open") depth++;
      if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
        if (depth === 0) break;
        depth--;
      }
      if (depth !== 0 || token.type !== "list_item_open") continue;
      // The item's first block has to be a paragraph whose text opens with [ ].
      const para = tokens[i + 1];
      const inline = tokens[i + 2];
      const first = inline?.children?.[0];
      const marker = first?.type === "text" ? TASK_RE.exec(first.content) : null;
      if (para?.type !== "paragraph_open" || !inline || !first || !marker) {
        items.push({ index: i, task: false });
        continue;
      }
      items.push({ index: i, task: true });
      first.content = first.content.slice(marker[0].length);
      const checked = marker[1] === " " ? "" : ' checked=""';
      const label = new state.Token("html_inline", "", 0);
      label.content = `<label><input type="checkbox"${checked} />`;
      const close = new state.Token("html_inline", "", 0);
      close.content = "</label>";
      inline.children = [label, ...(inline.children ?? []), close];
    }
    if (items[0]?.task) list.attrJoin("class", "task-list");

    // Split where an item's sort differs from the one before it, last first so
    // the earlier indexes stay valid.
    for (let n = items.length - 1; n > 0; n--) {
      const item = items[n] as { index: number; task: boolean };
      if (item.task === (items[n - 1] as { task: boolean }).task) continue;
      const closing = new state.Token("bullet_list_close", "ul", -1);
      const opening = new state.Token("bullet_list_open", "ul", 1);
      for (const token of [closing, opening]) {
        token.block = true;
        token.level = list.level;
        token.markup = list.markup;
      }
      if (item.task) opening.attrJoin("class", "task-list");
      done.add(opening);
      tokens.splice(item.index, 0, closing, opening);
    }
  }
}

/**
 * GFM's extended autolinks: a bare `http://`, `https://` or `www.` URL, or an
 * email address. linkify-it on its own also links a bare `example.com`, which
 * neither GitHub nor pandoc does.
 */
type LinkMatch = NonNullable<ReturnType<MarkdownIt["linkify"]["match"]>>[number];

function gfmAutolinks(md: MarkdownIt): void {
  const linkify = md.linkify;
  linkify.set({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: false });
  const match = linkify.match.bind(linkify);
  const gfm = (text: string) =>
    (match(text) ?? []).filter(
      (m: LinkMatch) => m.schema === "http:" || m.schema === "https:" || m.schema === "mailto:" || /^www\./i.test(m.raw),
    );
  linkify.match = (text: string) => {
    const found = gfm(text);
    return found.length > 0 ? found : null;
  };
  linkify.test = (text: string) => gfm(text).length > 0;
}

/** A token attribute as a string; markdown-it types them loosely as string or number. */
function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null ? null : String(value);
}

/** An attribute list in pandoc's order and escaping. */
function attrs(pairs: ReadonlyArray<readonly [string, string | null | undefined]>): string {
  return pairs
    .filter((pair): pair is readonly [string, string] => pair[1] !== null && pair[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
}

const CELL_ALIGN = /^text-align:(left|center|right)$/;

/** `text-align:left` from markdown-it becomes pandoc's `text-align: left;`. */
const cellOpen: RendererRule = (tokens, idx, _options, _env, self) => {
  const token = tokens[idx] as Token;
  const style = attr(token, "style");
  const align = style === null ? null : CELL_ALIGN.exec(style);
  if (align) token.attrSet("style", `text-align: ${align[1]};`);
  return `<${token.tag}${self.renderAttrs(token)}>`;
};

/** A fenced or indented code block: `<pre class="lang"><code>`, no final newline. */
const codeBlock: RendererRule = (tokens, idx) => {
  const token = tokens[idx] as Token;
  const lang = token.info.trim().split(/\s+/)[0] ?? "";
  const body = escapeAttr(token.content.replace(/\n$/, ""));
  return `<pre${lang ? attrs([["class", lang]]) : ""}><code>${body}</code></pre>\n`;
};

function buildRenderer(): MarkdownIt {
  const md = markdownit({ html: true, xhtmlOut: true, linkify: true, typographer: false, breaks: false });
  md.use(footnotePlugin);
  gfmAutolinks(md);

  // pandoc writes a link target exactly as it was written: no percent-encoding of
  // spaces or accented letters, and no refusing a scheme. rewrite_links matches
  // targets against repo paths, so an encoded "caf%C3%A9.md" would not resolve.
  md.normalizeLink = (url: string) => url;
  md.normalizeLinkText = (text: string) => text;
  md.validateLink = () => true;

  md.core.ruler.push("pandoc_heading_ids", headingIds);
  md.core.ruler.push("pandoc_task_lists", taskLists);
  md.core.ruler.push("pandoc_empty_table_heads", emptyTableHeads);

  // Every attribute, including the ids and styles set above, in pandoc's escaping.
  md.renderer.renderAttrs = (token) => attrs((token.attrs ?? []).map(([name, value]) => [name, String(value)] as const));
  const rules = md.renderer.rules;
  rules.text = (tokens, idx) => escapeText((tokens[idx] as Token).content);
  rules.code_inline = (tokens, idx) => `<code>${escapeText((tokens[idx] as Token).content)}</code>`;
  // --wrap=none: a soft line break inside a paragraph is written as a space.
  rules.softbreak = () => " ";
  // A raw HTML block goes through verbatim, followed by a blank line as pandoc
  // writes it.
  rules.html_block = (tokens, idx) => `${(tokens[idx] as Token).content}\n`;
  rules.fence = codeBlock;
  rules.code_block = codeBlock;
  rules.th_open = cellOpen;
  rules.td_open = cellOpen;
  rules.s_open = () => "<del>";
  rules.s_close = () => "</del>";
  rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx] as Token;
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    return `<img${attrs([
      ["src", attr(token, "src")],
      ["title", attr(token, "title")],
      ["alt", alt],
    ])} />`;
  };
  rules.ordered_list_open = (tokens, idx) => {
    const start = attr(tokens[idx] as Token, "start");
    return `<ol${attrs([
      ["start", start],
      ["type", "1"],
    ])}>\n`;
  };
  // pandoc opens a list item's content on the same line as <li>.
  rules.list_item_open = (tokens, idx, _options, _env, self) => `<li${self.renderAttrs(tokens[idx] as Token)}>`;

  // Footnotes in pandoc's markup: a numbered superscript link, and an endnotes
  // section with a back link after the note's last paragraph.
  const number = (token: Token): string => String(Number((token.meta as { id: number }).id) + 1);
  // pandoc repeats a note referenced twice under a new number. Here a repeat
  // links to the one note instead, without a second copy of its id.
  const repeat = (token: Token): boolean => Number((token.meta as { subId: number }).subId) > 0;
  rules.footnote_ref = (tokens, idx) => {
    const token = tokens[idx] as Token;
    const n = number(token);
    const id = repeat(token) ? "" : ` id="fnref${n}"`;
    return `<a href="#fn${n}" class="footnote-ref"${id} role="doc-noteref"><sup>${n}</sup></a>`;
  };
  rules.footnote_block_open = () =>
    '<section id="footnotes" class="footnotes footnotes-end-of-document" role="doc-endnotes">\n<hr />\n<ol>\n';
  rules.footnote_block_close = () => "</ol>\n</section>\n";
  rules.footnote_open = (tokens, idx) => `<li id="fn${number(tokens[idx] as Token)}">`;
  rules.footnote_close = () => "</li>\n";
  rules.footnote_anchor = (tokens, idx) => {
    const token = tokens[idx] as Token;
    if (repeat(token)) return "";
    return `<a href="#fnref${number(token)}" class="footnote-back" role="doc-backlink">\u21a9\ufe0e</a>`;
  };
  return md;
}

let renderer: MarkdownIt | null = null;

/**
 * GitHub flavoured markdown to HTML, in the shape `pandoc --from gfm --to html
 * --wrap=none` produced, which every regex after it was written against.
 */
export function renderGfm(markdown: string): string {
  renderer ??= buildRenderer();
  // pandoc closes a list item on the line its last block ends.
  return renderer.render(markdown).replace(/\n<\/li>/g, "</li>");
}

/** Render one course file to [title, html]. */
export function renderMarkdown(file: string, repo: string | null = null): [string, string] {
  let source = stripVitepress(readFileSync(file, "utf8"), file, repo);
  source = stripInstructorSections(source);
  const [title, body] = stripTitle(source);
  return [title || path.parse(file).name, renderGfm(body)];
}

// ---------------------------------------------------------------------------
// Decoration: give the stylesheet stable hooks
// ---------------------------------------------------------------------------

const H2_RE = /<h2\b[^>]*>(?<text>[\s\S]*?)<\/h2>/g;
const TAG_RE = /<[^>]+>/g;

function plain(html: string): string {
  return html.replace(TAG_RE, "").replace(/\s+/g, " ").trim();
}

const CALLOUT_RE = /<blockquote>(?<body>[\s\S]*?)<\/blockquote>/g;
const MARKER_RE = /<!--cs-callout:([a-z-]+)-->/;
const MARKER_ALL_RE = /<!--cs-callout:([a-z-]+)-->/g;

/** Turn the marker stripVitepress left inside a blockquote into a class. */
export function classifyCallouts(html: string): string {
  return html.replace(CALLOUT_RE, (whole: string, body: string) => {
    const marker = MARKER_RE.exec(body);
    if (marker === null) return whole;
    const kind = marker[1];
    return `<blockquote class="cs-callout cs-${kind}">${body.replace(MARKER_ALL_RE, "")}</blockquote>`;
  });
}

/**
 * Wrap each h2 section in a classed <div> and mark the header line.
 *
 * Canvas allows class attributes, and inlining resolves them into style
 * attributes at publish time, so these hooks work either way.
 */
export function decorate(html: string): string {
  let out = classifyCallouts(html);
  // The bold meta line: "**Week 7 · 38 points · ...**" renders as a lone <p><strong>.
  out = out.replace(
    /^(\s*)<p><strong>((?:Week|Finals week|January|February|March|April|May)[^<]*)<\/strong><\/p>/,
    '$1<p class="cs-meta"><strong>$2</strong></p>',
  );

  const matches = [...out.matchAll(H2_RE)];
  const first = matches[0];
  if (first === undefined) return out;

  const pieces: string[] = [out.slice(0, first.index)];
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.index ?? out.length;
    const heading = plain(match.groups?.text ?? "").toLowerCase();
    const cssClass = SECTION_CLASSES[heading] ?? "cs-section";
    pieces.push(`<div class="${cssClass}">${out.slice(match.index, end)}</div>`);
  });
  return pieces.join("");
}

/** Tag alternate body rows, since Canvas cannot express :nth-child. */
export function markTableRows(html: string): string {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (table: string) => {
    let count = 0;
    return table.replace(/<tr>([\s\S]*?)<\/tr>/g, (opening: string, inner: string) => {
      if (inner.includes("<th")) return opening;
      count += 1;
      const css = count % 2 ? "cs-row-odd" : "cs-row-even";
      return opening.replace("<tr>", `<tr class="${css}">`);
    });
  });
}

/** Let wide tables scroll rather than pushing the page sideways. */
export function wrapTables(html: string): string {
  return html.replace(/(<table\b)/g, '<div class="cs-scroll">$1').replaceAll("</table>", "</table></div>");
}

const SECTION_HEADING_RE = /<(?<tag>h[23])\b(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/\k<tag>>/g;

/**
 * Put an icon image in front of each h2 and h3 whose text matches a pattern.
 *
 * `icons` is (lower case fnmatch pattern, repo-relative image path), first match
 * wins. Canvas keeps <img> but not CSS generated content, so a heading icon has
 * to be real markup. The src is written relative to `source`, exactly as a
 * hand-written image link would be, so rewriteLinks turns it into the uploaded
 * course file and the icon follows the course through a copy.
 */
export function addHeadingIcons(
  html: string,
  icons: ReadonlyArray<readonly [string, string]>,
  source: string,
  repo: string,
): string {
  if (icons.length === 0) return html;

  return html.replace(SECTION_HEADING_RE, (...args: unknown[]) => {
    // The named groups object is the last argument a replace callback receives.
    const groups = args[args.length - 1] as Record<string, string>;
    const whole = args[0] as string;
    const tag = groups.tag ?? "";
    const attributes = groups.attrs ?? "";
    const body = groups.body ?? "";
    const text = plain(body).toLowerCase();
    for (const [pattern, icon] of icons) {
      if (!fnmatch(text, pattern)) continue;
      const target = toPosix(path.relative(path.resolve(path.dirname(source)), path.join(path.resolve(repo), icon)));
      const image = `<img class="cs-icon" src="${target}" alt="" role="presentation" width="45" height="35">`;
      return `<${tag}${attributes}>${image}${body}</${tag}>`;
    }
    return whole;
  });
}

// ---------------------------------------------------------------------------
// Styling: one authored stylesheet, inlined into style attributes
// ---------------------------------------------------------------------------

const STYLE_ATTR_RE = /style="([^"]*)"/g;
const BODY_RE = /<body[^>]*>([\s\S]*)<\/body>/;

/** Keep only declarations Canvas will store; return what was dropped. */
function filterDeclarations(style: string): [string, string[]] {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const declaration of style.split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    const name = colon === -1 ? declaration : declaration.slice(0, colon);
    const value = colon === -1 ? "" : declaration.slice(colon + 1);
    const prop = name.trim().toLowerCase();
    if (!value.trim()) continue;
    if (CANVAS_CSS_PROPERTIES.has(prop)) kept.push(`${prop}: ${value.trim()}`);
    else dropped.push(prop);
  }
  return [kept.join("; "), dropped];
}

/**
 * Inline `css` into style attributes and drop anything Canvas would strip.
 *
 * Canvas removes <style> elements from page bodies but keeps style attributes,
 * so this is the only way a stylesheet can survive. Returns the styled HTML
 * and a sorted list of CSS properties that had to be discarded.
 */
export function inlineCss(html: string, css: string): [string, string[]] {
  const document = `<style>${css}</style>${html}`;
  let inlined = cssInline(document, { keepStyleTags: false });

  const body = BODY_RE.exec(inlined);
  if (body) inlined = body[1] ?? "";

  const dropped = new Set<string>();
  inlined = inlined.replace(STYLE_ATTR_RE, (_whole: string, style: string) => {
    const [kept, lost] = filterDeclarations(style);
    for (const prop of lost) dropped.add(prop);
    return kept ? `style="${kept}"` : "";
  });
  return [inlined, [...dropped].sort()];
}

/** Report tags Canvas would strip outright. */
export function assertNoForbiddenTags(html: string): string[] {
  return [...CANVAS_FORBIDDEN_TAGS].filter((tag) => new RegExp(`<${tag}\\b`, "i").test(html)).sort();
}

// ---------------------------------------------------------------------------
// Quiz parsing
// ---------------------------------------------------------------------------

export type QuestionType = "multiple_choice_question" | "multiple_answers_question" | "true_false_question";

const QUESTION_RE = /^\*\*Q(\d+)\.\*\*\s*([\s\S]*)/m;
// The same pattern anchored at the start of the string, for Python's re.match.
const QUESTION_AT_START_RE = /^\*\*Q(\d+)\.\*\*\s*([\s\S]*)/;
const OPTION_RE = /^- ([A-E])\.\s+(.*)$/gm;
const ANSWER_RE = /^\*Answer:\*\s*\*\*([^*]+)\*\*\s*(?:\u2014|--)?\s*([\s\S]*)/m;
const OBJECTIVE_RE = /\s*\*\(Objective\s+([\d.]+)\)\*/;
const OBJECTIVE_ALL_RE = /\s*\*\(Objective\s+([\d.]+)\)\*/g;
const NOTE_RE = /Items ([\d,\s and]+) are multiple-answer/;

export interface Answer {
  readonly text: string;
  readonly correct: boolean;
}

export class Question {
  readonly number: number;
  readonly stem: string;
  readonly objective: string | null;
  readonly kind: QuestionType;
  readonly answers: readonly Answer[];
  readonly rationale: string;

  constructor(fields: {
    number: number;
    stem: string;
    objective: string | null;
    kind: QuestionType;
    answers: readonly Answer[];
    rationale: string;
  }) {
    this.number = fields.number;
    this.stem = fields.stem;
    this.objective = fields.objective;
    this.kind = fields.kind;
    this.answers = fields.answers;
    this.rationale = fields.rationale;
  }

  get correctLetters(): string[] {
    const letters = "ABCDE";
    return this.answers.flatMap((a, i) => (a.correct ? [letters[i] as string] : []));
  }
}

/**
 * Parse a quiz bank into Canvas questions.
 *
 * The question *type* is taken from the stem, never from the number of correct
 * answers: a "Select all that apply" item whose answer happens to be a single
 * option is still a multiple-answers question.
 */
export function parseQuiz(file: string): Question[] {
  const name = path.basename(file);
  const text = readFileSync(file, "utf8");
  const note = NOTE_RE.exec(text);
  const declaredMulti = new Set<number>(note ? [...(note[1] ?? "").matchAll(/\d+/g)].map((m) => Number(m[0])) : []);

  const questions: Question[] = [];
  for (const raw of text.split(/^---$/m)) {
    const found = QUESTION_RE.exec(raw);
    if (!found) continue;
    // A block may carry a preamble (a title, a table) before the question.
    const block = raw.slice(found.index).trim();
    const match = QUESTION_AT_START_RE.exec(block);
    if (!match) continue;
    const number = Number(match[1]);

    const options = [...block.matchAll(OPTION_RE)].map((m) => [m[1] ?? "", m[2] ?? ""] as const);
    if (options.length === 0) {
      throw new PublishError(`${name} Q${number}: no lettered options found`);
    }

    const answer = ANSWER_RE.exec(block);
    if (!answer) {
      throw new PublishError(`${name} Q${number}: no '*Answer:*' line found`);
    }
    const answerLetters = answer[1] ?? "";
    const correct = new Set([...answerLetters.matchAll(/\b([A-E])\b/g)].map((m) => m[1]));
    if (correct.size === 0) {
      throw new PublishError(`${name} Q${number}: cannot read answer ${pyRepr(answerLetters)}`);
    }

    let stemRaw = block.includes("\n- ") ? block.slice(0, block.indexOf("\n- ")) : (match[2] ?? "");
    stemRaw = stemRaw.replace(`**Q${number}.**`, "").trim();
    const objectiveMatch = OBJECTIVE_RE.exec(stemRaw);
    const objective = objectiveMatch ? (objectiveMatch[1] ?? null) : null;
    const stem = stemRaw.replace(OBJECTIVE_ALL_RE, "").trim();

    const letters = options.map(([letter]) => letter);
    let kind: QuestionType;
    if (
      letters.join() === "A,B" &&
      options.map(([, t]) => t.trim().toLowerCase()).join("\u0000") === "true\u0000false"
    ) {
      kind = "true_false_question";
    } else if (/Select \*\*all\*\*/i.test(stem)) {
      kind = "multiple_answers_question";
    } else {
      kind = "multiple_choice_question";
    }

    // Cross-check the stem-derived type against the instructor note.
    if (declaredMulti.size > 0) {
      const declared = declaredMulti.has(number);
      const derived = kind === "multiple_answers_question";
      if (declared !== derived) {
        throw new PublishError(
          `${name} Q${number}: instructor note says ` +
            `${declared ? "multiple-answer" : "single-answer"} but the stem reads ` +
            `${derived ? "multiple-answer" : "single-answer"}`,
        );
      }
    }

    questions.push(
      new Question({
        number,
        stem,
        objective,
        kind,
        answers: options.map(([letter, t]) => ({ text: t.trim(), correct: correct.has(letter) })),
        rationale: (answer[2] ?? "").replace(/\s+/g, " ").trim(),
      }),
    );
  }

  questions.sort((a, b) => a.number - b.number);
  return questions;
}

// Emphasis, code spans and links: the markdown a quiz answer can actually carry.
const MARKDOWN_RE = /\*\*|`|\[[^\]]*\]\(/;

/**
 * Render one markdown fragment to HTML.
 *
 * Quiz stems and rationales reach Canvas as HTML, so a stem written "Select
 * **all** that apply" has to be rendered or the reader sees the asterisks, and
 * the emphasis that marks a multiple-answer question is lost.
 */
export function renderInline(markdown: string): string {
  if (!markdown.trim()) return "";
  return renderGfm(markdown).trim();
}

/** Canvas form fields for one quiz question. */
export function questionFields(question: Question, position: number): Array<[string, string]> {
  let name = `Q${question.number}`;
  if (question.objective) name += ` (Objective ${question.objective})`;
  const fields: Array<[string, string]> = [
    ["question[question_name]", name],
    ["question[question_text]", renderInline(question.stem)],
    ["question[question_type]", question.kind],
    ["question[points_possible]", "2"],
    ["question[position]", String(position)],
    ["question[neutral_comments_html]", renderInline(question.rationale)],
  ];
  for (const answer of question.answers) {
    if (MARKDOWN_RE.test(answer.text)) {
      fields.push(["question[answers][][answer_html]", renderInline(answer.text)]);
    } else {
      fields.push(["question[answers][][answer_text]", answer.text]);
    }
    fields.push(["question[answers][][answer_weight]", answer.correct ? "100" : "0"]);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Rubric parsing
// ---------------------------------------------------------------------------

export interface Criterion {
  readonly description: string;
  readonly points: number;
}

/** Read the '## Rubric' table. Rows are '| n | description | points |'. */
export function parseRubric(markdown: string): Criterion[] {
  const section = /^## Rubric\s*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m.exec(markdown);
  if (!section) return [];
  const criteria: Criterion[] = [];
  for (const line of splitlines(section[1] ?? "")) {
    const cells = stripChars(line.trim(), "|")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 3 || !/^\d+$/.test(cells[0] ?? "")) continue;
    const points = parseFloatStrict(stripChars(cells[cells.length - 1] ?? "", "*"));
    if (points === null) continue;
    criteria.push({ description: cells[1] ?? "", points });
  }
  return criteria;
}

/** Canvas caps a criterion description at 255 characters, counted by code point. */
function criterionDescription(description: string): string {
  return Array.from(description).slice(0, 255).join("");
}

/**
 * The rubric Canvas has attached to an assignment, read from the assignment's
 * own payload (`rubric_settings` and `rubric`), or null when it has none.
 */
export function attachedRubric(assignment: Payload): { id: string; criteria: Criterion[] } | null {
  const settings = assignment.rubric_settings;
  if (!isTable(settings)) return null;
  const id = settings.id;
  if (id === undefined || id === null || id === "") return null;
  const rows: unknown[] = Array.isArray(assignment.rubric) ? assignment.rubric : [];
  const criteria: Criterion[] = [];
  for (const row of rows) {
    if (!isTable(row)) continue;
    criteria.push({ description: String(row.description ?? ""), points: Number(row.points) });
  }
  return { id: String(id), criteria };
}

/** True when Canvas's criteria are the repo's, in the same order, as they would be sent. */
export function sameCriteria(stored: readonly Criterion[], wanted: readonly Criterion[]): boolean {
  return (
    stored.length === wanted.length &&
    wanted.every((criterion, index) => {
      const other = stored[index];
      return (
        other !== undefined &&
        other.description === criterionDescription(criterion.description) &&
        other.points === criterion.points
      );
    })
  );
}

/** Canvas form fields for a rubric bound to an assignment. */
export function rubricFields(
  title: string,
  criteria: readonly Criterion[],
  associationId: string,
): Array<[string, string]> {
  const total = criteria.reduce((sum, c) => sum + c.points, 0);
  const fields: Array<[string, string]> = [
    ["rubric[title]", title],
    ["rubric[points_possible]", formatG(total)],
    ["rubric[free_form_criterion_comments]", "true"],
    ["rubric_association[association_id]", associationId],
    ["rubric_association[association_type]", "Assignment"],
    ["rubric_association[use_for_grading]", "true"],
    ["rubric_association[purpose]", "grading"],
  ];
  criteria.forEach((criterion, index) => {
    const key = `rubric[criteria][${index}]`;
    fields.push([`${key}[description]`, criterionDescription(criterion.description)]);
    fields.push([`${key}[points]`, formatG(criterion.points)]);
    fields.push([`${key}[ratings][0][description]`, "Full marks"]);
    fields.push([`${key}[ratings][0][points]`, formatG(criterion.points)]);
    fields.push([`${key}[ratings][1][description]`, "No marks"]);
    fields.push([`${key}[ratings][1][points]`, "0"]);
  });
  return fields;
}

// ---------------------------------------------------------------------------
// Manifest: what has been created in which course
// ---------------------------------------------------------------------------

export type ObjectKind = "page" | "assignment" | "discussion" | "quiz" | "file" | "module" | "syllabus";

/**
 * One manifest entry. Its JSON form keeps the Python field names (`canvas_id`,
 * `page_url`), since manifests already committed to course repos use them.
 */
export class Entry {
  kind: ObjectKind;
  canvasId: string;
  pageUrl: string;
  title: string;
  extra: Record<string, string>;

  constructor(fields: {
    kind: ObjectKind;
    canvasId: string;
    pageUrl?: string;
    title?: string;
    extra?: Record<string, string>;
  }) {
    this.kind = fields.kind;
    this.canvasId = fields.canvasId;
    this.pageUrl = fields.pageUrl ?? "";
    this.title = fields.title ?? "";
    this.extra = fields.extra ?? {};
  }

  toJson(): Payload {
    return {
      kind: this.kind,
      canvas_id: this.canvasId,
      page_url: this.pageUrl,
      title: this.title,
      extra: this.extra,
    };
  }
}

export type NativeKind = "page" | "assignment" | "discussion" | "quiz" | "file";

const NATIVE_KINDS: readonly NativeKind[] = ["page", "assignment", "discussion", "quiz", "file"];

/**
 * A module item that exists only in Canvas, named in a [[module]] table.
 *
 * A hand built exam quiz or a file uploaded through the Canvas UI has no repo
 * file and so no manifest entry, but it still belongs in a module. Listing it
 * under `canvas` keeps it there across the rebuild every push does:
 *
 *     [[module]]
 *     title  = "Week 8: Midterm Exam"
 *     page   = "notes/midterm-review.md"
 *     canvas = [{ quiz = 394147 }, { quiz = 393662, title = "Midterm" }]
 *
 * A page is named by its url slug; everything else by its numeric id.
 */
export interface NativeItem {
  readonly kind: NativeKind;
  readonly ident: string;
  readonly title: string;
}

/**
 * The `canvas` list of one [[module]] table, in the order written.
 *
 * Each entry is a one key table naming the kind, with an optional `title`.
 * Anything else is a mistake in canvas.toml and is reported as one rather
 * than silently building a module with a hole in it.
 */
export function parseNativeItems(module: Payload): NativeItem[] {
  const raw = module.canvas ?? [];
  if (!Array.isArray(raw)) {
    throw new ValueError("'canvas' must be a list of tables such as { quiz = 123 }");
  }
  return raw.map((entry: unknown, index) => nativeItem(entry, index + 1));
}

/** One `{ quiz = 123, title = "..." }` table, checked. */
function nativeItem(entry: unknown, index: number): NativeItem {
  if (!isTable(entry)) {
    throw new ValueError(`canvas item ${index}: expected a table such as { quiz = 123 }`);
  }
  const kinds = NATIVE_KINDS.filter((k) => k in entry);
  const unknown = Object.keys(entry).filter((k) => !(NATIVE_KINDS as readonly string[]).includes(k) && k !== "title");
  const kind = kinds[0];
  if (kinds.length !== 1 || kind === undefined || unknown.length > 0) {
    throw new ValueError(
      `canvas item ${index}: name exactly one of ${NATIVE_KINDS.join(", ")}, plus an optional title`,
    );
  }
  const ident = String(entry[kind]).trim();
  if (!ident) throw new ValueError(`canvas item ${index}: ${kind} needs an id`);
  return { kind, ident, title: String(entry.title ?? "") };
}

/**
 * Every repo path the [[module]] tables place, from `page` and `items`.
 *
 * Tolerant of a malformed table the way the push and the outline are: a
 * module that is not a table, or an `items` that is not a list, simply
 * contributes nothing.
 */
export function moduleKeys(modules: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const module of modules) {
    if (!isTable(module)) continue;
    const page = String(module.page ?? "");
    if (page) keys.add(page);
    const items = module.items ?? [];
    if (Array.isArray(items)) {
      for (const k of items) if (typeof k === "string" && k) keys.add(k);
    }
  }
  return keys;
}

/**
 * One line of a [[module]]'s `page` and `items`.
 *
 * Exactly one field is set: a repo path, the text of a header, or a
 * Canvas-native object placed at this point rather than after the repo items.
 */
export interface ModuleEntry {
  readonly key: string;
  readonly header: string;
  readonly native: NativeItem | null;
}

/**
 * The `page` then the `items` of one [[module]] table, in order.
 *
 * An item is a repo path; a table `{ header = "Due by Sunday ..." }`, which
 * becomes a Canvas text header (a SubHeader item) at that point in the module;
 * or a Canvas-native table such as `{ quiz = 123, title = "Survey" }`, which is
 * the same as listing it under `canvas` except that it keeps its place.
 * Anything else is a mistake in canvas.toml and is reported as one.
 */
export function moduleEntries(module: Payload): ModuleEntry[] {
  const entries: ModuleEntry[] = [];
  const page = module.page;
  if (truthy(page)) entries.push({ key: String(page), header: "", native: null });
  const items = module.items ?? [];
  if (!Array.isArray(items)) throw new ValueError("'items' must be a list");
  items.forEach((item: unknown, offset) => {
    const index = offset + 1;
    if (typeof item === "string") {
      if (item) entries.push({ key: item, header: "", native: null });
    } else if (isTable(item) && "header" in item) {
      const text = String(item.header).trim();
      if (Object.keys(item).length !== 1 || !text) {
        throw new ValueError(`item ${index}: a header is { header = "text" } and nothing else`);
      }
      entries.push({ key: "", header: text, native: null });
    } else if (isTable(item)) {
      entries.push({ key: "", header: "", native: nativeItem(item, index) });
    } else {
      throw new ValueError(`item ${index}: expected a repo path or { header = "..." }, got ${pyRepr(item)}`);
    }
  });
  return entries;
}

/** A JSON value with every object's keys sorted, as `json.dumps(sort_keys=True)`. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isTable(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/**
 * `json.dumps(payload, indent=2, sort_keys=True)`, byte for byte, so a manifest
 * written by either version diffs cleanly: Python escapes every non-ASCII
 * character as \uXXXX.
 */
function pythonJson(payload: unknown): string {
  return JSON.stringify(sortKeys(payload), null, 2).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Maps repo paths to Canvas objects, checkpointed after every write.
 *
 * Committed to the course repository: it holds ids, not secrets, and it is
 * what makes a second push an update rather than a duplicate.
 */
export class Manifest {
  readonly path: string;
  readonly entries = new Map<string, Entry>();

  constructor(file: string) {
    this.path = file;
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const stored = isTable(raw) && isTable(raw.entries) ? raw.entries : {};
      for (const [key, value] of Object.entries(stored)) {
        if (!isTable(value)) continue;
        const extra = isTable(value.extra) ? value.extra : {};
        this.entries.set(
          key,
          new Entry({
            // The kind is written by save() from an ObjectKind, so it is one.
            kind: value.kind as ObjectKind,
            canvasId: String(value.canvas_id),
            pageUrl: String(value.page_url ?? ""),
            title: String(value.title ?? ""),
            extra: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
          }),
        );
      }
    }
  }

  static forCourse(repo: string, courseId: string): Manifest {
    return new Manifest(path.join(repo, ".canvas", `manifest-${courseId}.json`));
  }

  get(key: string): Entry | null {
    return this.entries.get(key) ?? null;
  }

  put(key: string, entry: Entry): void {
    this.entries.set(key, entry);
    this.save();
  }

  drop(key: string): void {
    this.entries.delete(key);
    this.save();
  }

  save(): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const entries: Payload = {};
    for (const [k, v] of this.entries) entries[k] = v.toJson();
    writeFileSync(this.path, `${pythonJson({ entries })}\n`, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

const HREF_RE = /(href|src)="([^"]+)"/g;

export function canvasPath(entry: Entry, courseId: string): string {
  switch (entry.kind) {
    case "page":
      return `/courses/${courseId}/pages/${entry.pageUrl}`;
    case "assignment":
      return `/courses/${courseId}/assignments/${entry.canvasId}`;
    case "discussion":
      return `/courses/${courseId}/discussion_topics/${entry.canvasId}`;
    case "quiz":
      return `/courses/${courseId}/quizzes/${entry.canvasId}`;
    case "file":
      return `/courses/${courseId}/files/${entry.canvasId}`;
    case "syllabus":
      // Not the course root: that is the home page, which is not the syllabus
      // unless the course happens to use the syllabus as its home.
      return `/courses/${courseId}/assignments/syllabus`;
    default:
      return `/courses/${courseId}`;
  }
}

/**
 * Point every repo-relative link at its Canvas object.
 *
 * Returns the rewritten HTML and a list of links that could not be resolved.
 * An unresolved link is a bug: the repository's own link check already proves
 * every relative target exists on disk.
 */
export function rewriteLinks(
  html: string,
  source: string,
  repo: string,
  manifest: Manifest,
  courseId: string,
): [string, string[]] {
  const unresolved: string[] = [];

  const out = html.replace(HREF_RE, (whole: string, attribute: string, target: string) => {
    if (["http://", "https://", "mailto:", "#", "/"].some((prefix) => target.startsWith(prefix))) {
      return whole;
    }
    const hash = target.indexOf("#");
    const pathPart = hash === -1 ? target : target.slice(0, hash);
    const fragment = hash === -1 ? "" : target.slice(hash + 1);
    if (!pathPart) return whole;
    // Normalised lexically, not with realpath: a target may be a symlink to
    // somewhere outside the repo (a PDF the website serves from its own public
    // directory), and the manifest keys it by where the link points.
    const joined = path.normalize(path.join(path.resolve(path.dirname(source)), pathPart));
    const relative = path.relative(path.resolve(repo), joined);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      unresolved.push(target);
      return whole;
    }
    const entry = manifest.get(toPosix(relative));
    if (entry === null) {
      unresolved.push(target);
      return whole;
    }
    let url = canvasPath(entry, courseId);
    if (attribute === "src" && entry.kind === "file") {
      // The bare file URL is Canvas's HTML page about the file, which an
      // <img> cannot display. /preview serves the bytes, and it is what the
      // rich content editor itself writes for an embedded image.
      url = `${url}/preview`;
    }
    if (fragment && (entry.kind === "page" || entry.kind === "syllabus")) url = `${url}#${fragment}`;
    return `${attribute}="${url}"`;
  });

  return [out, unresolved];
}

// ---------------------------------------------------------------------------
// Comparison, for the verify pass
// ---------------------------------------------------------------------------

export const CANVAS_ADDED_ATTRS: readonly string[] = [
  "data-api-endpoint",
  "data-api-returntype",
  "data-course-type",
  "data-published",
  "data-id",
  "loading",
];

/** Collapse HTML to its visible text, for comparing what Canvas stored. */
export function visibleText(html: string): string {
  let text = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(TAG_RE, " ");
  for (const [entity, char] of [
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    ["&nbsp;", " "],
  ] as const) {
    text = text.replaceAll(entity, char);
  }
  return text.replace(/\s+/g, " ").trim();
}

const STRUCTURE_TAGS = ["h2", "h3", "table", "tr", "td", "th", "li", "pre", "a", "img", "div"] as const;

/** Count the structural elements that must survive a round trip. */
export function structureCounts(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tag of STRUCTURE_TAGS) {
    counts[tag] = (html.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
  }
  return counts;
}

/** Every CSS declaration present, sorted, for before/after comparison. */
export function styleDeclarations(html: string): string[] {
  const declarations: string[] = [];
  for (const match of html.matchAll(STYLE_ATTR_RE)) {
    for (const declaration of (match[1] ?? "").split(";")) {
      if (declaration.trim()) declarations.push(declaration.replace(/\s+/g, "").toLowerCase());
    }
  }
  return declarations.sort();
}

/** Course-relative links, so verify can prove each one resolves. */
export function internalLinks(html: string, courseId: string): string[] {
  const prefix = `/courses/${courseId}/`;
  const found = new Set<string>();
  for (const match of html.matchAll(HREF_RE)) {
    const target = match[2] ?? "";
    if (target.startsWith(prefix)) found.add(target.split("#")[0] ?? "");
  }
  return [...found].sort();
}
