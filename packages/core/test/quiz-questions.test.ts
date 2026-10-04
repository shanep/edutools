/**
 * Replacing a quiz's questions: the file format, the form body Canvas receives,
 * image relinking, and the order of the writes. The client is a plain object of
 * mocks, so nothing here needs a token.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CanvasLMS } from "@edutools/core/canvas";
import {
  imageSources,
  parseQuestions,
  type Question,
  QuizQuestionsError,
  questionPairs,
  relinkImages,
  replaceQuizQuestions,
} from "@edutools/core/quiz-questions";
import type { Payload } from "@edutools/core/types";
import { describe, expect, it, vi } from "vitest";

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

const MATCHING = {
  id: 99,
  quiz_id: 5,
  question_name: "2.1-4",
  question_type: "matching_question",
  points_possible: 2,
  question_text: "<p>Match them</p>",
  matching_answer_incorrect_matches: "UDP\nIP",
  answers: [
    { id: 1, answer_match_left: "web", answer_match_right: "HTTP", answer_weight: 100 },
    { id: 2, answer_match_left: "mail", answer_match_right: "SMTP", answer_weight: 100 },
  ],
};

const CHOICE = {
  question_name: "1.3-1",
  question_type: "multiple_choice_question",
  points_possible: 2,
  question_text: '<p>How many?</p><p><img src="img/1.3-1.png" alt="network"></p>',
  answers: [
    { answer_text: "70", answer_weight: 100 },
    { answer_text: "20", answer_weight: 0 },
  ],
};

describe("parseQuestions", () => {
  it("keeps the fields Canvas takes and drops its bookkeeping", () => {
    const [question] = parseQuestions(JSON.stringify([MATCHING]));
    expect(question?.fields).toEqual({
      question_name: "2.1-4",
      question_text: "<p>Match them</p>",
      question_type: "matching_question",
      points_possible: "2",
      matching_answer_incorrect_matches: "UDP\nIP",
    });
    expect(question?.answers[0]).toEqual({ answer_weight: "100", answer_match_left: "web", answer_match_right: "HTTP" });
  });

  it("refuses what Canvas would reject or misread", () => {
    expect(() => parseQuestions("{}")).toThrow(/JSON list/);
    expect(() => parseQuestions("[]")).toThrow(/no questions/);
    expect(() => parseQuestions('[{"question_type": "poll", "question_text": "x"}]')).toThrow(QuizQuestionsError);
    expect(() => parseQuestions('[{"question_type": "essay_question"}]')).toThrow(/no question_text/);
    expect(() =>
      parseQuestions('[{"question_type": "essay_question", "question_text": "x", "points_possible": "two"}]'),
    ).toThrow(/points_possible/);
  });

  it("gives an answer with no weight a weight of 0", () => {
    const [question] = parseQuestions(
      JSON.stringify([{ question_type: "short_answer_question", question_text: "x", answers: [{ answer_text: "y" }] }]),
    );
    expect(question?.answers[0]?.answer_weight).toBe("0");
  });
});

describe("questionPairs", () => {
  it("leads every answer with its weight so Rails keeps the answers apart", () => {
    const [question] = parseQuestions(JSON.stringify([MATCHING])) as [Question];
    expect(questionPairs(question, 3)).toEqual([
      ["question[question_name]", "2.1-4"],
      ["question[question_text]", "<p>Match them</p>"],
      ["question[question_type]", "matching_question"],
      ["question[points_possible]", "2"],
      ["question[matching_answer_incorrect_matches]", "UDP\nIP"],
      ["question[position]", "3"],
      ["question[answers][][answer_weight]", "100"],
      ["question[answers][][answer_match_left]", "web"],
      ["question[answers][][answer_match_right]", "HTTP"],
      ["question[answers][][answer_weight]", "100"],
      ["question[answers][][answer_match_left]", "mail"],
      ["question[answers][][answer_match_right]", "SMTP"],
    ]);
  });
});

describe("images", () => {
  it("splits local paths from urls on other servers", () => {
    const questions = parseQuestions(
      JSON.stringify([
        CHOICE,
        { ...CHOICE, question_text: '<img src="http://gaia.cs.umass.edu/a.png"><img src="/courses/1/files/2/preview">' },
      ]),
    );
    expect(imageSources(questions)).toEqual({
      local: ["img/1.3-1.png"],
      remote: ["http://gaia.cs.umass.edu/a.png", "/courses/1/files/2/preview"],
    });
  });

  it("relinks only the images it uploaded", () => {
    const [question] = parseQuestions(JSON.stringify([CHOICE])) as [Question];
    const relinked = relinkImages(question, new Map([["img/1.3-1.png", "/courses/7/files/8/preview"]]));
    expect(relinked.fields.question_text).toBe(
      '<p>How many?</p><p><img src="/courses/7/files/8/preview" alt="network"></p>',
    );
  });
});

function fakeCanvas(quiz: Payload, folders: Payload[] = []) {
  const calls: string[] = [];
  const log =
    <T>(name: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push(`${name} ${args.filter((a) => typeof a === "string").slice(1).join(" ")}`.trim());
      return value;
    };
  return {
    calls,
    client: {
      getQuiz: vi.fn<CanvasLMS["getQuiz"]>(log("getQuiz", { ...quiz, question_count: 1, points_possible: 2 })),
      updateQuiz: vi.fn<CanvasLMS["updateQuiz"]>(log("updateQuiz", {})),
      listQuizQuestions: vi.fn<CanvasLMS["listQuizQuestions"]>(log("listQuizQuestions", [{ id: 41 }])),
      createQuizQuestion: vi.fn<CanvasLMS["createQuizQuestion"]>(log("createQuizQuestion", {})),
      deleteQuizQuestion: vi.fn<CanvasLMS["deleteQuizQuestion"]>(log("deleteQuizQuestion", undefined)),
      getQuizGroup: vi.fn<CanvasLMS["getQuizGroup"]>(
        log("getQuizGroup", { id: 7, quiz_id: 5, name: "Chapter 1", pick_count: 20, assessment_question_bank_id: 608128 }),
      ),
      deleteQuizGroup: vi.fn<CanvasLMS["deleteQuizGroup"]>(log("deleteQuizGroup", undefined)),
      listFolders: vi.fn<CanvasLMS["listFolders"]>(log("listFolders", folders)),
      createFolder: vi.fn<CanvasLMS["createFolder"]>(log("createFolder", { id: 300 })),
      updateFolder: vi.fn<CanvasLMS["updateFolder"]>(log("updateFolder", {})),
      uploadFile: vi.fn<CanvasLMS["uploadFile"]>(async (_course, _file, folder) => {
        calls.push(`uploadFile ${folder}`);
        return { id: 800 };
      }),
    },
  };
}

function withImage(): string {
  const dir = tmp();
  mkdirSync(path.join(dir, "img"));
  writeFileSync(path.join(dir, "img", "1.3-1.png"), "png");
  return dir;
}

describe("replaceQuizQuestions", () => {
  it("uploads, unpublishes, rebuilds and republishes a published quiz, in that order", async () => {
    const { client, calls } = fakeCanvas({ id: 5, title: "Midterm", published: true });
    const questions = parseQuestions(JSON.stringify([CHOICE]));
    const result = await replaceQuizQuestions(client, "1", "5", questions, {
      baseDir: withImage(),
      folder: "quiz images/5",
      removeGroups: ["7"],
      updatePublished: true,
    });

    expect(calls).toEqual([
      "getQuiz 5",
      "listQuizQuestions 5",
      "getQuizGroup 5 7",
      "listFolders",
      "createFolder",
      "uploadFile course files/quiz images/5",
      "updateQuiz 5",
      "deleteQuizQuestion 5 41",
      "deleteQuizGroup 5 7",
      "createQuizQuestion 5",
      "updateQuiz 5",
      "getQuiz 5",
    ]);
    expect(client.createFolder).toHaveBeenCalledWith("1", {
      name: "5",
      parent_folder_path: "course files/quiz images",
      hidden: "true",
    });
    expect(client.updateQuiz.mock.calls.map((c) => c[2])).toEqual([
      { "quiz[published]": "false" },
      { "quiz[published]": "true" },
    ]);
    const sent = client.createQuizQuestion.mock.calls[0]?.[2] ?? [];
    expect(sent).toContainEqual([
      "question[question_text]",
      '<p>How many?</p><p><img src="/courses/1/files/800/preview" alt="network"></p>',
    ]);
    expect(result.groups).toEqual([{ id: "7", name: "Chapter 1", pickCount: 20, bankId: "608128" }]);
    expect(result.images).toEqual({ "img/1.3-1.png": "800" });
    expect(result.check).toEqual({ questions: 1, points: 2 });
  });

  it("hides a folder that already exists rather than making another", async () => {
    const { client } = fakeCanvas({ id: 5, published: false }, [
      { id: 12, full_name: "course files/quiz images/5", hidden: false },
    ]);
    await replaceQuizQuestions(client, "1", "5", parseQuestions(JSON.stringify([CHOICE])), {
      baseDir: withImage(),
      folder: "quiz images/5",
    });
    expect(client.createFolder).not.toHaveBeenCalled();
    expect(client.updateFolder).toHaveBeenCalledWith("12", { hidden: "true" });
    expect(client.updateQuiz).not.toHaveBeenCalled();
  });

  it("refuses a published quiz without updatePublished, before writing anything", async () => {
    const { client } = fakeCanvas({ id: 5, published: true });
    await expect(
      replaceQuizQuestions(client, "1", "5", parseQuestions(JSON.stringify([CHOICE])), {
        baseDir: withImage(),
        folder: "q",
      }),
    ).rejects.toThrow(/is published/);
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses a group from another quiz", async () => {
    const { client } = fakeCanvas({ id: 5, published: false });
    client.getQuizGroup.mockResolvedValue({ id: 7, quiz_id: 6 });
    await expect(
      replaceQuizQuestions(client, "1", "5", parseQuestions(JSON.stringify([CHOICE])), {
        baseDir: withImage(),
        folder: "q",
        removeGroups: ["7"],
      }),
    ).rejects.toThrow(/belongs to quiz 6/);
    expect(client.deleteQuizGroup).not.toHaveBeenCalled();
  });

  it("refuses an image file that is not there", async () => {
    const { client } = fakeCanvas({ id: 5, published: false });
    await expect(
      replaceQuizQuestions(client, "1", "5", parseQuestions(JSON.stringify([CHOICE])), { baseDir: tmp(), folder: "q" }),
    ).rejects.toThrow(/img\/1\.3-1\.png/);
    expect(client.getQuiz).not.toHaveBeenCalled();
  });

  it("a dry run reads and writes nothing", async () => {
    const { client, calls } = fakeCanvas({ id: 5, title: "Midterm", published: true });
    const result = await replaceQuizQuestions(client, "1", "5", parseQuestions(JSON.stringify([CHOICE])), {
      baseDir: withImage(),
      folder: "q",
      removeGroups: ["7"],
      updatePublished: true,
      dryRun: true,
    });
    expect(calls).toEqual(["getQuiz 5", "listQuizQuestions 5", "getQuizGroup 5 7"]);
    expect(result).toMatchObject({ replaced: 1, created: 1, points: 2, upload: ["img/1.3-1.png"], check: null });
  });
});
