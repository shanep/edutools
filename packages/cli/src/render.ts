/**
 * The seam between `create`/`update --body-file x.md` and the markdown pipeline.
 *
 * A markdown body goes through the same Canvas-safe rendering as `push`, and its
 * H1 becomes the default title, so the two paths agree on what a document is
 * called. That pipeline is the publish port, which has not landed yet. When it
 * does, this function renders the file with it (render, decorate, mark table
 * rows, wrap tables) and nothing that calls it changes.
 */

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
  throw new RenderError(
    `cannot render ${file}: markdown bodies arrive with the publish port. ` +
      "Pass an .html --body-file or --body for now.",
  );
}
