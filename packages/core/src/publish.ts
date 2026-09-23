/**
 * SEED ONLY. The publish port replaces this whole file with the full port of
 * src/edutools/publish.py; isDraft is here early because dates.ts needs it.
 */

// "---\nnext: false\n---\n" at the very top of the file.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

// "draft: true" as a top level key of that frontmatter. A regex rather than a YAML
// library: this is the only key edutools reads, and the block is otherwise
// VitePress's business.
const DRAFT_RE = /^draft[ \t]*:[ \t]*(true|yes|on)[ \t]*$/im;

/** Whether a course file is marked `draft: true` in its frontmatter. */
export function isDraft(markdown: string): boolean {
  const block = FRONTMATTER_RE.exec(markdown);
  return block !== null && DRAFT_RE.test(block[0]);
}
