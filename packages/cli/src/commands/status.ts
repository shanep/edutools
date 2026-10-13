import {
  CourseError,
  courseStatus,
  NEEDS_ATTENTION,
  type StatusItem,
  type StatusResult,
  type StatusState,
  UnmatchedPathError,
} from "@edutools/core/course";
import { pyRepr } from "@edutools/core/objects";
import { type Cli, CliExit, type Register } from "../cli";
import { expandHome, printTable, progressLine } from "../format";
import { collect } from "../options";

/** The order states are listed in: what needs a decision first. */
const ORDER: readonly StatusState[] = [
  "conflict",
  "canvas",
  "canvas-deleted",
  "unknown",
  "repo",
  "new",
  "repo-deleted",
  "in-sync",
];

/** What each state asks of the reader, printed under the table. */
const ADVICE: Readonly<Partial<Record<StatusState, string>>> = {
  conflict: "changed on both sides: decide which wins before pushing",
  canvas: "changed in Canvas: copy the change into the repo and run status --adopt, or a push overwrites it",
  "canvas-deleted": "deleted in Canvas: the next push recreates it unless the repo file goes too",
  unknown: "no baseline and the sides differ: check which is right, then push it or run status --adopt",
  repo: "changed in the repo: push to update Canvas (published ones need --update-published)",
  new: "never pushed: the next push creates it",
  "repo-deleted": "no longer in the repo: its Canvas object is left alone",
};

function changes(item: StatusItem): string {
  const parts: string[] = [];
  if (item.repo.length > 0) parts.push(`repo: ${item.repo.join(", ")}`);
  if (item.canvas.length > 0) parts.push(`canvas: ${item.canvas.join(", ")}`);
  if (item.unknown.length > 0) parts.push(`differs: ${item.unknown.join(", ")}`);
  if (item.detail) parts.push(item.detail);
  return parts.join("; ");
}

function counts(items: readonly StatusItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const state of ORDER) {
    const n = items.filter((item) => item.state === state).length;
    if (n > 0) out[state] = n;
  }
  return out;
}

function printStatus(cli: Cli, course: string, result: StatusResult, all: boolean): void {
  const { c } = cli;
  if (result.adopted > 0) cli.print(c.dim(`adopted Canvas as the baseline for ${result.adopted} object(s)`));
  if (result.drafts.length > 0) cli.print(c.dim(`draft, not compared: ${result.drafts.join(", ")}`));
  const shown = result.items
    .filter((item) => all || item.state !== "in-sync")
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  if (shown.length === 0) {
    cli.print(c.green(`\n✓ the repo and course ${course} are in sync: ${result.items.length} objects`));
    return;
  }
  const style = (state: StatusState, text: string): string =>
    state === "conflict" || state === "canvas-deleted"
      ? c.red(text)
      : state === "canvas" || state === "unknown"
        ? c.yellow(text)
        : state === "repo" || state === "new"
          ? c.green(text)
          : text;
  printTable(
    cli,
    `Repo vs course ${course}`,
    [{ name: "State" }, { name: "Object", style: c.cyan }, { name: "Changed" }, { name: "Published" }],
    shown.map((item) => [
      style(item.state, item.state),
      item.key,
      changes(item),
      item.published === null ? "" : item.published ? "yes" : "no",
    ]),
  );
  cli.print(`\n${pyRepr(counts(result.items))}`);
  for (const state of ORDER) {
    const advice = ADVICE[state];
    if (advice && shown.some((item) => item.state === state)) cli.print(`  ${style(state, state)}: ${advice}`);
  }
}

export const register: Register = (program, cli) => {
  program
    .command("status")
    .description(
      "Show which side changed since the repo and Canvas last agreed.\n\n" +
        "Every push records a baseline: a fingerprint of each part it wrote, from\n" +
        "the repo and from what Canvas stored. status fingerprints both sides again\n" +
        "and names the side that moved, part by part (body, settings, rubric,\n" +
        "questions, module items). Reads Canvas, never writes it.\n\n" +
        "A course pushed before baselines existed has none: --adopt records Canvas\n" +
        "as it is now as the baseline, and wherever the repo differs, the repo's\n" +
        "version counts as the change. It also marks a change copied from Canvas\n" +
        "into the repo by hand as synced, once both sides agree. --adopt writes\n" +
        "only the manifest, never Canvas.\n\n" +
        "Exits 1 when anything changed in Canvas, conflicts, was deleted in Canvas,\n" +
        "or differs with no baseline: the states that need a decision before the\n" +
        "next push.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .requiredOption("--course <id>", "Canvas course ID")
    .option("--path <file>", "Only these repo files, exact or glob, repeatable; leaves modules out", collect)
    .option("--adopt", "Record the baseline where there is none, or where both sides changed and now agree")
    .option("--all", "List objects that are in sync too")
    .option(
      "--json",
      "Emit {items: [{key, kind, title, state, repo, canvas, unknown, published, detail}], drafts, adopted} as JSON",
    )
    .action(
      async (repo: string, options: { course: string; path?: string[]; adopt?: boolean; all?: boolean; json?: boolean }) => {
        const canvas = await cli.canvas();
        let result: StatusResult;
        try {
          result = await cli.status("Comparing", (update) =>
            courseStatus(canvas, {
              repo: expandHome(repo),
              courseId: options.course,
              adopt: options.adopt ?? false,
              paths: options.path ?? [],
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
        const attention = result.items.some((item) => NEEDS_ATTENTION.has(item.state));
        if (options.json) {
          cli.json({
            items: result.items.map((item) => ({
              key: item.key,
              kind: item.kind,
              title: item.title,
              state: item.state,
              repo: item.repo,
              canvas: item.canvas,
              unknown: item.unknown,
              published: item.published,
              detail: item.detail,
            })),
            drafts: result.drafts,
            adopted: result.adopted,
          });
        } else {
          printStatus(cli, options.course, result, options.all ?? false);
        }
        if (attention) throw new CliExit(1);
      },
    );
};
