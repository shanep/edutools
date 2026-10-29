import {
  CourseError,
  courseStatus,
  NEEDS_ATTENTION,
  type StatusItem,
  type StatusResult,
  type StatusState,
  UnmatchedPathError,
} from "@edutools/core/course";
import { type Cli, CliExit, type Register } from "../cli";
import { expandHome, progressLine } from "../format";
import { collect } from "../options";

type Colors = Cli["c"];

/**
 * The sections status prints, in the order git status would: what needs a
 * decision first, then what Canvas has to give the repo, then what the repo has
 * to give Canvas.
 */
interface Section {
  readonly heading: string;
  readonly states: readonly StatusState[];
  readonly color: (c: Colors, text: string) => string;
  /** The hints under the heading, given the items it holds. */
  readonly hints: (items: readonly StatusItem[], repo: string, course: string) => string[];
}

const SECTIONS: readonly Section[] = [
  {
    heading: "Changed on both sides:",
    states: ["conflict"],
    color: (c, text) => c.red(text),
    hints: (_, repo, course) => [
      `use "edutools diff ${repo} --course ${course} --path <file>" to compare them`,
      "decide which side wins before pushing",
    ],
  },
  {
    heading: "Changes in Canvas to pull into the repo:",
    states: ["canvas", "canvas-deleted"],
    color: (c, text) => c.yellow(text),
    hints: (items, repo, course) => [
      `use "edutools diff ${repo} --course ${course} --path <file>" to see what changed`,
      `copy it into the repo, then run "edutools status ${repo} --course ${course} --adopt"; a push overwrites it`,
      ...(items.some((item) => item.state === "canvas-deleted")
        ? ["a deleted one comes back on the next push unless its repo file goes too"]
        : []),
    ],
  },
  {
    heading: "Changes in the repo to push to Canvas:",
    states: ["repo", "new"],
    color: (c, text) => c.green(text),
    hints: (items, repo, course) => [
      `use "edutools push ${repo} --course ${course}" to update Canvas`,
      ...(items.some((item) => item.published === true) ? ["published ones also need --update-published"] : []),
    ],
  },
  {
    heading: "Differs, with no baseline to say which side moved:",
    states: ["unknown"],
    color: (c, text) => c.yellow(text),
    hints: (_, repo, course) => [
      `check which side is right, then push it or run "edutools status ${repo} --course ${course} --adopt"`,
    ],
  },
  {
    heading: "Gone from the repo, left alone in Canvas:",
    states: ["repo-deleted"],
    color: (_, text) => text,
    hints: () => [],
  },
  {
    heading: "In sync:",
    states: ["in-sync"],
    color: (c, text) => c.dim(text),
    hints: () => [],
  },
];

const LABELS: Readonly<Record<StatusState, string>> = {
  conflict: "both modified:",
  canvas: "modified:",
  "canvas-deleted": "deleted:",
  repo: "modified:",
  new: "new:",
  unknown: "differs:",
  "repo-deleted": "deleted:",
  "in-sync": "in sync:",
};

const LABEL_WIDTH = 16;

/** The parts that moved, after the key: one side's for most states, both for a conflict. */
function parts(item: StatusItem): string {
  const moved = [...item.repo, ...item.canvas, ...item.unknown];
  const named =
    item.state === "conflict"
      ? [`repo: ${item.repo.join(", ")}`, `canvas: ${item.canvas.join(", ")}`]
      : moved.length > 0
        ? [moved.join(", ")]
        : [];
  if (item.detail) named.push(item.detail);
  return named.length > 0 ? ` (${named.join("; ")})` : "";
}

function printSection(cli: Cli, heading: string, hints: readonly string[], lines: readonly string[]): void {
  cli.print(`\n${heading}`);
  for (const hint of hints) cli.print(`  (${hint})`);
  for (const line of lines) cli.print(`\t${line}`);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function printStatus(cli: Cli, repo: string, course: string, result: StatusResult, all: boolean): void {
  const { c } = cli;
  cli.print(`On course ${course}, repo ${repo}`);
  if (result.adopted > 0) cli.print(c.dim(`adopted Canvas as the baseline for ${result.adopted} object(s)`));
  if (result.upgraded > 0) cli.print(c.dim(`upgraded the baseline of ${result.upgraded} object(s) to this edutools`));
  if (result.drafts.length > 0) cli.print(c.dim(`draft, not compared: ${result.drafts.join(", ")}`));

  const count = (states: readonly StatusState[]): number =>
    result.items.filter((item) => states.includes(item.state)).length;
  const toPull = count(["canvas", "canvas-deleted"]);
  const toPush = count(["repo", "new"]);
  const both = count(["conflict"]);
  const summary = [
    toPull > 0 ? `${plural(toPull, "change", "changes")} to pull from Canvas` : "",
    toPush > 0 ? `${plural(toPush, "change", "changes")} to push from the repo` : "",
    both > 0 ? `${plural(both, "object", "objects")} changed on both sides` : "",
  ].filter(Boolean);
  if (summary.length > 0) cli.print(`${summary.join(", ")}.`);

  for (const section of SECTIONS) {
    if (section.states.includes("in-sync") && !all) continue;
    const items = result.items.filter((item) => section.states.includes(item.state));
    if (items.length === 0) continue;
    const lines = items.map((item) => {
      const published = section.states.includes("repo") && item.published === true ? c.dim(" [published]") : "";
      return section.color(c, `${LABELS[item.state].padEnd(LABEL_WIDTH)}${item.key}`) + parts(item) + published;
    });
    printSection(cli, section.heading, section.hints(items, repo, course), lines);
  }

  if (result.untracked.length > 0) {
    const lines = result.untracked.map((d) => {
      const ident = d.ident && d.ident !== d.title ? c.dim(` ${d.ident}`) : "";
      return c.red(`${`${d.kind}:`.padEnd(LABEL_WIDTH)}${d.title}`) + ident;
    });
    printSection(
      cli,
      "Only in Canvas, not in the repo:",
      ["write it into the repo to track it, or list it under [clean] keep in canvas.toml"],
      lines,
    );
  }

  const pending = result.items.some((item) => item.state !== "in-sync");
  if (!pending) {
    const objects = plural(result.items.length, "object", "objects");
    cli.print(
      result.untracked.length > 0
        ? `\nnothing to push or pull in the ${objects} the repo tracks`
        : c.green(`\nnothing to push or pull: the repo and course ${course} are in sync, ${objects}`),
    );
  }
}

export const register: Register = (program, cli) => {
  program
    .command("status")
    .description(
      "Show what to pull from Canvas and what to push from the repo, like git status.\n\n" +
        "Every push records a baseline: a fingerprint of each part it wrote, from\n" +
        "the repo and from what Canvas stored. status fingerprints both sides again\n" +
        "and names the side that moved, part by part (body, settings, rubric,\n" +
        "questions, module items), grouped the way git status groups them: changed\n" +
        "on both sides, changes in Canvas to pull into the repo, changes in the repo\n" +
        "to push. It also lists what is only in Canvas: a page written in the editor,\n" +
        "a quiz built by hand. Reads Canvas, never writes it.\n\n" +
        "A course pushed before baselines existed has none: --adopt records Canvas\n" +
        "as it is now as the baseline, and wherever the repo differs, the repo's\n" +
        "version counts as the change. It also marks a change copied from Canvas\n" +
        "into the repo by hand as synced, once both sides agree. --adopt writes\n" +
        "only the manifest, never Canvas.\n\n" +
        "Exits 1 when anything changed in Canvas, conflicts, was deleted in Canvas,\n" +
        "or differs with no baseline: the states that need a decision before the\n" +
        "next push. An object only in Canvas does not, since a quiz built by hand\n" +
        "is expected.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .requiredOption("--course <id>", "Canvas course ID")
    .option("--path <file>", "Only these repo files, exact or glob, repeatable; leaves modules and Canvas-only objects out", collect)
    .option("--adopt", "Record the baseline where there is none, or where both sides changed and now agree")
    .option("--all", "List objects that are in sync too")
    .option(
      "--json",
      "Emit {items: [{key, kind, title, state, repo, canvas, unknown, published, detail}], untracked: [{kind, ident, title, detail}], drafts, adopted, upgraded} as JSON",
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
            untracked: result.untracked.map((d) => ({ kind: d.kind, ident: d.ident, title: d.title, detail: d.detail })),
            drafts: result.drafts,
            adopted: result.adopted,
            upgraded: result.upgraded,
          });
        } else {
          printStatus(cli, repo, options.course, result, options.all ?? false);
        }
        if (attention) throw new CliExit(1);
      },
    );
};
