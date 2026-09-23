import { asNumber } from "@edutools/core/canvas";
import { formatG } from "@edutools/core/objects";
import type { Register } from "../cli";
import { printTable, str } from "../format";
import { selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("groups")
    .description("List a course's assignment groups, their weights, and what is in them.")
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (courseArg: string | undefined, options: { json?: boolean }) => {
      const courseId = courseArg ?? (await selectCourse(cli));
      const canvas = await cli.canvas();
      const [groups, course] = await cli.status(
        `Fetching assignment groups for course ${courseId}...`,
        async () => {
          const listed = await canvas.listAssignmentGroups(courseId, { withAssignments: true });
          return [listed, await canvas.getCourse(courseId)] as const;
        },
      );

      if (options.json) {
        cli.json(groups);
        return;
      }
      if (groups.length === 0) {
        cli.print(cli.c.yellow("No assignment groups found."));
        return;
      }

      const { c } = cli;
      const weighted = Boolean(course.apply_assignment_group_weights);
      let total = 0;
      const ordered = [...groups].sort((a, b) => asNumber(a.position) - asNumber(b.position));
      const rows = ordered.map((group) => {
        const weight = asNumber(group.group_weight);
        total += weight;
        const count = Array.isArray(group.assignments) ? group.assignments.length : 0;
        return [
          str(group.id),
          str(group.name ?? ""),
          weighted ? `${formatG(weight)}%` : c.dim("-"),
          count ? String(count) : c.dim("0"),
        ];
      });
      printTable(
        cli,
        `Assignment groups for course ${courseId}`,
        [
          { name: "ID", align: "right", style: c.cyan },
          { name: "Group", style: c.green },
          { name: "Weight", align: "right" },
          { name: "Items", align: "right" },
        ],
        rows,
      );
      if (weighted) {
        cli.print(c.dim(`Weights sum to ${formatG(total)}%`));
      } else {
        // Weights that are stored but not applied look like they took, and do nothing.
        cli.print(`${c.yellow("!")} this course does not weight the final grade by group`);
      }
    });
};
