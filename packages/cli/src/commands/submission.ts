import type { Register } from "../cli";
import { isRecord, printPanel, printTable, str } from "../format";
import { selectAssignment, selectCourse } from "../select";

interface Options {
  course?: string;
  assignment?: string;
  student: string;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("submission")
    .description(
      "Show one submission with its body, attachments, and existing comments.\n\n" +
        "This is what to read before grading: --json gives the submission text and\n" +
        "the attachment URLs, and shows any feedback already left on it.",
    )
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("-a, --assignment <id>", "Assignment ID (prompted if omitted)")
    .requiredOption("-s, --student <id>", "Student user ID")
    .option("--json", "Emit the raw submission JSON")
    .action(async (options: Options) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const assignmentId = options.assignment ?? (await selectAssignment(cli, courseId));
      const studentId = options.student;
      const canvas = await cli.canvas();
      const stored = await cli.status("Fetching submission...", () =>
        canvas.getSubmission(courseId, assignmentId, studentId),
      );

      if (options.json) {
        cli.json(stored);
        return;
      }

      const { c } = cli;
      const user = stored.user;
      const name = isRecord(user) ? str(user.name) : studentId;
      const score = stored.score === null || stored.score === undefined ? "-" : str(stored.score);
      printPanel(cli, `Submission - assignment ${assignmentId}`, [
        `${c.bold(name)} ${c.dim(`(user ${studentId})`)}`,
        `Grade: ${c.green(stored.grade ? str(stored.grade) : "-")}  Score: ${score}  State: ${str(stored.workflow_state)}`,
        `Submitted: ${stored.submitted_at ? str(stored.submitted_at) : "never"}  Late: ${str(stored.late)}  Missing: ${str(stored.missing)}`,
      ]);

      const attachments = Array.isArray(stored.attachments) ? stored.attachments.filter(isRecord) : [];
      if (attachments.length > 0) {
        printTable(
          cli,
          "Attachments",
          [
            { name: "ID", align: "right", style: c.cyan },
            { name: "Filename", style: c.green },
            { name: "Bytes", align: "right", style: c.dim },
          ],
          attachments.map((item) => [str(item.id), str(item.display_name), str(item.size)]),
        );
      }

      if (stored.body) {
        printPanel(cli, "Submitted text", [str(stored.body).slice(0, 4000)]);
      }

      const comments = Array.isArray(stored.submission_comments)
        ? stored.submission_comments.filter(isRecord)
        : [];
      if (comments.length > 0) {
        cli.print(`\n${c.bold("Existing comments")}`);
        for (const item of comments) {
          cli.print(
            `  ${c.dim(str(item.created_at ?? ""))} ${c.cyan(str(item.author_name ?? ""))}: ${str(item.comment ?? "")}`,
          );
        }
      }
    });
};
