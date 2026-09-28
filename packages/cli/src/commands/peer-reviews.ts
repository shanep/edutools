import type { Register } from "../cli";
import { isRecord, printTable, str } from "../format";
import { selectAssignment, selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("peer-reviews")
    .description(
      "List the peer reviews assigned on an assignment, and whether each is done.\n\n" +
        "A graded discussion's peer reviews hang off its assignment id. --json\n" +
        "includes the comments each reviewer left, which is the review itself.",
    )
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("-a, --assignment <id>", "Assignment ID (prompted if omitted)")
    .option("--json", "Emit the raw peer reviews, with their comments, as JSON")
    .action(async (options: { course?: string; assignment?: string; json?: boolean }) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const assignmentId = options.assignment ?? (await selectAssignment(cli, courseId));
      const canvas = await cli.canvas();
      const reviews = await cli.status("Fetching peer reviews...", () =>
        canvas.listPeerReviews(courseId, assignmentId),
      );
      if (options.json) {
        cli.json(reviews);
        return;
      }
      const { c } = cli;
      if (reviews.length === 0) {
        cli.print(c.yellow("No peer reviews assigned."));
        return;
      }
      printTable(
        cli,
        `Peer reviews on assignment ${assignmentId}`,
        [
          { name: "Reviewer", align: "right", style: c.cyan },
          { name: "Reviews", align: "right", style: c.cyan },
          { name: "State" },
          { name: "Comments", align: "right", style: c.green },
        ],
        reviews.map((review) => {
          // Only the reviewer's own comments are the review; the reviewee may reply.
          const comments = Array.isArray(review.submission_comments)
            ? review.submission_comments.filter(
                (item) => isRecord(item) && str(item.author_id) === str(review.assessor_id),
              ).length
            : 0;
          const state = str(review.workflow_state);
          return [
            str(review.assessor_id),
            str(review.user_id),
            state === "completed" ? c.green(state) : c.yellow(state),
            String(comments),
          ];
        }),
      );
      const done = reviews.filter((review) => review.workflow_state === "completed").length;
      cli.print(c.dim(`\n${done} of ${reviews.length} completed`));
    });
};
