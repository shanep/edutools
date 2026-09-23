import {
  type CleanPlan,
  CleanFailedError,
  CleanRefusedError,
  CourseError,
  type CourseCanvas,
  type PushResult,
  planClean,
  push,
  UnmatchedPathError,
  writePreview,
} from "@edutools/core/course";
import { pyRepr } from "@edutools/core/objects";
import { type Cli, CliExit, type Register } from "../cli";
import { expandHome, markup, printTable, progressLine } from "../format";
import { collect } from "../options";
import { printVerify } from "./verify";

interface Options {
  course: string;
  dryRun?: boolean;
  publish?: boolean;
  updatePublished?: boolean;
  only?: string[];
  path?: string[];
  verify?: boolean;
  preview?: string;
  clean?: boolean;
  yes?: boolean;
}

function printRefusals(cli: Cli, refused: CleanRefusedError["refused"], message: string): never {
  for (const { target, reason } of refused) {
    cli.error(`refusing: ${target.kind} ${pyRepr(target.title)} (${target.ident}) ${reason}`);
  }
  cli.error(message);
  throw new CliExit(1);
}

/**
 * The start-of-term clean sync, up to the point of deleting: show the plan,
 * refuse if it holds student work, and ask. Resolves to the approved plan, or
 * null when there is nothing to do or it is a dry run.
 */
async function cleanStep(cli: Cli, canvas: CourseCanvas, repo: string, options: Options): Promise<CleanPlan | null> {
  const { c } = cli;
  let plan: CleanPlan;
  try {
    plan = await cli.status("Reading the course", (update) =>
      planClean(canvas, { repo, courseId: options.course, progress: (p) => update(progressLine(p)) }),
    );
  } catch (error) {
    if (error instanceof CourseError) throw cli.fail(error.message);
    throw error;
  }

  if (plan.targets.length > 0 || plan.stale.length > 0) {
    printTable(
      cli,
      `Clean sync of course ${options.course}`,
      [{ name: "Action" }, { name: "Kind", style: c.cyan }, { name: "Title" }, { name: "Id", style: c.dim }],
      [
        ...plan.targets.map((t) => [c.red("delete"), t.kind, t.title, t.ident]),
        ...plan.stale.map((s) => [c.yellow("forget"), s.kind, s.title, s.key]),
      ],
    );
  }
  cli.print(c.dim(`kept: ${plan.kept} native or [clean] keep item(s), the front page, and every course file`));

  if (plan.refused.length > 0) printRefusals(cli, plan.refused, new CleanRefusedError(plan.refused).message);
  if (plan.targets.length === 0 && plan.stale.length === 0) {
    cli.print(c.green("✓ nothing to clean: Canvas holds only what the repo put there"));
    return null;
  }
  if (options.dryRun) {
    cli.print(c.yellow(`dry run: would delete ${plan.targets.length} and forget ${plan.stale.length}`));
    return null;
  }
  if (!options.yes) {
    const question = `Delete these ${plan.targets.length} object(s) from course ${options.course}? This cannot be undone`;
    if (!(await cli.confirm(question))) {
      cli.error("Aborted!");
      throw new CliExit(1);
    }
  }
  return plan;
}

function report(cli: Cli, result: PushResult, options: Options): void {
  const { c } = cli;
  if (result.clean !== null) {
    cli.print(
      c.green(
        `✓ deleted ${result.clean.deleted.length}, forgot ${result.clean.forgotten.length} stale manifest entr(ies)`,
      ),
    );
  }
  if (result.drafts.length > 0) cli.print(c.dim(`draft, not pushed: ${result.drafts.join(", ")}`));
  for (const orphan of result.orphanedDrafts) {
    cli.print(
      c.yellow(
        `${orphan} is now a draft; its Canvas object is no longer tracked and has to be deleted by hand if it still exists`,
      ),
    );
  }
  if (result.droppedCss.length > 0) {
    cli.print(
      `${c.yellow(`⚠ ${result.droppedCss.length} CSS properties are not on Canvas's allowlist and were dropped:`)} ` +
        result.droppedCss.join(", "),
    );
  }
  if (result.unlisted.length > 0) {
    cli.print(
      `${c.yellow("!")} ${result.unlisted.length} gradable item(s) in no [[module]]; ` +
        "students find their work through modules:",
    );
    for (const key of result.unlisted) cli.print(`    ${c.dim(key)}`);
  }

  printTable(
    cli,
    "Canvas push",
    [{ name: "Outcome", style: c.cyan }, { name: "Count", align: "right" }],
    [
      ["created", String(result.created)],
      ["updated", String(result.updated)],
      ["skipped", String(result.skipped)],
    ],
  );

  if (result.problems.length > 0) {
    cli.error(`\n${result.problems.length} problem(s):`);
    for (const problem of result.problems.slice(0, 40)) cli.note(`  ${cli.e.red("•")} ${problem}`);
    throw new CliExit(1);
  }

  if (options.preview) {
    const dir = expandHome(options.preview);
    const written = writePreview(result.rendered, dir);
    cli.print(`${c.green("✓")} wrote ${written} preview pages to ${dir}`);
  }

  if (result.dryRun) {
    cli.print(`\n${c.green("✓")} dry run: nothing was written to Canvas.`);
    return;
  }

  cli.print(
    `\n${c.green("✓")} pushed to course ${options.course} ` +
      (result.publish
        ? "(published)"
        : `(${c.bold("new objects unpublished")}; existing visibility unchanged)`),
  );
  if (result.protected.length > 0) {
    cli.print(
      `${c.yellow("!")} left ${result.protected.length} published object(s) untouched; ` +
        "--update-published overwrites them:",
    );
    for (const key of result.protected) cli.print(`    ${c.dim(key)}`);
  }
  if (result.verify !== null && !printVerify(cli, result.verify)) throw new CliExit(1);
}

export const register: Register = (program, cli) => {
  program
    .command("push")
    .description(
      "Publish a course repository to Canvas.\n\n" +
        "Two passes: create or update every object, then rewrite relative links now\n" +
        "that ids exist. Everything is created UNPUBLISHED unless --publish is given.\n\n" +
        "Anything already published is left alone, because rewriting what a class is\n" +
        "part-way through reading is worse than leaving it stale. Pass\n" +
        "--update-published to overwrite it anyway.\n\n" +
        "To push one correction rather than the whole course, name it with --path:\n\n" +
        "    edutools push ./cs425 --course 48194 --path assignments/p1.md\n\n" +
        "--path takes a repo-relative path or a glob and is repeatable. It runs the\n" +
        "same pipeline the full push does, so dates, links, rubric and styling all\n" +
        "still come from the repository. Whole-course module rebuilding is skipped,\n" +
        "since that is a structural change rather than a correction.\n\n" +
        "--clean is for the start of a term, on a course copied from a shell or from\n" +
        "last term. It deletes every page, assignment, discussion, quiz and module\n" +
        "the repo does not own (keeping course files, the front page, the native\n" +
        "items [[module]] tables name, and anything under [clean] keep), refuses if\n" +
        "any of it holds student work, asks first, and then pushes everything with\n" +
        "--update-published. With --dry-run it lists what it would delete.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .requiredOption("--course <id>", "Canvas course ID")
    .option("--dry-run", "Render everything, write nothing")
    .option("--publish", "Make objects student-visible (default: unpublished)")
    .option("--update-published", "Also rewrite content students can already see (default: skip it)")
    .option(
      "--only <group>",
      "Limit to: pages, assignments, discussions, quizzes, files, modules, syllabus, rubrics, groups",
      collect,
    )
    .option("--path <file>", "Limit to specific repo files, exact or glob, repeatable", collect)
    .option("--verify", "Read everything back from Canvas afterwards (the default)")
    .option("--no-verify", "Skip the read-back")
    .option("--preview <dir>", "Write the rendered HTML to a directory and open nothing else")
    .option("--clean", "Start of term: first delete everything the repo does not own, then rewrite all of it")
    .option("-y, --yes", "With --clean, skip the confirmation prompt")
    .action(async (repoArg: string, options: Options) => {
      const repo = expandHome(repoArg);
      if (options.clean && ((options.only ?? []).length > 0 || (options.path ?? []).length > 0)) {
        throw cli.fail("--clean syncs the whole course; it cannot be combined with --only or --path");
      }

      // A dry run needs no token, unless a clean sync has to read the course.
      const canvas = !options.dryRun || options.clean ? await cli.canvas() : null;
      const clean = options.clean && canvas !== null ? await cleanStep(cli, canvas, repo, options) : null;

      let result: PushResult;
      try {
        result = await cli.status(options.dryRun ? "Rendering" : "Publishing", (update) =>
          push(options.dryRun ? null : canvas, {
            repo,
            courseId: options.course,
            dryRun: options.dryRun,
            publish: options.publish,
            // A clean sync is the one time everything is rewritten: the course
            // is about to start, so nothing in it is being read yet.
            updatePublished: options.updatePublished || options.clean,
            only: options.only,
            paths: options.path,
            verify: options.verify,
            clean,
            report: (line) => cli.print(markup(cli.c, line)),
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
        if (error instanceof CleanRefusedError) printRefusals(cli, error.refused, error.message);
        if (error instanceof CleanFailedError || error instanceof CourseError) throw cli.fail(error.message);
        throw error;
      }
      report(cli, result, options);
    });
};
