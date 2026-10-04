/**
 * Download a Canvas content export: the package Settings -> Export Course Content
 * builds, fetched through the API instead of the browser.
 *
 * This is how a question bank leaves Canvas. A classic quiz that draws its
 * questions from a linked bank lists none of them through the quiz questions
 * API, and banks have no REST endpoint of their own, so `pull` sees an empty
 * quiz. Only a whole-course common cartridge export carries the banks, under
 * non_cc_assessments/. A qti export, or any export narrowed to some quizzes,
 * names each bank by its ident and leaves the questions out.
 *
 * An export is three steps: ask for one, wait while Canvas builds it in the
 * background, then download the attachment it produces. Nothing in the course
 * changes; the export only shows up in the course's export history.
 */

import type { CanvasLMS } from "./canvas";
import type { Payload } from "./types";

export type Reporter = (message: string) => void;

/** The client methods an export calls, so a test can hand in a plain object. */
export type ExportCanvas = Pick<CanvasLMS, "startContentExport" | "getContentExport" | "downloadAttachment">;

/** What Canvas builds: `export_type` on the Content Exports API. */
export const EXPORT_TYPES: readonly string[] = ["qti", "common_cartridge", "zip"];

/** The extension Canvas gives each kind of package when the UI downloads it. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  qti: "zip",
  common_cartridge: "imscc",
  zip: "zip",
};

// A whole course with its files can take minutes; a few quizzes take seconds.
const POLL_MS = 3_000;
const TIMEOUT_MS = 30 * 60_000;

/** Raised when an export is asked for something Canvas cannot build, or fails. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportOptions {
  readonly type: string;
  /** Quiz ids to export instead of all of them. */
  readonly quizzes?: readonly string[];
  readonly report?: Reporter;
  /** Injected in tests so polling does not really wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export interface ExportResult {
  readonly path: string;
  readonly bytes: number;
  /** The content export as Canvas last reported it. */
  readonly export: Payload;
}

/** `canvas-<course>-<type>.<ext>`, where the export lands when no path is given. */
export function defaultName(courseId: string, type: string): string {
  return `canvas-${courseId}-${type}.${EXTENSIONS[type] ?? "zip"}`;
}

/**
 * The form fields that start an export.
 *
 * Canvas only honours `select` for some types: a QTI package is nothing but
 * quizzes, and a zip export is only the course files. Asking for quizzes in a
 * zip export would quietly export every file instead, so it is refused here.
 */
export function exportFields(type: string, quizzes: readonly string[] = []): Array<[string, string]> {
  if (!EXPORT_TYPES.includes(type)) {
    throw new ExportError(`unknown export type '${type}'; expected one of ${EXPORT_TYPES.join(", ")}`);
  }
  if (quizzes.length > 0 && type === "zip") {
    throw new ExportError("a zip export holds only course files; select quizzes with qti or common_cartridge");
  }
  // Without this Canvas emails the user a link to every export it finishes.
  const fields: Array<[string, string]> = [
    ["export_type", type],
    ["skip_notifications", "true"],
  ];
  for (const id of quizzes) fields.push(["select[quizzes][]", id]);
  return fields;
}

function attachmentUrl(exported: Payload): string | undefined {
  const attachment = exported.attachment;
  if (attachment === null || typeof attachment !== "object" || Array.isArray(attachment)) return undefined;
  // Narrowed to a plain object just above.
  const url = (attachment as Payload).url;
  return typeof url === "string" && url ? url : undefined;
}

/** Start an export of `courseId`, wait for Canvas to build it, and save it at `dest`. */
export async function exportCourse(
  client: ExportCanvas,
  courseId: string,
  dest: string,
  options: ExportOptions,
): Promise<ExportResult> {
  const fields = exportFields(options.type, options.quizzes);
  const report = options.report ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? POLL_MS;
  const deadline = now() + (options.timeoutMs ?? TIMEOUT_MS);

  report(`Starting a ${options.type} export`);
  let current = await client.startContentExport(courseId, fields);
  const id = String(current.id ?? "");
  if (!id) throw new ExportError("Canvas did not return an export id");

  for (;;) {
    const state = String(current.workflow_state ?? "");
    if (state === "exported") break;
    if (state === "failed") throw new ExportError(`Canvas could not build export ${id}`);
    if (now() >= deadline) {
      throw new ExportError(`export ${id} was still ${state || "pending"} when the wait ran out`);
    }
    report(`Canvas is building export ${id} (${state || "pending"})`);
    await sleep(pollMs);
    current = await client.getContentExport(courseId, id);
  }

  const url = attachmentUrl(current);
  if (url === undefined) throw new ExportError(`export ${id} finished with no file to download`);
  report(`Downloading export ${id}`);
  const bytes = await client.downloadAttachment(url, dest);
  return { path: dest, bytes, export: current };
}
