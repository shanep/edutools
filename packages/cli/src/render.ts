/**
 * The seam between `create`/`update --body-file x.md` and the markdown pipeline.
 *
 * A markdown body goes through the same Canvas-safe rendering as `push`, and its
 * H1 becomes the default title, so the two paths agree on what a document is
 * called.
 */

import { decorate, markTableRows, PublishError, renderMarkdown, wrapTables } from "@edutools/core/publish";

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderedBody {
  /** The document's H1, or null when it has none. */
  readonly title: string | null;
  readonly html: string;
}

/** Render a markdown file into Canvas HTML. */
export async function renderMarkdownBody(file: string): Promise<RenderedBody> {
  try {
    const [title, html] = renderMarkdown(file);
    return { title: title || null, html: wrapTables(markTableRows(decorate(html))) };
  } catch (error) {
    if (error instanceof PublishError) throw new RenderError(error.message);
    throw error;
  }
}
