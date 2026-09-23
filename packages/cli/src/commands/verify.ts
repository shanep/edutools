import { CourseError, type VerifyResult, verifyCourse } from "@edutools/core/course";
import { pyRepr } from "@edutools/core/objects";
import { summarise } from "@edutools/core/verify";
import { type Cli, CliExit, type Register } from "../cli";
import { expandHome, printTable, progressLine } from "../format";

/** Print a verify result; true when everything checked out. Shared with push. */
export function printVerify(cli: Cli, result: VerifyResult): boolean {
  const { c } = cli;
  if (result.drafts.length > 0) cli.print(c.dim(`draft, not verified: ${result.drafts.join(", ")}`));
  if (result.failures.length === 0) {
    cli.print(c.green(`\n✓ all ${result.checked} objects verified against Canvas`));
    return true;
  }
  printTable(
    cli,
    "Verification failures",
    [{ name: "Object", style: c.cyan }, { name: "Check", style: c.yellow }, { name: "Detail" }],
    result.failures.slice(0, 60).map((f) => [f.key, f.check, f.detail]),
  );
  cli.error(`\n${result.failures.length} failure(s): ${pyRepr(summarise(result.failures))}`);
  return false;
}

export const register: Register = (program, cli) => {
  program
    .command("verify")
    .description(
      "Read every published object back from Canvas and prove it arrived intact.\n\n" +
        "Catches what a 200 response does not: silent sanitiser stripping, partial\n" +
        "quiz writes, files stuck pending, and drift from someone editing in the\n" +
        "Canvas UI. Exits 1 when anything failed.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .requiredOption("--course <id>", "Canvas course ID")
    .option("--json", "Emit {checked, drafts, failures: [{key, check, detail}]} as JSON")
    .action(async (repo: string, options: { course: string; json?: boolean }) => {
      const canvas = await cli.canvas();
      let result: VerifyResult;
      try {
        result = await cli.status("Verifying", (update) =>
          verifyCourse(canvas, {
            repo: expandHome(repo),
            courseId: options.course,
            progress: (p) => update(progressLine(p)),
          }),
        );
      } catch (error) {
        if (error instanceof CourseError) throw cli.fail(error.message);
        throw error;
      }
      if (options.json) {
        cli.json({
          checked: result.checked,
          drafts: result.drafts,
          failures: result.failures.map((f) => ({ key: f.key, check: f.check, detail: f.detail })),
        });
        if (result.failures.length > 0) throw new CliExit(1);
        return;
      }
      if (!printVerify(cli, result)) throw new CliExit(1);
    });
};
