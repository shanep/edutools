/**
 * Replace the questions in one classic quiz with a set read from a JSON file.
 *
 * `push` builds the questions of a quiz the repo owns, from markdown, and only
 * knows multiple choice, multiple answer and true/false. This is the other half:
 * a hand built quiz (an exam behind LockDown Browser, say) whose questions are
 * written as Canvas stores them, so any question type works, including matching
 * and short answer. The file is a list in the shape the quiz questions API
 * returns, which is also what `pull` writes to `.questions.json`.
 *
 * An `<img>` whose src is a relative path is uploaded to a hidden course folder
 * and relinked, so a quiz never depends on someone else's server. A question
 * group that draws from a bank can be removed in the same run, which is how a
 * quiz moves from a random draw to a fixed set.
 *
 * Canvas freezes a published quiz's question set, so a published quiz is
 * unpublished, rebuilt and published again, and only with `updatePublished`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { asNumber, type CanvasLMS } from "./canvas";
import type { Payload } from "./types";

export type Reporter = (message: string) => void;

/** The client methods a replacement calls, so a test can hand in a plain object. */
export type QuizQuestionsCanvas = Pick<
  CanvasLMS,
  | "getQuiz"
  | "updateQuiz"
  | "listQuizQuestions"
  | "createQuizQuestion"
  | "deleteQuizQuestion"
  | "getQuizGroup"
  | "deleteQuizGroup"
  | "listFolders"
  | "createFolder"
  | "updateFolder"
  | "uploadFile"
>;

/** Raised when the question file or the request cannot be used as given. */
export class QuizQuestionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizQuestionsError";
  }
}

export const QUESTION_TYPES: readonly string[] = [
  "multiple_choice_question",
  "true_false_question",
  "short_answer_question",
  "fill_in_multiple_blanks_question",
  "multiple_answers_question",
  "multiple_dropdowns_question",
  "matching_question",
  "numerical_question",
  "calculated_question",
  "essay_question",
  "file_upload_question",
  "text_only_question",
];

// The fields sent for a question and for each answer. Anything else in the file
// (an id, a quiz_id, a position from a pull) is Canvas's bookkeeping and is left
// behind, so a pulled file can be sent back as it is.
const QUESTION_KEYS: readonly string[] = [
  "question_name",
  "question_text",
  "question_type",
  "points_possible",
  "correct_comments",
  "incorrect_comments",
  "neutral_comments",
  "correct_comments_html",
  "incorrect_comments_html",
  "neutral_comments_html",
  "matching_answer_incorrect_matches",
  "text_after_answers",
];

// answer_weight goes first, and every answer has one. Answers are sent as
// repeated question[answers][][...] keys, and Rails starts a new answer at a key
// the current one already has, so a key every answer leads with keeps them apart.
const ANSWER_KEYS: readonly string[] = [
  "answer_weight",
  "answer_text",
  "answer_html",
  "answer_comments",
  "answer_comments_html",
  "answer_match_left",
  "answer_match_right",
  "blank_id",
  "numerical_answer_type",
  "exact",
  "margin",
  "approximate",
  "precision",
  "start",
  "end",
];

const HTML_KEYS: readonly string[] = [
  "question_text",
  "correct_comments_html",
  "incorrect_comments_html",
  "neutral_comments_html",
];
const ANSWER_HTML_KEYS: readonly string[] = ["answer_html", "answer_comments_html"];

const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

export interface Answer {
  readonly [key: string]: string;
}

export interface Question {
  readonly fields: Readonly<Record<string, string>>;
  readonly answers: readonly Answer[];
}

function isRecord(value: unknown): value is Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function pick(source: Payload, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = scalar(source[key]);
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

/** Read a question file: a JSON list of questions as the quiz questions API returns them. */
export function parseQuestions(text: string): Question[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new QuizQuestionsError(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(data)) throw new QuizQuestionsError("expected a JSON list of questions");
  if (data.length === 0) throw new QuizQuestionsError("the file has no questions");

  return data.map((raw, index) => {
    const where = `question ${index + 1}`;
    if (!isRecord(raw)) throw new QuizQuestionsError(`${where} is not an object`);
    const fields = pick(raw, QUESTION_KEYS);
    const type = fields.question_type;
    if (type === undefined || !QUESTION_TYPES.includes(type)) {
      throw new QuizQuestionsError(`${where} has question_type ${JSON.stringify(raw.question_type)}`);
    }
    if (!fields.question_text) throw new QuizQuestionsError(`${where} has no question_text`);
    if (fields.points_possible !== undefined && !Number.isFinite(Number(fields.points_possible))) {
      throw new QuizQuestionsError(`${where} has points_possible ${JSON.stringify(raw.points_possible)}`);
    }
    const rawAnswers = raw.answers ?? [];
    if (!Array.isArray(rawAnswers)) throw new QuizQuestionsError(`${where} has answers that are not a list`);
    const answers = rawAnswers.map((answer, n) => {
      if (!isRecord(answer)) throw new QuizQuestionsError(`${where}, answer ${n + 1} is not an object`);
      return { ...pick(answer, ANSWER_KEYS), answer_weight: scalar(answer.answer_weight) ?? "0" };
    });
    return { fields, answers };
  });
}

/** The form body that creates `question` at `position`. */
export function questionPairs(question: Question, position: number): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const key of QUESTION_KEYS) {
    const value = question.fields[key];
    if (value !== undefined) pairs.push([`question[${key}]`, value]);
  }
  pairs.push(["question[position]", String(position)]);
  for (const answer of question.answers) {
    for (const key of ANSWER_KEYS) {
      const value = answer[key];
      if (value !== undefined) pairs.push([`question[answers][][${key}]`, value]);
    }
  }
  return pairs;
}

function htmlParts(question: Question): string[] {
  const parts: string[] = [];
  for (const key of HTML_KEYS) {
    const value = question.fields[key];
    if (value) parts.push(value);
  }
  for (const answer of question.answers) {
    for (const key of ANSWER_HTML_KEYS) {
      const value = answer[key];
      if (value) parts.push(value);
    }
  }
  return parts;
}

function isRemote(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(src);
}

/** Every image src in the questions, split into local paths and remote urls. */
export function imageSources(questions: readonly Question[]): { local: string[]; remote: string[] } {
  const local = new Set<string>();
  const remote = new Set<string>();
  for (const question of questions) {
    for (const html of htmlParts(question)) {
      for (const match of html.matchAll(IMG_SRC_RE)) {
        const src = match[3] ?? "";
        if (!src) continue;
        (isRemote(src) ? remote : local).add(src);
      }
    }
  }
  return { local: [...local], remote: [...remote] };
}

function relinkHtml(html: string, urls: ReadonlyMap<string, string>): string {
  return html.replace(IMG_SRC_RE, (whole, head: string, quote: string, src: string) => {
    const url = urls.get(src);
    return url === undefined ? whole : `${head}${quote}${url}${quote}`;
  });
}

/** `question` with each local image src replaced by its Canvas url. */
export function relinkImages(question: Question, urls: ReadonlyMap<string, string>): Question {
  const fields = { ...question.fields };
  for (const key of HTML_KEYS) {
    const value = fields[key];
    if (value) fields[key] = relinkHtml(value, urls);
  }
  const answers = question.answers.map((answer) => {
    const copy: Record<string, string> = { ...answer };
    for (const key of ANSWER_HTML_KEYS) {
      const value = copy[key];
      if (value) copy[key] = relinkHtml(value, urls);
    }
    return copy;
  });
  return { fields, answers };
}

export interface ReplaceOptions {
  /** Where relative image paths resolve from: the question file's directory. */
  readonly baseDir: string;
  /** The course folder images go in, under "course files". It is kept hidden. */
  readonly folder: string;
  /** Question group ids to delete, such as the bank draws a fixed set replaces. */
  readonly removeGroups?: readonly string[];
  readonly updatePublished?: boolean;
  readonly dryRun?: boolean;
  readonly report?: Reporter;
}

export interface RemovedGroup {
  readonly id: string;
  readonly name: string;
  readonly pickCount: number;
  readonly bankId: string;
}

export interface ReplaceResult {
  readonly quizId: string;
  readonly title: string;
  readonly published: boolean;
  /** Questions the quiz held before, which the replacement deletes. */
  readonly replaced: number;
  readonly groups: readonly RemovedGroup[];
  readonly created: number;
  readonly points: number;
  /** Every local image path the questions use, uploaded unless this is a dry run. */
  readonly upload: readonly string[];
  /** Local image path -> the Canvas file id it was uploaded as (empty on a dry run). */
  readonly images: Readonly<Record<string, string>>;
  /** Image urls left pointing at another server. */
  readonly remote: readonly string[];
  readonly dryRun: boolean;
  /** What Canvas reports once the work is done; null on a dry run. */
  readonly check: { readonly questions: number; readonly points: number } | null;
}

function folderPath(folder: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, "");
  return trimmed.startsWith("course files") ? trimmed : `course files/${trimmed}`;
}

/** The hidden folder images go in, created or hidden as needed; its id. */
async function hiddenFolder(client: QuizQuestionsCanvas, courseId: string, folder: string): Promise<string> {
  const full = folderPath(folder);
  const existing = (await client.listFolders(courseId)).find((f) => f.full_name === full);
  if (existing !== undefined) {
    if (existing.hidden !== true) await client.updateFolder(String(existing.id), { hidden: "true" });
    return String(existing.id);
  }
  // Canvas reads a path that starts at the root folder's name ("course files")
  // as starting at the root, as uploadFile's parent_folder_path does.
  const created = await client.createFolder(courseId, {
    name: path.posix.basename(full),
    parent_folder_path: path.posix.dirname(full),
    hidden: "true",
  });
  return String(created.id);
}

/**
 * Replace the questions in quiz `quizId` with `questions`.
 *
 * Everything that can be checked without writing is checked first: the image
 * files exist, the quiz is not published (or `updatePublished` says that is
 * fine), and every group to remove belongs to this quiz. A dry run stops there.
 */
export async function replaceQuizQuestions(
  client: QuizQuestionsCanvas,
  courseId: string,
  quizId: string,
  questions: readonly Question[],
  options: ReplaceOptions,
): Promise<ReplaceResult> {
  const report = options.report ?? (() => {});
  const dryRun = options.dryRun ?? false;
  const { local, remote } = imageSources(questions);
  const missing = local.filter((src) => !existsSync(path.resolve(options.baseDir, decodeURI(src))));
  if (missing.length > 0) {
    throw new QuizQuestionsError(`image file(s) not found: ${missing.join(", ")}`);
  }

  report(`Reading quiz ${quizId}`);
  const quiz = await client.getQuiz(courseId, quizId);
  const published = quiz.published === true;
  if (published && !options.updatePublished) {
    throw new QuizQuestionsError(
      `quiz ${quizId} is published; pass updatePublished to rebuild a quiz students can see`,
    );
  }
  const existing = await client.listQuizQuestions(courseId, quizId);

  const groups: RemovedGroup[] = [];
  for (const id of options.removeGroups ?? []) {
    report(`Reading question group ${id}`);
    const group = await client.getQuizGroup(courseId, quizId, id);
    if (String(group.quiz_id) !== quizId) {
      throw new QuizQuestionsError(`question group ${id} belongs to quiz ${String(group.quiz_id)}, not ${quizId}`);
    }
    groups.push({
      id,
      name: typeof group.name === "string" ? group.name : "",
      pickCount: asNumber(group.pick_count),
      bankId: group.assessment_question_bank_id == null ? "" : String(group.assessment_question_bank_id),
    });
  }

  const points = questions.reduce((sum, q) => sum + asNumber(q.fields.points_possible), 0);
  const base = {
    quizId,
    title: typeof quiz.title === "string" ? quiz.title : "",
    published,
    replaced: existing.length,
    groups,
    created: questions.length,
    points,
    upload: local,
    remote,
    dryRun,
  };
  if (dryRun) return { ...base, images: {}, check: null };

  // Images first: an upload is the step most likely to fail, and nothing in the
  // quiz has changed yet if it does.
  const images: Record<string, string> = {};
  const urls = new Map<string, string>();
  if (local.length > 0) {
    report(`Preparing the hidden folder ${folderPath(options.folder)}`);
    await hiddenFolder(client, courseId, options.folder);
    for (const src of local) {
      report(`Uploading ${src}`);
      const file = await client.uploadFile(
        courseId,
        path.resolve(options.baseDir, decodeURI(src)),
        folderPath(options.folder),
      );
      const fileId = String(file.id);
      images[src] = fileId;
      urls.set(src, `/courses/${courseId}/files/${fileId}/preview`);
    }
  }

  if (published) {
    report(`Unpublishing quiz ${quizId} to rebuild it`);
    await client.updateQuiz(courseId, quizId, { "quiz[published]": "false" });
  }
  for (const question of existing) {
    report(`Removing question ${String(question.id)}`);
    await client.deleteQuizQuestion(courseId, quizId, String(question.id));
  }
  for (const group of groups) {
    report(`Removing question group ${group.id}`);
    await client.deleteQuizGroup(courseId, quizId, group.id);
  }
  let position = 0;
  for (const question of questions) {
    position += 1;
    report(`Adding question ${position} of ${questions.length}`);
    await client.createQuizQuestion(courseId, quizId, questionPairs(relinkImages(question, urls), position));
  }
  if (published) {
    report(`Publishing quiz ${quizId} again`);
    await client.updateQuiz(courseId, quizId, { "quiz[published]": "true" });
  }

  const after = await client.getQuiz(courseId, quizId);
  return {
    ...base,
    images,
    check: { questions: asNumber(after.question_count), points: asNumber(after.points_possible) },
  };
}
