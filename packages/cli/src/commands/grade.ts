import { readFileSync } from "node:fs";
import path from "node:path";
import { FieldError, GradeRow, parseGrades } from "@edutools/core/objects";
import { CliExit, type Register } from "../cli";
import { expandHome, messageOf, printTable } from "../format";
import { isFile } from "../options";
import { selectAssignment, selectCourse } from "../select";

interface Options {
  course?: string;
  assignment?: string;
  student?: string;
  score?: string;
  comment?: string;
  commentFile?: string;
  excuse?: boolean;
  lateStatus?: string;
  fromFile?: string;
  csv?: boolean;
  dryRun?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("grade")
    .description(
      "Grade submissions, with feedback.\n\n" +
        "One student:\n\n" +
        '    edutools grade -c 123 -a 456 -s 789 --score 18 --comment "Clean tests."\n\n' +
        "A batch, from JSON (a list of objects, or an object keyed by student id) or\n" +
        "a CSV with a header row. Column names are matched loosely, so score/grade/\n" +
        "points and comment/feedback all work:\n\n" +
        '    [{"student": 789, "score": 18, "comment": "Clean tests."},\n' +
        '     {"student": 790, "excuse": true}]\n\n' +
        "A comment with no score returns feedback without putting a number on it.\n" +
        "If the assignment has a manual posting policy the grade lands but stays\n" +
        "hidden until it is posted from the Canvas gradebook.",
    )
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("-a, --assignment <id>", "Assignment ID (prompted if omitted)")
    .option("-s, --student <id>", "Student user ID (omit when using --from-file)")
    .option("--score <grade>", "Grade: points ('18'), percent ('92%'), letter ('B+'), or pass/fail")
    .option("--comment <text>", "Feedback comment")
    .option("--comment-file <path>", "Feedback comment from a file")
    .option("--excuse", "Excuse the student from the assignment")
    .option("--late-status <status>", "late, missing, extended, none")
    .option("--from-file <path>", "Grade a batch from JSON or CSV; '-' reads stdin")
    .option("--csv", "Treat --from-file as CSV (inferred from a .csv name)")
    .option("--dry-run", "Show what would be sent, write nothing")
    .action(async (options: Options) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const assignmentId = options.assignment ?? (await selectAssignment(cli, courseId));

      let comment = options.comment;
      if (comment !== undefined && options.commentFile !== undefined) {
        throw cli.fail("Pass --comment or --comment-file, not both.");
      }
      if (options.commentFile !== undefined) {
        const file = expandHome(options.commentFile);
        if (!isFile(file)) throw cli.fail(`No such file: ${file}`);
        comment = readFileSync(file, "utf-8").trim();
      }

      let rows: GradeRow[];
      if (options.fromFile !== undefined) {
        if (options.student !== undefined) throw cli.fail("Pass --student or --from-file, not both.");
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
        try {
          rows = parseGrades(text, { asCsv: Boolean(options.csv) || name.toLowerCase().endsWith(".csv") });
        } catch (error) {
          if (error instanceof FieldError) throw cli.fail(error.message);
          throw error;
        }
      } else {
        if (options.student === undefined) throw cli.fail("Pass --student, or --from-file for a batch.");
        try {
          rows = [
            new GradeRow({
              userId: options.student,
              grade: options.score ?? null,
              comment: comment ?? null,
              excuse: options.excuse ? true : null,
              latePolicyStatus: options.lateStatus ?? null,
            }),
          ];
        } catch (error) {
          if (error instanceof FieldError) throw cli.fail(error.message);
          throw error;
        }
      }

      const { c } = cli;
      const title = `Grading assignment ${assignmentId}`;
      const columns = (last: string) => [
        { name: "User ID", align: "right" as const, style: c.cyan },
        { name: "Grade", style: c.green },
        { name: "Comment" },
        { name: last },
      ];
      const shown = (row: GradeRow) => [row.userId, row.grade || "-", (row.comment ?? "").slice(0, 60)];

      if (options.dryRun) {
        printTable(
          cli,
          title,
          columns("Would send"),
          rows.map((row) => [...shown(row), c.dim("dry run")]),
        );
        cli.print(`\n${c.green("✓")} dry run: ${rows.length} submission(s), nothing written.`);
        return;
      }

      const canvas = await cli.canvas();
      const failures: string[] = [];
      const results: string[][] = [];
      // Sequential on purpose: Canvas throttles parallel writes, and one row at a
      // time is what lets the report say exactly which students failed.
      await cli.status(`Grading ${rows.length} submission(s)`, async (update) => {
        for (const row of rows) {
          update(`Grading user ${row.userId}`);
          let outcome: string;
          try {
            const stored = await canvas.gradeSubmission(courseId, assignmentId, row.userId, {
              grade: row.grade ?? undefined,
              comment: row.comment ?? undefined,
              excuse: row.excuse ?? undefined,
              latePolicyStatus: row.latePolicyStatus ?? undefined,
              rubricAssessment: Object.keys(row.rubric).length > 0 ? row.rubric : undefined,
            });
            outcome = c.green(stored.grade ? String(stored.grade) : "commented");
          } catch (error) {
            outcome = c.red("failed");
            failures.push(`user ${row.userId}: ${messageOf(error)}`);
          }
          results.push([...shown(row), outcome]);
        }
      });

      printTable(cli, title, columns("Result"), results);
      if (failures.length > 0) {
        cli.error(`\n${failures.length} failure(s):`);
        for (const failure of failures.slice(0, 20)) cli.note(`  ${cli.e.red("•")} ${failure}`);
        throw new CliExit(1);
      }
      cli.print(`\n${c.green("✓")} graded ${rows.length} submission(s) in course ${courseId}`);
    });
};
