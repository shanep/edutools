import { summarise } from "@edutools/core/audit";
import { type AuditResult, auditCourse, CourseError } from "@edutools/core/course";
import { pyRepr } from "@edutools/core/objects";
import { CliExit, type Register } from "../cli";
import { expandHome, printTable, progressLine } from "../format";

export const register: Register = (program, cli) => {
  program
    .command("audit")
    .description(
      "Compare the manifest with what the course actually contains, both ways.\n\n" +
        "verify proves that every tracked object is still there and intact. This is\n" +
        "the other question: what is in Canvas that the repo did not put there, and\n" +
        "what does the manifest still track that Canvas no longer has. Exits non-zero\n" +
        "only for the second kind, because a hand-built exam quiz is expected and a\n" +
        "manifest pointing at nothing is not.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .requiredOption("--course <id>", "Canvas course ID")
    .option("--json", "Emit the differences as JSON")
    .action(async (repo: string, options: { course: string; json?: boolean }) => {
      const canvas = await cli.canvas();
      let result: AuditResult;
      try {
        result = await cli.status("Reading the course", (update) =>
          auditCourse(canvas, {
            repo: expandHome(repo),
            courseId: options.course,
            progress: (p) => update(progressLine(p)),
          }),
        );
      } catch (error) {
        if (error instanceof CourseError) throw cli.fail(error.message);
        throw error;
      }
      const stale = result.stale.length > 0;

      if (options.json) {
        // The Python field names and order, which is what a caller parses.
        cli.json(
          result.differences.map((d) => ({
            side: d.side,
            kind: d.kind,
            ident: d.ident,
            title: d.title,
            key: d.key,
            detail: d.detail,
          })),
        );
        if (stale) throw new CliExit(1);
        return;
      }

      const { c } = cli;
      if (result.differences.length === 0) {
        cli.print(
          c.green(
            `\n✓ the manifest and course ${options.course} agree: ` +
              `${result.tracked} tracked objects, nothing untracked`,
          ),
        );
        return;
      }

      const rowStyle = (side: string, text: string): string =>
        side === "stale" ? c.red(text) : side === "pending" ? c.green(text) : text;
      printTable(
        cli,
        `Manifest vs course ${options.course}`,
        [
          { name: "Side" },
          { name: "Kind" },
          { name: "Title" },
          { name: "Id" },
          { name: "Repo key" },
          { name: "Detail" },
        ],
        result.differences.map((d) =>
          [d.side, d.kind, d.title, d.ident, d.key, d.detail].map((cell) => rowStyle(d.side, cell)),
        ),
      );
      cli.print(`\n${result.differences.length} difference(s): ${pyRepr(summarise(result.differences))}`);
      if (stale) {
        cli.error("stale entries: the manifest tracks objects Canvas no longer has");
        throw new CliExit(1);
      }
    });
};
