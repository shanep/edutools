import { flattenDiscussion } from "@edutools/core/objects";
import type { Register } from "../cli";
import { printTable } from "../format";
import { selectCourse } from "../select";

// Enough of a body to recognise the post in a table; --json has the real HTML.
function preview(html: string): { words: number; text: string } {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { words: text ? text.split(" ").length : 0, text };
}

export const register: Register = (program, cli) => {
  program
    .command("discussion")
    .description(
      "List every post and reply in one discussion.\n\n" +
        "--json prints Canvas's full thread view (participants, and entries with\n" +
        "their replies nested), which is what to read when grading a discussion.",
    )
    .argument("<topic_id>", "Discussion topic ID")
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("--json", "Emit the raw thread view as JSON")
    .action(async (topicId: string, options: { course?: string; json?: boolean }) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const canvas = await cli.canvas();
      const view = await cli.status("Fetching the discussion...", () => canvas.getDiscussionView(courseId, topicId));
      if (options.json) {
        cli.json(view);
        return;
      }
      const entries = flattenDiscussion(view);
      const { c } = cli;
      if (entries.length === 0) {
        cli.print(c.yellow("No posts yet."));
        return;
      }
      printTable(
        cli,
        `Discussion ${topicId}`,
        [
          { name: "Entry", align: "right", style: c.dim },
          { name: "Author", style: c.cyan },
          { name: "User ID", align: "right", style: c.dim },
          { name: "Reply to", align: "right", style: c.dim },
          { name: "Posted", style: c.dim },
          { name: "Words", align: "right", style: c.green },
          { name: "Starts" },
        ],
        entries.map((entry) => {
          const body = preview(entry.message);
          return [
            entry.id,
            entry.author,
            entry.userId,
            entry.parentId ?? "-",
            entry.createdAt,
            String(body.words),
            body.text.slice(0, 50),
          ];
        }),
      );
      const top = entries.filter((entry) => entry.parentId === null).length;
      cli.print(c.dim(`\n${top} post(s), ${entries.length - top} repl(ies)`));
    });
};
