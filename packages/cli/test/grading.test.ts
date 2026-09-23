/**
 * End-to-end checks on grade, download and submission, ported from tests/test_cli.py.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type FakeClient, fakeClient, invoke, recordingClient, tmpDir } from "./harness";

let canvas: FakeClient;

beforeEach(() => {
  canvas = fakeClient();
});

function gradesFile(name: string, content: string): string {
  const file = path.join(tmpDir(), name);
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("grade", () => {
  it("one student with a score and a comment", async () => {
    canvas.gradeSubmission.mockResolvedValue({ grade: "18" });
    const result = await invoke(
      ["grade", "-c", "123", "-a", "456", "-s", "789", "--score", "18", "--comment", "Clean tests."],
      { client: canvas },
    );

    expect(result.code, result.output).toBe(0);
    const [courseId, assignmentId, userId, options] = canvas.gradeSubmission.mock.calls[0] ?? [];
    expect([courseId, assignmentId, userId]).toEqual(["123", "456", "789"]);
    expect(options?.grade).toBe("18");
    expect(options?.comment).toBe("Clean tests.");
  });

  it("a comment file becomes the comment", async () => {
    canvas.gradeSubmission.mockResolvedValue({});
    const file = gradesFile("feedback.md", "Long feedback.\n");
    await invoke(["grade", "-c", "123", "-a", "456", "-s", "789", "--comment-file", file], { client: canvas });

    expect(canvas.gradeSubmission.mock.calls[0]?.[3]?.comment).toBe("Long feedback.");
  });

  it("a batch grades every row", async () => {
    canvas.gradeSubmission.mockResolvedValue({ grade: "18" });
    const file = gradesFile(
      "grades.json",
      JSON.stringify([
        { student: 555, score: 18, comment: "Good." },
        { student: 556, excuse: true },
      ]),
    );
    const result = await invoke(["grade", "-c", "123", "-a", "456", "--from-file", file], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(canvas.gradeSubmission).toHaveBeenCalledTimes(2);
    expect(canvas.gradeSubmission.mock.calls[1]?.[3]?.excuse).toBe(true);
  });

  it("dry run writes nothing", async () => {
    const file = gradesFile("grades.json", '[{"student": 555, "score": 18}]');
    const result = await invoke(["grade", "-c", "123", "-a", "456", "--from-file", file, "--dry-run"], {
      client: canvas,
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("nothing written");
    expect(canvas.gradeSubmission).not.toHaveBeenCalled();
  });

  it("a failed row is reported and exits non-zero", async () => {
    canvas.gradeSubmission
      .mockResolvedValueOnce({ grade: "18" })
      .mockRejectedValueOnce(new Error("Canvas API error 404: no such user"));
    const file = gradesFile(
      "grades.json",
      JSON.stringify([
        { student: 555, score: 18 },
        { student: 999, score: 18 },
      ]),
    );
    const result = await invoke(["grade", "-c", "123", "-a", "456", "--from-file", file], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.output).toContain("user 999");
    // The first row still went through; a batch is not all-or-nothing.
    expect(canvas.gradeSubmission).toHaveBeenCalledTimes(2);
  });

  it("student and from-file are mutually exclusive", async () => {
    const file = gradesFile("grades.json", '[{"student": 555, "score": 1}]');
    const result = await invoke(["grade", "-c", "123", "-a", "456", "-s", "789", "--from-file", file], {
      client: canvas,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("not both");
  });

  it("a csv batch is inferred from the filename", async () => {
    canvas.gradeSubmission.mockResolvedValue({ grade: "18" });
    const file = gradesFile("grades.csv", "student_id,score,comment\n555,18,Good.\n");
    const result = await invoke(["grade", "-c", "123", "-a", "456", "--from-file", file], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(canvas.gradeSubmission.mock.calls[0]?.[3]?.grade).toBe("18");
  });

  it("a batch can be piped in on stdin", async () => {
    canvas.gradeSubmission.mockResolvedValue({ grade: "18" });
    const result = await invoke(["grade", "-c", "123", "-a", "456", "--from-file", "-"], {
      client: canvas,
      input: '[{"student": 555, "score": 18},\n {"student": 556, "score": 12}]\n',
    });

    expect(result.code, result.output).toBe(0);
    expect(canvas.gradeSubmission.mock.calls.map((call) => call[2])).toEqual(["555", "556"]);
  });

  it("the grade and the comment reach Canvas as one form body", async () => {
    const recorder = recordingClient({ grade: "18" });
    const result = await invoke(
      ["grade", "-c", "123", "-a", "456", "-s", "789", "--score", "18", "--comment", "Clean tests."],
      { makeClient: recorder.makeClient },
    );

    expect(result.code, result.output).toBe(0);
    const [request] = recorder.requests;
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe(
      "https://boisestatecanvas.instructure.com/api/v1/courses/123/assignments/456/submissions/789",
    );
    expect(Object.fromEntries(request?.body ?? [])).toEqual({
      "submission[posted_grade]": "18",
      "comment[text_comment]": "Clean tests.",
    });
  });

  it("nothing to apply is refused before any write", async () => {
    const result = await invoke(["grade", "-c", "123", "-a", "456", "-s", "789"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nothing to apply for student 789");
    expect(canvas.gradeSubmission).not.toHaveBeenCalled();
  });
});

describe("download", () => {
  it("it writes text and attachments per student", async () => {
    canvas.getSubmissions.mockResolvedValue([
      {
        user_id: 555,
        body: "my answer",
        attachments: [{ id: 1, display_name: "main.py", size: 5, url: "https://f.test/1" }],
      },
      { user_id: 556, body: null, attachments: [] },
    ]);
    canvas.downloadAttachment.mockResolvedValue(5);
    const out = path.join(tmpDir(), "subs");
    const result = await invoke(["download", "-c", "123", "-a", "456", "--out", out], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(readFileSync(path.join(out, "555", "submission.txt"), "utf-8")).toBe("my answer");
    expect(canvas.downloadAttachment.mock.calls[0]?.[0]).toBe("https://f.test/1");
    expect(canvas.downloadAttachment.mock.calls[0]?.[1]).toBe(path.join(out, "555", "main.py"));
  });

  it("an already downloaded file is left alone", async () => {
    const out = path.join(tmpDir(), "subs");
    mkdirSync(path.join(out, "555"), { recursive: true });
    writeFileSync(path.join(out, "555", "main.py"), "abcde");
    canvas.getSubmissions.mockResolvedValue([
      {
        user_id: 555,
        attachments: [{ id: 1, display_name: "main.py", size: 5, url: "https://f.test/1" }],
      },
    ]);
    const result = await invoke(["download", "-c", "123", "-a", "456", "--out", out], { client: canvas });

    expect(result.output).toContain("already present");
    expect(canvas.downloadAttachment).not.toHaveBeenCalled();
  });

  it("only one student when asked", async () => {
    canvas.getSubmissions.mockResolvedValue([
      { user_id: 555, body: "a", attachments: [] },
      { user_id: 556, body: "b", attachments: [] },
    ]);
    const out = path.join(tmpDir(), "subs");
    await invoke(["download", "-c", "123", "-a", "456", "-s", "556", "--out", out], { client: canvas });

    expect(existsSync(path.join(out, "556"))).toBe(true);
    expect(existsSync(path.join(out, "555"))).toBe(false);
  });

  it("a file name Windows refuses is made safe", async () => {
    canvas.getSubmissions.mockResolvedValue([
      {
        user_id: 555,
        attachments: [{ id: 1, display_name: "what?.py", size: 5, url: "https://f.test/1" }],
      },
    ]);
    canvas.downloadAttachment.mockResolvedValue(5);
    const out = path.join(tmpDir(), "subs");
    await invoke(["download", "-c", "123", "-a", "456", "--out", out], { client: canvas });

    expect(canvas.downloadAttachment.mock.calls[0]?.[1]).toBe(path.join(out, "555", "what_.py"));
  });
});

describe("submission", () => {
  it("json emits the raw payload", async () => {
    canvas.getSubmission.mockResolvedValue({ user_id: 789, grade: "18" });
    const result = await invoke(["submission", "-c", "123", "-a", "456", "-s", "789", "--json"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ user_id: 789, grade: "18" });
  });

  it("the table shows comments and attachments", async () => {
    canvas.getSubmission.mockResolvedValue({
      user_id: 789,
      user: { name: "Pat Doe" },
      grade: "18",
      score: 18,
      workflow_state: "graded",
      attachments: [{ id: 1, display_name: "main.py", size: 12 }],
      submission_comments: [{ created_at: "2026-09-01", author_name: "Shane", comment: "Nice." }],
    });
    const result = await invoke(["submission", "-c", "123", "-a", "456", "-s", "789"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Pat Doe");
    expect(result.output).toContain("main.py");
    expect(result.output).toContain("Nice.");
  });
});
