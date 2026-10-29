import { CourseError, courseDiff, type DiffItem, type DiffResult, UnmatchedPathError } from "@edutools/core/course";
import type { DiffLine } from "@edutools/core/diff";
import { pyRepr } from "@edutools/core/objects";
import { type Cli, CliExit, type Register } from "../cli";
import { expandHome, progressLine } from "../format";
import { collect } from "../options";

function printItem(cli: Cli, course: string, item: DiffItem): void {
  const { c } = cli;
  cli.print(c.bold(`--- repo ${item.key}`));
  cli.print(c.bold(`+++ course ${course} ${item.kind} ${pyRepr(item.canvasTitle)}`));
  if (item.canvasTitle !== item.title) {
    cli.print(c.cyan("@@ title @@"));
    cli.print(c.red(`-${item.title}`));
    cli.print(c.green(`+${item.canvasTitle}`));
  }
  const style = (line: DiffLine): string =>
    line.op === "-" ? c.red(`-${line.text}`) : line.op === "+" ? c.green(`+${line.text}`) : ` ${line.text}`;
  for (const hunk of item.hunks) {
    cli.print(c.cyan(`@@ -${hunk.repoStart},${hunk.repoCount} +${hunk.canvasStart},${hunk.canvasCount} @@`));
    for (const line of hunk.lines) cli.print(style(line));
  }
  cli.print("");
}

function printDiff(cli: Cli, course: string, result: DiffResult): void {
  const { c } = cli;
  if (result.missing.length > 0) cli.print(c.dim(`not in Canvas, not compared: ${result.missing.join(", ")}`));
  for (const item of result.items) printItem(cli, course, item);
  if (result.items.length === 0) {
    cli.print(c.green(`✓ the repo and course ${course} agree: ${result.compared} objects compared`));
  } else {
    cli.print(c.yellow(`${result.items.length} of ${result.compared} objects differ (- repo, + Canvas)`));
  }
}

export const register: Register = (program, cli) => {
  program
    .command("diff")
    .description(
      "Show what differs between the repo and Canvas, line by line.\n\n" +
        "Renders each repo file as a push would and diffs it against the body Canvas\n" +
        "stores, with the repo as - and Canvas as +. Bodies are compared as readable\n" +
        "lines, one per paragraph, heading, list item or table row, with links and\n" +
        "images written the markdown way, so a Canvas edit reads as the markdown\n" +
        "change that would copy it back. --markup diffs the HTML instead, a tag per\n" +
        "line, for changes the text cannot show (a style, a class). Titles are\n" +
        "compared too. Files and modules are not: status covers them.\n\n" +
        "Reads Canvas, never writes it. Exits 1 when anything differs, like diff(1).",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .requiredOption("--course <id>", "Canvas course ID")
    .option("--path <file>", "Only these repo files, exact or glob, repeatable", collect)
    .option("--markup", "Diff the HTML, a tag per line, instead of the readable text")
    .option("-U, --context <lines>", "Unchanged lines shown around each change", "3")
    .option(
      "--json",
      "Emit {items: [{key, kind, title, canvasTitle, hunks: [{repoStart, repoCount, canvasStart, canvasCount, lines: [{op, text}]}]}], compared, missing} as JSON",
    )
    .action(
      async (
        repo: string,
        options: { course: string; path?: string[]; markup?: boolean; context: string; json?: boolean },
      ) => {
        const context = Number(options.context);
        if (!Number.isInteger(context) || context < 0) throw cli.fail(`--context must be a whole number, got ${options.context}`, 2);
        const canvas = await cli.canvas();
        let result: DiffResult;
        try {
          result = await cli.status("Comparing", (update) =>
            courseDiff(canvas, {
              repo: expandHome(repo),
              courseId: options.course,
              paths: options.path ?? [],
              markup: options.markup ?? false,
              context,
              progress: (p) => update(progressLine(p)),
            }),
          );
        } catch (error) {
          if (error instanceof UnmatchedPathError) {
            cli.error(error.message);
            cli.print(cli.c.dim("available:"));
            for (const key of error.available) cli.print(`  ${cli.c.dim(key)}`);
            throw new CliExit(1);
          }
          if (error instanceof CourseError) throw cli.fail(error.message);
          throw error;
        }
        if (options.json) cli.json(result);
        else printDiff(cli, options.course, result);
        if (result.items.length > 0) throw new CliExit(1);
      },
    );
};
