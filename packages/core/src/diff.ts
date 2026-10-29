/**
 * Line diffs between what the repo renders and what Canvas stores, for the
 * diff command. Pure: no Canvas, no file system.
 *
 * A body is diffed as readable lines, one per paragraph, heading, list item or
 * table row, with links and images written the markdown way, so a Canvas edit
 * reads as the markdown change that would copy it back. The markup view keeps
 * every tag, one per line, for changes the text view cannot show.
 */

import { CANVAS_ADDED_ATTRS } from "./publish";

export type DiffOp = " " | "-" | "+";

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
}

export interface Hunk {
  /** 1-based first line on the repo side, and how many lines the hunk covers there. */
  readonly repoStart: number;
  readonly repoCount: number;
  /** The same on the Canvas side. */
  readonly canvasStart: number;
  readonly canvasCount: number;
  readonly lines: readonly DiffLine[];
}

const BLOCK_TAGS = "p|div|h[1-6]|li|ul|ol|table|thead|tbody|tfoot|tr|pre|blockquote|section|details|summary|figure|figcaption|hr|br|dl|dt|dd";
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;|&#160;|&#xa0;/gi, " "],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;|&apos;/g, "'"],
  [/&amp;/g, "&"],
];

/**
 * What Canvas adds on its own: data-api-* attributes, the verifier (a UUID,
 * dashes and all) and location on a file link, the host it puts in front of a
 * course link, the closing semicolon of a style, and the account's stylesheet
 * `<link>`.
 */
function withoutCanvasNoise(html: string): string {
  let out = html;
  for (const attr of CANVAS_ADDED_ATTRS) out = out.replace(new RegExp(`\\s${attr}="[^"]*"`, "g"), "");
  for (const param of ["verifier", "location"]) {
    out = out.replace(new RegExp(`\\?${param}=[^"'&\\s]*&(amp;)?`, "g"), "?");
    out = out.replace(new RegExp(`(\\?|&(amp;)?)${param}=[^"'&\\s]*`, "g"), "");
  }
  out = out.replace(/(["'])https?:\/\/[^/"']+(\/courses\/)/g, "$1$2");
  out = out.replace(/(\sstyle="[^"]*?);\s*"/g, '$1"');
  return out.replace(/<link\b[^>]*>/gi, "");
}

function decode(text: string): string {
  let out = text;
  for (const [pattern, char] of ENTITIES) out = out.replace(pattern, char);
  return out;
}

function attrOf(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

/**
 * HTML as readable lines: one per block, `#` before a heading, `- ` before a
 * list item, cells joined with ` | `, links as `[text](href)`, images as
 * `![alt](src)`, inline code in backticks. A `<pre>` keeps its own lines.
 */
export function textLines(html: string): string[] {
  let out = withoutCanvasNoise(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  // Hold each <pre> aside so its line breaks survive the whitespace collapse.
  const blocks: string[] = [];
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
    blocks.push(decode(inner.replace(/<[^>]+>/g, "")).replace(/\n$/, ""));
    return `<p>\uE000${blocks.length - 1}\uE000</p>`;
  });
  out = out.replace(/\s+/g, " ");
  out = out.replace(/<img\b[^>]*>/gi, (tag) => `![${attrOf(tag, "alt")}](${attrOf(tag, "src")})`);
  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_whole, attrs: string, inner: string) => {
    const href = attrOf(` ${attrs}`, "href");
    return href ? `[${inner}](${href})` : inner;
  });
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  out = out.replace(/<h([1-6])\b[^>]*>/gi, (_whole, level: string) => `\n${"#".repeat(Number(level))} `);
  out = out.replace(/<li\b[^>]*>/gi, "\n- ");
  out = out.replace(/<\/t[hd]>\s*(?=<t[hd]\b)/gi, " | ");
  out = out.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
  out = decode(out.replace(/<[^>]+>/g, ""));
  const lines: string[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    const held = /^\uE000(\d+)\uE000$/.exec(line);
    if (held) lines.push(...(blocks[Number(held[1])] ?? "").split("\n"));
    else if (line !== "" && line !== "-") lines.push(line);
  }
  return lines;
}

/** HTML as markup lines: every tag on a line of its own, whitespace collapsed. */
export function markupLines(html: string): string[] {
  return withoutCanvasNoise(html)
    .replace(/\s+/g, " ")
    .split(/(<[^>]+>)/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Every line of both sides in order: kept, dropped from the repo's, or added by Canvas's. */
export function lineDiff(repo: readonly string[], canvas: readonly string[]): DiffLine[] {
  // Trim the shared ends first, so the table below covers only the changed middle.
  let start = 0;
  while (start < repo.length && start < canvas.length && repo[start] === canvas[start]) start++;
  let endRepo = repo.length;
  let endCanvas = canvas.length;
  while (endRepo > start && endCanvas > start && repo[endRepo - 1] === canvas[endCanvas - 1]) {
    endRepo--;
    endCanvas--;
  }
  const a = repo.slice(start, endRepo);
  const b = canvas.slice(start, endCanvas);
  // Longest common subsequence, filled from the end so the walk below goes forward.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = repo.slice(0, start).map((text) => ({ op: " ", text }));
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] ?? "" });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ op: "-", text: a[i++] ?? "" });
    } else {
      out.push({ op: "+", text: b[j++] ?? "" });
    }
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] ?? "" });
  while (j < b.length) out.push({ op: "+", text: b[j++] ?? "" });
  for (const text of repo.slice(endRepo)) out.push({ op: " ", text });
  return out;
}

/** The changed stretches of a diff, each with `context` unchanged lines around it. */
export function hunks(lines: readonly DiffLine[], context = 3): Hunk[] {
  const changed = lines.flatMap((line, index) => (line.op === " " ? [] : [index]));
  const out: Hunk[] = [];
  let k = 0;
  while (k < changed.length) {
    const first = changed[k] ?? 0;
    let last = first;
    // Merge changes whose context would touch or overlap.
    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - last <= 2 * context + 1) last = changed[++k] ?? last;
    k++;
    const from = Math.max(0, first - context);
    const to = Math.min(lines.length, last + context + 1);
    const before = lines.slice(0, from);
    const slice = lines.slice(from, to);
    const repoBefore = before.filter((line) => line.op !== "+").length;
    const canvasBefore = before.filter((line) => line.op !== "-").length;
    const repoCount = slice.filter((line) => line.op !== "+").length;
    const canvasCount = slice.filter((line) => line.op !== "-").length;
    out.push({
      repoStart: repoCount === 0 ? repoBefore : repoBefore + 1,
      repoCount,
      canvasStart: canvasCount === 0 ? canvasBefore : canvasBefore + 1,
      canvasCount,
      lines: slice,
    });
  }
  return out;
}
