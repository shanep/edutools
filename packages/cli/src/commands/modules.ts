import type { Register } from "../cli";
import { printTable, str } from "../format";
import { selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("modules")
    .description(
      "List a course's modules and the items in each, in order.\n\n" +
        '--json emits each module with its items nested under "items", which is\n' +
        "how a module built by hand in Canvas gets read back into a repo.",
    )
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (courseArg: string | undefined, options: { json?: boolean }) => {
      const courseId = courseArg ?? (await selectCourse(cli));
      const canvas = await cli.canvas();
      const modules = await cli.status(`Fetching modules for course ${courseId}...`, async () => {
        const listed = await canvas.listModules(courseId);
        // Sequential on purpose: Canvas charges parallel requests a penalty.
        for (const module of listed) {
          module.items = await canvas.listModuleItems(courseId, str(module.id));
        }
        return listed;
      });

      if (options.json) {
        cli.json(modules);
        return;
      }
      if (modules.length === 0) {
        cli.print(cli.c.yellow("No modules found."));
        return;
      }

      const { c } = cli;
      printTable(
        cli,
        `Modules for Course ${courseId}`,
        [
          { name: "ID", align: "right", style: c.cyan },
          { name: "Module", style: c.green },
          { name: "State", style: c.dim },
          { name: "Items" },
        ],
        modules.map((module) => {
          const items = Array.isArray(module.items) ? module.items : [];
          const lines = items.map((item: Record<string, unknown>) => {
            const handle = item.content_id || item.page_url || "";
            return `${String(item.type ?? "").toLowerCase()} ${str(handle)}  ${str(item.title ?? "")}`;
          });
          return [
            str(module.id),
            str(module.name ?? ""),
            module.published ? "published" : "unpublished",
            lines.join("\n") || c.dim("empty"),
          ];
        }),
      );
      cli.print(c.dim(`\nTotal: ${modules.length} modules`));
    });
};
