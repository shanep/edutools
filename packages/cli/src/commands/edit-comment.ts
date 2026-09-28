import { readFileSync } from "node:fs";
import path from "node:path";
import { CommentEdit, commentById, FieldError, latestCommentBy, parseCommentEdits } from "@edutools/core/objects";
import { CliExit, type Register } from "../cli";
import { expandHome, messageOf, printTable, str } from "../format";
import { isFile } from "../options";
import { selectAssignment, selectCourse } from "../select";

interface Options {
  course?: string;
  assignment?: string;
  student?: string;
  commentId?: string;
  comment?: string;
  commentFile?: string;
  fromFile?: string;
  csv?: boolean;
  dryRun?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("edit-comment")
    .description(
      "Rewrite feedback already left on a submission, in place.\n\n" +
        "The comment keeps its id, author and date, so the student sees the new\n" +
        "text instead of the old comment with a correction below it. Without\n" +
        "--comment-id the edit goes to the most recent comment you wrote.\n\n" +
        "One student:\n\n" +
        '    edutools edit-comment -c 123 -a 456 -s 789 --comment "Clearer wording."\n\n' +
        "A batch takes the same JSON or CSV as grade (only student and comment are\n" +
        "read), plus an optional comment_id column:\n\n" +
        '    [{"student": 789, "comment": "Clearer wording."},\n' +
        '     {"student": 790, "comment_id": 4321, "comment": "Fixed the typo."}]\n\n' +
        "--dry-run reads each submission and shows the old text beside the new,\n" +
        "so it needs the token but writes nothing.",
    )
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("-a, --assignment <id>", "Assignment ID (prompted if omitted)")
    .option("-s, --student <id>", "Student user ID (omit when using --from-file)")
    .option("--comment-id <id>", "The comment to edit (default: your most recent one)")
    .option("--comment <text>", "The new comment text")
    .option("--comment-file <path>", "The new comment text, from a file")
    .option("--from-file <path>", "Edit a batch from JSON or CSV; '-' reads stdin")
    .option("--csv", "Treat --from-file as CSV (inferred from a .csv name)")
    .option("--dry-run", "Show the old and new text, write nothing")
    .action(async (options: Options) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const assignmentId = options.assignment ?? (await selectAssignment(cli, courseId));

      let edits: CommentEdit[];
      try {
        if (options.fromFile !== undefined) {
          if (options.student !== undefined) throw cli.fail("Pass --student or --from-file, not both.");
          if (options.comment !== undefined || options.commentFile !== undefined || options.commentId !== undefined) {
            throw cli.fail("A batch takes its comments and comment ids from --from-file.");
          }
          let text: string;
          let name: string;
          if (options.fromFile === "-") {
            text = await cli.readStdin();
            name = "stdin";
          } else {
            const file = expandHome(options.fromFile);
            if (!isFile(file)) throw cli.fail(`No such file: ${file}`);
            text = readFileSync(file, "utf-8");
            name = path.basename(file);
          }
          edits = parseCommentEdits(text, { asCsv: Boolean(options.csv) || name.toLowerCase().endsWith(".csv") });
        } else {
          if (options.student === undefined) throw cli.fail("Pass --student, or --from-file for a batch.");
          if (options.comment !== undefined && options.commentFile !== undefined) {
            throw cli.fail("Pass --comment or --comment-file, not both.");
          }
          let comment = options.comment;
          if (options.commentFile !== undefined) {
            const file = expandHome(options.commentFile);
            if (!isFile(file)) throw cli.fail(`No such file: ${file}`);
            comment = readFileSync(file, "utf-8").trim();
          }
          if (comment === undefined) throw cli.fail("Pass the new text with --comment or --comment-file.");
          edits = [new CommentEdit({ userId: options.student, comment, commentId: options.commentId ?? null })];
        }
      } catch (error) {
        if (error instanceof FieldError) throw cli.fail(error.message);
        throw error;
      }

      const canvas = await cli.canvas();
      // Only needed to find "my latest comment"; an explicit id skips the lookup.
      const selfId = edits.some((edit) => edit.commentId === null) ? str((await canvas.getSelf()).id) : "";

      const { c } = cli;
      const failures: string[] = [];
      const results: string[][] = [];
      // Sequential on purpose: Canvas throttles parallel requests, and one row at
      // a time is what lets the report say exactly which students failed.
      await cli.status(`Editing ${edits.length} comment(s)`, async (update) => {
        for (const edit of edits) {
          update(`Reading user ${edit.userId}`);
          let commentId = edit.commentId ?? "-";
          let before = "";
          let outcome: string;
          try {
            const stored = await canvas.getSubmission(courseId, assignmentId, edit.userId, {
              include: ["submission_comments"],
            });
            const target =
              edit.commentId === null
                ? latestCommentBy(stored.submission_comments, selfId)
                : commentById(stored.submission_comments, edit.commentId);
            if (target === null) {
              throw new Error(
                edit.commentId === null
                  ? "you have no comment on this submission"
                  : `no comment ${edit.commentId} on this submission`,
              );
            }
            commentId = str(target.id);
            before = str(target.comment ?? "");
            if (options.dryRun) {
              outcome = c.dim("dry run");
            } else {
              update(`Editing comment ${commentId} for user ${edit.userId}`);
              await canvas.editSubmissionComment(courseId, assignmentId, edit.userId, commentId, edit.comment);
              outcome = c.green("edited");
            }
          } catch (error) {
            outcome = c.red("failed");
            failures.push(`user ${edit.userId}: ${messageOf(error)}`);
          }
          results.push([edit.userId, commentId, before.slice(0, 40), edit.comment.slice(0, 40), outcome]);
        }
      });

      printTable(
        cli,
        `Editing comments on assignment ${assignmentId}`,
        [
          { name: "User ID", align: "right", style: c.cyan },
          { name: "Comment ID", align: "right", style: c.dim },
          { name: "Was" },
          { name: "Now", style: c.green },
          { name: "Result" },
        ],
        results,
      );
      if (failures.length > 0) {
        cli.error(`\n${failures.length} failure(s):`);
        for (const failure of failures.slice(0, 20)) cli.note(`  ${cli.e.red("•")} ${failure}`);
        throw new CliExit(1);
      }
      if (options.dryRun) {
        cli.print(`\n${c.green("✓")} dry run: ${edits.length} comment(s), nothing written.`);
      } else {
        cli.print(`\n${c.green("✓")} edited ${edits.length} comment(s) in course ${courseId}`);
      }
    });
};
