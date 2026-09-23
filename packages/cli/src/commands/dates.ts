import { type CourseDates, courseDates } from "@edutools/core/course";
import { DateConfigError, isoformat } from "@edutools/core/dates";
import { formatG } from "@edutools/core/objects";
import type { DateTime } from "luxon";
import { CliExit, type Register } from "../cli";
import { expandHome, printTable } from "../format";

/** strftime("%b %d %H:%M"), which is how the Python table showed a date. */
function stamp(value: DateTime): string {
  return value.toFormat("LLL dd HH:mm");
}

export const register: Register = (program, cli) => {
  program
    .command("dates")
    .description(
      "Generate every due / available-from / until date for a course.\n\n" +
        "Reads the term skeleton and per-type date policies from <repo>/canvas.toml and\n" +
        "derives the three Canvas date fields for every gradable item. --show needs no\n" +
        "Canvas token: it prints the whole semester so it can be reviewed before anything\n" +
        "is written. The dates reach Canvas when 'edutools push' writes the items.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .option("--show", "Print the generated schedule and exit")
    .option("--shift <days>", "Shift the whole term, e.g. '7d' or '-3d'")
    .option("--json", "Emit {items, problems} as JSON; exits 1 when there are problems")
    .action((repo: string, options: { show?: boolean; shift?: string; json?: boolean }) => {
      const { c } = cli;
      let shiftDays = 0;
      if (options.shift) {
        const match = /^(-?\d+)d$/.exec(options.shift.trim());
        if (!match) {
          throw cli.fail(`Bad --shift value '${options.shift}'; expected something like '7d' or '-3d'.`);
        }
        shiftDays = Number(match[1]);
      }

      let schedule: CourseDates;
      try {
        schedule = courseDates(expandHome(repo), { shiftDays });
      } catch (error) {
        if (error instanceof DateConfigError) throw cli.fail(`Date configuration error: ${error.message}`);
        throw error;
      }
      if (options.json) {
        cli.json({
          items: schedule.items.map((item) => ({
            path: item.path,
            title: item.title,
            kind: item.kind,
            week: item.week,
            points: item.points,
            unlock_at: item.unlockAt ? isoformat(item.unlockAt) : null,
            due_at: isoformat(item.dueAt),
            lock_at: isoformat(item.lockAt),
          })),
          problems: schedule.problems,
        });
        if (schedule.problems.length > 0) throw new CliExit(1);
        return;
      }
      if (options.shift) {
        cli.print(c.yellow(`Showing the term shifted by ${shiftDays >= 0 ? "+" : ""}${shiftDays} days.\n`));
      }

      const { config, items, problems } = schedule;
      printTable(
        cli,
        `${config.term.weeks}-week schedule, ${items.length} gradable items`,
        [
          { name: "Item", style: c.green },
          { name: "Type", style: c.cyan },
          { name: "Wk", align: "right" },
          { name: "Pts", align: "right", style: c.dim },
          { name: "Available from" },
          { name: "Due", style: c.bold },
          { name: "Until" },
        ],
        items.map((item) => [
          item.title,
          item.kind,
          item.week !== null ? String(item.week) : "-",
          formatG(item.points),
          item.unlockAt ? stamp(item.unlockAt) : "-",
          stamp(item.dueAt),
          stamp(item.lockAt),
        ]),
      );

      if (problems.length > 0) {
        cli.error(`\n${problems.length} problem(s):`);
        for (const problem of problems) cli.note(`  ${cli.e.red("•")} ${problem}`);
        throw new CliExit(1);
      }

      const total = items.reduce((sum, item) => sum + item.points, 0);
      cli.print(
        `\n${c.green("✓")} ${items.length} items · ${c.bold(`${formatG(total)} points`)} · ` +
          "dates consistent with the syllabus schedule",
      );
      if (!options.show) {
        cli.print(c.dim("This only prints. 'edutools push' writes these dates to Canvas with the items."));
      }
    });
};
