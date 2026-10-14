import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { linkedFiles } from "@edutools/core/objects";
import { safeComponent } from "@edutools/core/pull";
import { CliExit, type Register } from "../cli";
import { expandHome, isRecord, messageOf, str } from "../format";
import { selectAssignment, selectCourse } from "../select";

interface Options {
  out: string;
  course?: string;
  assignment?: string;
  student?: string;
}

function sizeOf(file: string): number | null {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export const register: Register = (program, cli) => {
  program
    .command("download")
    .description(
      "Download submission attachments so the work can be read locally.\n\n" +
        "Writes <out>/<user_id>/<filename>, plus submission.txt for any typed-in\n" +
        "text. A Canvas file the typed-in text links to is downloaded beside it, since\n" +
        "a file uploaded through the text editor is only linked, never attached. Files\n" +
        "a student attached to their own submission comments, such as work sent after\n" +
        "the assignment closed, go in <out>/<user_id>/comments/.\n" +
        "Nothing is overwritten silently: an existing file of the same size is left\n" +
        "alone, and so is any existing file of a linked file's name.",
    )
    .requiredOption("-o, --out <dir>", "Directory to write into; one subdirectory per student")
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("-a, --assignment <id>", "Assignment ID (prompted if omitted)")
    .option("-s, --student <id>", "Only this student")
    .action(async (options: Options) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const assignmentId = options.assignment ?? (await selectAssignment(cli, courseId));
      const canvas = await cli.canvas();
      let submissions = await cli.status("Fetching submissions...", () =>
        canvas.getSubmissions(courseId, assignmentId, { withComments: true }),
      );
      if (options.student !== undefined) {
        submissions = submissions.filter((s) => str(s.user_id) === options.student);
      }

      const root = expandHome(options.out);
      let written = 0;
      let skipped = 0;
      const problems: string[] = [];

      await cli.status(`Downloading ${submissions.length} submissions`, async (update) => {
        for (const sub of submissions) {
          const userId = str(sub.user_id);
          update(`Downloading user ${userId}`);
          // Student-supplied names become file names, and a Windows disk refuses
          // more of them than a Mac does.
          const folder = path.join(root, safeComponent(userId));

          if (sub.body) {
            mkdirSync(folder, { recursive: true });
            writeFileSync(path.join(folder, "submission.txt"), str(sub.body), "utf-8");
            written += 1;

            for (const file of linkedFiles(str(sub.body))) {
              // A linked file's size is not in the submission, so an existing file
              // of its name is taken to be it.
              const dest = path.join(folder, safeComponent(file.name));
              if (sizeOf(dest) !== null) {
                skipped += 1;
                continue;
              }
              try {
                await canvas.downloadLinkedFile(file.href, dest);
                written += 1;
              } catch (error) {
                problems.push(`user ${userId}, linked ${file.name}: ${messageOf(error)}`);
              }
            }
          }

          const attachments: Array<{ item: Record<string, unknown>; dir: string }> = (
            Array.isArray(sub.attachments) ? sub.attachments.filter(isRecord) : []
          ).map((item) => ({ item, dir: folder }));
          // A student whose assignment closed often attaches the work to a comment
          // instead. Only their own comments count: the grader's are not the work.
          const comments = Array.isArray(sub.submission_comments) ? sub.submission_comments.filter(isRecord) : [];
          for (const comment of comments) {
            if (str(comment.author_id) !== userId || !Array.isArray(comment.attachments)) continue;
            for (const item of comment.attachments.filter(isRecord)) {
              attachments.push({ item, dir: path.join(folder, "comments") });
            }
          }
          for (const { item, dir } of attachments) {
            if (!item.url) continue;
            const name = str(item.display_name || item.filename || item.id);
            const dest = path.join(dir, safeComponent(name));
            const size = item.size;
            if (typeof size === "number" && Number.isInteger(size) && sizeOf(dest) === size) {
              skipped += 1;
              continue;
            }
            try {
              await canvas.downloadAttachment(str(item.url), dest);
              written += 1;
            } catch (error) {
              problems.push(`user ${userId}, ${name}: ${messageOf(error)}`);
            }
          }
        }
      });

      const { c } = cli;
      cli.print(`${c.green("✓")} ${written} file(s) written to ${root}${skipped ? `, ${skipped} already present` : ""}`);
      if (problems.length > 0) {
        cli.error(`\n${problems.length} download problem(s):`);
        for (const problem of problems.slice(0, 20)) cli.note(`  ${cli.e.red("•")} ${problem}`);
        throw new CliExit(1);
      }
    });
};
