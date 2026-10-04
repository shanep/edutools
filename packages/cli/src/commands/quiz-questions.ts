import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseQuestions,
  type Question,
  QuizQuestionsError,
  type ReplaceResult,
  replaceQuizQuestions,
} from "@edutools/core/quiz-questions";
import { CliExit, type Register } from "../cli";
import { expandHome, messageOf } from "../format";
import { collect, isFile } from "../options";

interface Options {
  course: string;
  fromFile: string;
  removeGroup?: string[];
  folder?: string;
  updatePublished?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("quiz-questions")
    .description(
      "Replace every question in one classic quiz with the ones in a JSON file.\n\n" +
        "For a quiz a course repository does not manage, such as an exam built by\n" +
        "hand. The file is a list of questions in the shape the quiz questions API\n" +
        "returns (and pull writes to .questions.json), so every question type works:\n\n" +
        '    [{"question_name": "1.3-1", "question_type": "multiple_choice_question",\n' +
        '      "points_possible": 2, "question_text": "<p>...</p><img src=\\"img/1.3-1.png\\">",\n' +
        '      "answers": [{"answer_text": "70", "answer_weight": 100},\n' +
        '                  {"answer_text": "20", "answer_weight": 0}]}]\n\n' +
        "An <img> with a relative src is read from beside the file, uploaded to a\n" +
        "hidden course folder and relinked. --remove-group deletes a question group,\n" +
        "such as a draw from a question bank, in the same run. A published quiz is\n" +
        "only rebuilt with --update-published.",
    )
    .argument("<quiz_id>", "Classic quiz ID")
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .requiredOption("--from-file <path>", "The questions, as JSON")
    .option("--remove-group <id>", "Delete this question group from the quiz (repeatable)", collect)
    .option("--folder <path>", "Course folder for the images, kept hidden (default: quiz images/<quiz_id>)")
    .option("--update-published", "Rebuild the quiz even though students can see it")
    .option("--dry-run", "Check everything and show the plan; write nothing")
    .option("--json", "Emit the result as JSON")
    .action(async (quizId: string, options: Options) => {
      const file = expandHome(options.fromFile);
      if (!isFile(file)) throw cli.fail(`no such file: ${file}`, 2);
      let questions: Question[];
      try {
        questions = parseQuestions(readFileSync(file, "utf-8"));
      } catch (error) {
        if (error instanceof QuizQuestionsError) throw cli.fail(`${file}: ${error.message}`, 2);
        throw error;
      }

      const canvas = await cli.canvas();
      let result: ReplaceResult;
      try {
        result = await cli.status("Reading the quiz", (update) =>
          replaceQuizQuestions(canvas, options.course, quizId, questions, {
            baseDir: path.dirname(file),
            folder: options.folder ?? `quiz images/${quizId}`,
            removeGroups: options.removeGroup ?? [],
            updatePublished: options.updatePublished ?? false,
            dryRun: options.dryRun ?? false,
            report: update,
          }),
        );
      } catch (error) {
        throw cli.fail(`quiz ${quizId}: ${messageOf(error)}`);
      }

      const short =
        result.check !== null &&
        (result.check.questions !== result.created || result.check.points !== result.points);
      if (options.json) {
        cli.json(result);
        if (short) throw new CliExit(1);
        return;
      }

      const { c } = cli;
      const verb = result.dryRun ? "Would replace" : "Replaced";
      cli.print(`${c.bold(verb)} the questions in ${c.cyan(result.title || quizId)}${result.published ? " (published)" : ""}:`);
      cli.print(`  remove ${result.replaced} question(s)`);
      for (const group of result.groups) {
        const bank = group.bankId ? ` from bank ${group.bankId}` : "";
        cli.print(`  remove group ${group.id} ${c.dim(`"${group.name}", picks ${group.pickCount}${bank}`)}`);
      }
      cli.print(`  add ${result.created} question(s), ${result.points} point(s)`);
      cli.print(`  ${result.upload.length} image(s) ${result.dryRun ? "to upload" : "uploaded"}`);
      for (const url of result.remote) cli.note(c.yellow(`  ! image still on another server: ${url}`));
      if (result.dryRun) {
        cli.print(c.dim("\nDry run: nothing was written."));
        return;
      }
      if (result.check !== null) {
        const line = `Canvas now reports ${result.check.questions} question(s), ${result.check.points} point(s)`;
        if (short) {
          cli.error(line);
          throw new CliExit(1);
        }
        cli.print(`${c.green("✓")} ${line}`);
      }
    });
};
