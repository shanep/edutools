import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CourseError, courseOutline } from "@edutools/core/course";
import { DateConfigError } from "@edutools/core/dates";
import { formatG } from "@edutools/core/objects";
import { type OutlineModule, toJsonText } from "@edutools/core/outline";
import type { Register } from "../cli";
import { expandHome, printTable } from "../format";

export const register: Register = (program, cli) => {
  program
    .command("outline")
    .description(
      "Print the module outline a push will build, computed from the repo alone.\n\n" +
        "Needs no Canvas token. This is what the course website renders so that its\n" +
        "schedule shows exactly what Canvas shows under Modules: the same modules,\n" +
        "the same items in the same order, with the due date and points of each\n" +
        "gradable one. --out writes the JSON the site commits.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .option("--out <file>", "Write the JSON here instead of printing a table")
    .action((repo: string, options: { out?: string }) => {
      let modules: OutlineModule[];
      try {
        modules = courseOutline(expandHome(repo));
      } catch (error) {
        if (error instanceof CourseError || error instanceof DateConfigError) throw cli.fail(error.message);
        throw error;
      }

      const { c } = cli;
      if (options.out !== undefined) {
        const target = expandHome(options.out);
        mkdirSync(path.dirname(target), { recursive: true });
        // toJsonText, not JSON.stringify: course websites commit this file, and
        // it has to stay byte for byte what the Python version wrote.
        writeFileSync(target, `${toJsonText(modules)}\n`, "utf-8");
        cli.print(c.green(`✓ wrote ${target} (${modules.length} modules)`));
        return;
      }

      for (const module of modules) {
        printTable(
          cli,
          module.title,
          [{ name: "Kind", style: c.cyan }, { name: "Item", style: c.green }, { name: "Due", style: c.dim }, { name: "Points", align: "right" }],
          module.items.map((item) => [
            item.kind,
            item.title,
            item.dueAt ? item.dueAt.slice(0, 10) : "",
            item.points !== null ? formatG(item.points) : "",
          ]),
        );
      }
    });
};
