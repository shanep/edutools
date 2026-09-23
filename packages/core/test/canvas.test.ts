import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asNumber, CanvasLMS, kindPath } from "@edutools/core/canvas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
  redirect: RequestInit["redirect"];
}

type Responder = (url: string, init: RequestInit) => Response;

/** A fetch that records every call and answers from `responder`. */
function fakeFetch(responder: Responder): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      // Every call site in canvas.ts passes headers as a plain object.
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
      redirect: init.redirect,
    });
    return responder(url, init);
  };
  return { fetch: impl, calls };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, { status });
}

/** One canned response for every call. */
function always(make: () => Response): ReturnType<typeof fakeFetch> {
  return fakeFetch(() => make());
}

const noSleep = async (): Promise<void> => {};

function client(fetchImpl: typeof fetch, token = "tok"): CanvasLMS {
  return new CanvasLMS({ token, endpoint: "https://c.test", fetch: fetchImpl, sleep: noSleep });
}

function last(calls: Call[]): Call {
  const call = calls.at(-1);
  if (call === undefined) throw new Error("fetch was never called");
  return call;
}

/** The form body a call sent, as ordered pairs. */
function form(call: Call): Array<[string, string]> {
  return [...new URLSearchParams(String(call.body ?? ""))];
}

function formObject(call: Call): Record<string, string> {
  return Object.fromEntries(form(call));
}

describe("CanvasLMS initialization", () => {
  const saved = { token: process.env.CANVAS_TOKEN, endpoint: process.env.CANVAS_ENDPOINT };

  beforeEach(() => {
    delete process.env.CANVAS_TOKEN;
    delete process.env.CANVAS_ENDPOINT;
  });

  afterEach(() => {
    for (const [name, value] of [
      ["CANVAS_TOKEN", saved.token],
      ["CANVAS_ENDPOINT", saved.endpoint],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("reads the token from the environment and sends it as a bearer token", async () => {
    process.env.CANVAS_TOKEN = "test_token_123";
    const fake = always(() => json([]));
    await new CanvasLMS({ fetch: fake.fetch }).getCourses({ includeAll: true });
    expect(last(fake.calls).headers.Authorization).toBe("Bearer test_token_123");
  });

  it("fails without CANVAS_TOKEN", () => {
    expect(() => new CanvasLMS()).toThrow(/CANVAS_TOKEN not set/);
  });

  it("fails with an empty CANVAS_TOKEN", () => {
    process.env.CANVAS_TOKEN = "";
    expect(() => new CanvasLMS()).toThrow(/CANVAS_TOKEN not set/);
  });

  it("lets CANVAS_ENDPOINT override the default", () => {
    process.env.CANVAS_TOKEN = "tok";
    process.env.CANVAS_ENDPOINT = "https://custom.example.com";
    expect(new CanvasLMS().endpoint).toBe("https://custom.example.com");
  });

  it("uses a default endpoint when CANVAS_ENDPOINT is not set", () => {
    process.env.CANVAS_TOKEN = "tok";
    expect(new CanvasLMS().endpoint).toBeTruthy();
  });
});

describe("getCourses", () => {
  it("returns every course", async () => {
    const fake = always(() => json([{ id: 1, name: "Course 1" }, { id: 2, name: "Course 2" }]));
    const courses = await client(fake.fetch).getCourses({ includeAll: true });
    expect(courses).toHaveLength(2);
    expect(courses[0]?.id).toBe(1);
    expect(courses[1]?.name).toBe("Course 2");
  });

  it("returns an empty list when there are no courses", async () => {
    const fake = always(() => json([]));
    expect(await client(fake.fetch).getCourses({ includeAll: true })).toEqual([]);
  });

  it("raises when the API returns an error", async () => {
    const fake = always(() => text("Unauthorized", 401));
    await expect(client(fake.fetch).getCourses()).rejects.toThrow(/Canvas API error 401/);
  });

  it("drops unavailable courses and those whose term has ended", async () => {
    const fake = always(() =>
      json([
        { id: 1, workflow_state: "available", term: { end_at: "2999-01-01T00:00:00Z" } },
        { id: 2, workflow_state: "available", term: { end_at: "2000-01-01T00:00:00Z" } },
        { id: 3, workflow_state: "unpublished" },
        { id: 4, workflow_state: "available", term: { end_at: null } },
      ]),
    );
    const courses = await client(fake.fetch).getCourses();
    expect(courses.map((c) => c.id)).toEqual([1, 4]);
    const query = new URL(last(fake.calls).url).searchParams;
    expect(query.get("state[]")).toBe("available");
    expect(query.get("per_page")).toBe("100");
  });

  it("follows the Link header across pages", async () => {
    const fake = fakeFetch((url) =>
      url.includes("page=2")
        ? json([{ id: 2 }])
        : json([{ id: 1 }], 200, {
            Link: '<https://c.test/api/v1/courses?page=2&per_page=100>; rel="next"',
          }),
    );
    const courses = await client(fake.fetch).getCourses({ includeAll: true });
    expect(courses.map((c) => c.id)).toEqual([1, 2]);
    // After the first request, params are baked into the next URL.
    expect(fake.calls[1]?.url).toBe("https://c.test/api/v1/courses?page=2&per_page=100");
  });
});

describe("getAssignments", () => {
  it("returns every assignment", async () => {
    const fake = always(() => json([{ id: 1, name: "Assignment 1" }, { id: 2, name: "Assignment 2" }]));
    const assignments = await client(fake.fetch).getAssignments("123");
    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.id).toBe(1);
    expect(assignments[1]?.name).toBe("Assignment 2");
    expect(last(fake.calls).url).toBe("https://c.test/api/v1/courses/123/assignments?per_page=100");
  });

  it("returns an empty list when there are none", async () => {
    const fake = always(() => json([]));
    expect(await client(fake.fetch).getAssignments("123")).toEqual([]);
  });

  it("raises when the API returns an error", async () => {
    const fake = always(() => text("Not Found", 404));
    await expect(client(fake.fetch).getAssignments("123")).rejects.toThrow(/Canvas API error 404/);
  });
});

describe("getStudents", () => {
  it("returns every student", async () => {
    const fake = always(() => json([{ id: 1, name: "Student 1" }, { id: 2, name: "Student 2" }]));
    const students = await client(fake.fetch).getStudents("123");
    expect(students).toHaveLength(2);
    expect(students[0]?.id).toBe(1);
    expect(students[1]?.name).toBe("Student 2");
    expect(new URL(last(fake.calls).url).searchParams.get("enrollment_type[]")).toBe("student");
  });

  it("returns an empty list when no one is enrolled", async () => {
    const fake = always(() => json([]));
    expect(await client(fake.fetch).getStudents("123")).toEqual([]);
  });

  it("raises when the API returns an error", async () => {
    const fake = always(() => text("Forbidden", 403));
    await expect(client(fake.fetch).getStudents("123")).rejects.toThrow(/Canvas API error 403/);
  });
});

describe("getSubmissions", () => {
  it("returns every submission", async () => {
    const fake = always(() => json([{ id: 1, user_id: 101 }, { id: 2, user_id: 102 }]));
    const submissions = await client(fake.fetch).getSubmissions("123", "456");
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.id).toBe(1);
    expect(submissions[1]?.user_id).toBe(102);
  });

  it("returns an empty list when there are none", async () => {
    const fake = always(() => json([]));
    expect(await client(fake.fetch).getSubmissions("123", "456")).toEqual([]);
  });

  it("raises when the API returns an error", async () => {
    const fake = always(() => text("Internal Server Error", 500));
    await expect(client(fake.fetch).getSubmissions("123", "456")).rejects.toThrow(
      /Canvas API error 500/,
    );
  });
});

describe("getAssignment", () => {
  it("returns the one assignment", async () => {
    const fake = always(() => json({ id: 456, name: "Final Project", due_at: "2024-12-15" }));
    const assignment = await client(fake.fetch).getAssignment("123", "456");
    expect(assignment.id).toBe(456);
    expect(assignment.name).toBe("Final Project");
    expect(assignment.due_at).toBe("2024-12-15");
  });

  it("raises when the assignment does not exist", async () => {
    const fake = always(() => text("Not Found", 404));
    await expect(client(fake.fetch).getAssignment("123", "999")).rejects.toThrow(
      /Canvas API error 404/,
    );
  });

  it("raises when the API returns an error", async () => {
    const fake = always(() => text("Internal Server Error", 500));
    await expect(client(fake.fetch).getAssignment("123", "456")).rejects.toThrow(
      /Canvas API error 500/,
    );
  });
});

describe("headers", () => {
  it("sends the authorization header with API requests", async () => {
    const fake = always(() => json([]));
    await client(fake.fetch, "secret_token_xyz").getCourses({ includeAll: true });
    expect(last(fake.calls).headers.Authorization).toBe("Bearer secret_token_xyz");
  });
});

describe("retries", () => {
  it("backs off and retries a throttled request, at least five seconds for a 429", async () => {
    let n = 0;
    const fake = fakeFetch(() => (n++ === 0 ? text("slow down", 429) : json({ id: 1 })));
    const waits: number[] = [];
    const canvas = new CanvasLMS({
      token: "tok",
      endpoint: "https://c.test",
      fetch: fake.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(await canvas.getJson("/api/v1/courses/1")).toEqual({ id: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(5000);
  });

  it("gives up after five attempts and says what it tried", async () => {
    const fake = always(() => text("down", 503));
    await expect(client(fake.fetch).getJson("/api/v1/courses/1")).rejects.toThrow(
      "Canvas API error after 5 attempts (GET https://c.test/api/v1/courses/1): HTTP 503: down",
    );
    expect(fake.calls).toHaveLength(5);
  });

  it("retries a dropped connection", async () => {
    let n = 0;
    const flaky: typeof fetch = async () => {
      if (n++ < 2) throw new TypeError("fetch failed");
      return json({ id: 1 });
    };
    expect(await client(flaky).getJson("/api/v1/courses/1")).toEqual({ id: 1 });
    expect(n).toBe(3);
  });

  it("does not retry a client error", async () => {
    const fake = always(() => text("nope", 404));
    await expect(client(fake.fetch).getJson("/api/v1/x")).rejects.toThrow(/Canvas API error 404: nope/);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("kindPath", () => {
  it("maps every kind to its collection", () => {
    expect(kindPath("page")).toBe("pages");
    expect(kindPath("assignment")).toBe("assignments");
    expect(kindPath("discussion")).toBe("discussion_topics");
    expect(kindPath("quiz")).toBe("quizzes");
    expect(kindPath("module")).toBe("modules");
  });

  it("names the valid kinds when given an unknown one", () => {
    expect(() => kindPath("rubric")).toThrow(/unknown Canvas kind 'rubric'/);
    expect(() => kindPath("toString")).toThrow(/unknown Canvas kind/);
  });
});

describe("object CRUD", () => {
  it("create posts to the kind's collection", async () => {
    const fake = always(() => json({ id: 42 }));
    const result = await client(fake.fetch).createObject("assignment", "123", {
      "assignment[name]": "Lab 1",
    });
    expect(result).toEqual({ id: 42 });
    const call = last(fake.calls);
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://c.test/api/v1/courses/123/assignments");
    expect(call.body).toBe("assignment%5Bname%5D=Lab+1");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("update puts to the object", async () => {
    const fake = always(() => json({ id: 42 }));
    await client(fake.fetch).updateObject("quiz", "123", "42", { "quiz[published]": "true" });
    const call = last(fake.calls);
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://c.test/api/v1/courses/123/quizzes/42");
  });

  it("delete addresses a page by its slug", async () => {
    const fake = always(() => json({ url: "week-1" }));
    const result = await client(fake.fetch).deleteObject("page", "123", "week-1");
    const call = last(fake.calls);
    expect(call.method).toBe("DELETE");
    expect(call.url).toBe("https://c.test/api/v1/courses/123/pages/week-1");
    expect(call.body).toBeUndefined();
    // Canvas answers a delete with the object, which is the only record of it.
    expect(result).toEqual({ url: "week-1" });
  });

  it("a failed delete raises", async () => {
    const fake = always(() => text("not found", 404));
    await expect(client(fake.fetch).deleteObject("assignment", "123", "999")).rejects.toThrow(/404/);
  });

  it("file delete leaves the course namespace", async () => {
    const fake = always(() => json({ id: 7 }));
    await client(fake.fetch).deleteFile("7");
    expect(last(fake.calls).url).toBe("https://c.test/api/v1/files/7");
  });

  it("repeated bracket keys are sent as repeated pairs, in order", async () => {
    const fake = always(() => json({ id: 1 }));
    await client(fake.fetch).createQuizQuestion("123", "9", [
      ["question[question_text]", "Pick one"],
      ["question[answers][][answer_text]", "a"],
      ["question[answers][][answer_text]", "b"],
    ]);
    expect(form(last(fake.calls))).toEqual([
      ["question[question_text]", "Pick one"],
      ["question[answers][][answer_text]", "a"],
      ["question[answers][][answer_text]", "b"],
    ]);
  });
});

describe("gradeSubmission", () => {
  it("grades and comments together", async () => {
    const fake = always(() => json({ grade: "18" }));
    await client(fake.fetch).gradeSubmission("123", "456", "789", {
      grade: "18",
      comment: "Clean tests.",
    });
    const call = last(fake.calls);
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://c.test/api/v1/courses/123/assignments/456/submissions/789");
    expect(formObject(call)).toEqual({
      "submission[posted_grade]": "18",
      "comment[text_comment]": "Clean tests.",
    });
  });

  it("a comment alone leaves the submission ungraded", async () => {
    const fake = always(() => json({}));
    await client(fake.fetch).gradeSubmission("123", "456", "789", { comment: "See notes." });
    const data = formObject(last(fake.calls));
    expect(data).toEqual({ "comment[text_comment]": "See notes." });
    expect(data).not.toHaveProperty("submission[posted_grade]");
  });

  it("group comment is opt in", async () => {
    const fake = always(() => json({}));
    await client(fake.fetch).gradeSubmission("123", "456", "789", {
      comment: "hi",
      groupComment: true,
    });
    expect(formObject(last(fake.calls))["comment[group_comment]"]).toBe("true");
  });

  it("sends excuse and late policy", async () => {
    const fake = always(() => json({}));
    await client(fake.fetch).gradeSubmission("123", "456", "789", {
      excuse: true,
      latePolicyStatus: "late",
      secondsLateOverride: 3600,
    });
    expect(formObject(last(fake.calls))).toEqual({
      "submission[excuse]": "true",
      "submission[late_policy_status]": "late",
      "submission[seconds_late_override]": "3600",
    });
  });

  it("flattens a rubric assessment per criterion", async () => {
    const fake = always(() => json({}));
    await client(fake.fetch).gradeSubmission("123", "456", "789", {
      rubricAssessment: { crit_1: { points: 4, comments: "Good design." } },
    });
    expect(formObject(last(fake.calls))).toEqual({
      "rubric_assessment[crit_1][points]": "4",
      "rubric_assessment[crit_1][comments]": "Good design.",
    });
  });

  it("refuses an empty call before it reaches Canvas", async () => {
    const fake = always(() => json({}));
    await expect(client(fake.fetch).gradeSubmission("123", "456", "789")).rejects.toThrow(
      /at least a grade/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("getSubmission repeats the include parameter", async () => {
    const fake = always(() => json({ user_id: 789 }));
    await client(fake.fetch).getSubmission("123", "456", "789", {
      include: ["submission_comments"],
    });
    expect([...new URL(last(fake.calls).url).searchParams]).toEqual([
      ["include[]", "submission_comments"],
    ]);
  });

  it("getSubmission asks for comments, rubric and user by default", async () => {
    const fake = always(() => json({ user_id: 789 }));
    await client(fake.fetch).getSubmission("123", "456", "789");
    expect(new URL(last(fake.calls).url).searchParams.getAll("include[]")).toEqual([
      "submission_comments",
      "rubric_assessment",
      "user",
    ]);
  });

  it("getSubmission reports a failure", async () => {
    const fake = always(() => text("nope", 401));
    await expect(client(fake.fetch).getSubmission("123", "456", "789")).rejects.toThrow(/401/);
  });
});

describe("downloadAttachment", () => {
  function tmp(): string {
    return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  }

  it("streams to disk and reports the size", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("de"));
        controller.close();
      },
    });
    const fake = always(() => new Response(stream, { status: 200 }));
    const dest = path.join(tmp(), "nested", "main.py");
    const written = await client(fake.fetch).downloadAttachment("https://files.test/x", dest);
    expect(written).toBe(5);
    expect(readFileSync(dest, "utf-8")).toBe("abcde");
  });

  it("raises on a failed download", async () => {
    const fake = always(() => text("", 403));
    await expect(
      client(fake.fetch).downloadAttachment("https://files.test/x", path.join(tmp(), "x.py")),
    ).rejects.toThrow(/403/);
  });

  it("does not carry the token to the blob storage host a download redirects to", async () => {
    const fake = fakeFetch((url) => {
      if (url === "https://c.test/files/1/download") {
        return new Response(null, { status: 302, headers: { Location: "/files/1/verified" } });
      }
      if (url === "https://c.test/files/1/verified") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://blobs.example.com/abc?sig=1" },
        });
      }
      if (url === "https://blobs.example.com/abc?sig=1") {
        return new Response(null, { status: 307, headers: { Location: "/abc2?sig=1" } });
      }
      return new Response("bytes", { status: 200 });
    });
    const dest = path.join(tmp(), "f.bin");
    const written = await client(fake.fetch, "secret").downloadAttachment(
      "https://c.test/files/1/download",
      dest,
    );

    expect(written).toBe(5);
    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://c.test/files/1/download",
      "https://c.test/files/1/verified",
      "https://blobs.example.com/abc?sig=1",
      "https://blobs.example.com/abc2?sig=1",
    ]);
    expect(fake.calls.every((c) => c.redirect === "manual")).toBe(true);
    // Same host keeps it; once the host changes it is gone for good.
    expect(fake.calls.map((c) => c.headers.Authorization)).toEqual([
      "Bearer secret",
      "Bearer secret",
      undefined,
      undefined,
    ]);
  });
});

describe("uploadFile", () => {
  function file(content: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
    const p = path.join(dir, "syllabus.pdf");
    writeFileSync(p, content);
    return p;
  }

  it("announces, posts the bytes with file last, and follows the redirect to confirm", async () => {
    const forms: FormData[] = [];
    const fake = fakeFetch((url, init) => {
      if (url === "https://c.test/api/v1/courses/123/files") {
        return json({
          upload_url: "https://upload.test/bucket",
          upload_params: { key: "abc", policy: "p" },
        });
      }
      if (url === "https://upload.test/bucket") {
        forms.push(init.body as FormData); // uploadFile posts a FormData here
        return new Response(null, {
          status: 303,
          headers: { Location: "https://c.test/api/v1/files/9/create_success?uuid=u" },
        });
      }
      return json({ id: 9, size: 5 });
    });

    const result = await client(fake.fetch).uploadFile("123", file("hello"), "course files/docs", false);
    expect(result).toEqual({ id: 9, size: 5 });

    const [announce, upload, confirm] = fake.calls;
    expect(announce?.method).toBe("POST");
    expect(announce && formObject(announce)).toEqual({
      name: "syllabus.pdf",
      size: "5",
      parent_folder_path: "course files/docs",
      on_duplicate: "rename",
    });

    expect(upload?.method).toBe("POST");
    expect(upload?.redirect).toBe("manual");
    // The upload host is not Canvas, so it never sees the token.
    expect(upload?.headers.Authorization).toBeUndefined();
    const body = forms[0];
    if (body === undefined) throw new Error("no upload body");
    expect([...body.keys()]).toEqual(["key", "policy", "file"]);
    const sent = body.get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("syllabus.pdf"); // checked to be a File just above
    expect(await (sent as File).text()).toBe("hello");

    expect(confirm?.method).toBe("GET");
    expect(confirm?.url).toBe("https://c.test/api/v1/files/9/create_success?uuid=u");
    expect(confirm?.headers.Authorization).toBe("Bearer tok");
  });

  it("overwrites by default", async () => {
    const fake = fakeFetch((url) =>
      url.endsWith("/files")
        ? json({ upload_url: "https://upload.test/b", upload_params: {} })
        : json({ id: 1, size: "2" }, 201),
    );
    await client(fake.fetch).uploadFile("123", file("hi"));
    const announce = fake.calls[0];
    expect(announce && formObject(announce).on_duplicate).toBe("overwrite");
    expect(announce && formObject(announce).parent_folder_path).toBe("course files");
  });

  it("raises when the uploaded size does not match the local file", async () => {
    const fake = fakeFetch((url) =>
      url.endsWith("/files")
        ? json({ upload_url: "https://upload.test/b", upload_params: {} })
        : json({ id: 1, size: 3 }, 201),
    );
    await expect(client(fake.fetch).uploadFile("123", file("hello"))).rejects.toThrow(
      "syllabus.pdf uploaded as 3 bytes but the local file is 5",
    );
  });

  it("raises when the upload host refuses the bytes", async () => {
    const fake = fakeFetch((url) =>
      url.endsWith("/files")
        ? json({ upload_url: "https://upload.test/b", upload_params: {} })
        : text("denied", 400),
    );
    await expect(client(fake.fetch).uploadFile("123", file("x"))).rejects.toThrow(
      "Canvas file upload failed for syllabus.pdf: HTTP 400: denied",
    );
  });
});

describe("module publishing", () => {
  it("createModule defaults to unpublished", async () => {
    const fake = always(() => json({ id: 1 }));
    await client(fake.fetch).createModule("42", "Week 1", 1);
    expect(formObject(last(fake.calls))["module[published]"]).toBe("false");
  });

  it("createModule can publish", async () => {
    const fake = always(() => json({ id: 1 }));
    await client(fake.fetch).createModule("42", "Week 1", 1, true);
    expect(formObject(last(fake.calls))["module[published]"]).toBe("true");
  });
});

describe("assignment groups", () => {
  it("create posts bare fields", async () => {
    const fake = always(() => json({ id: 9 }));
    const result = await client(fake.fetch).createAssignmentGroup("123", {
      name: "Projects",
      position: "3",
      group_weight: "10",
    });
    expect(result).toEqual({ id: 9 });
    const call = last(fake.calls);
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://c.test/api/v1/courses/123/assignment_groups");
    expect(formObject(call).group_weight).toBe("10");
  });

  it("the listing can ask for the assignments in each group", async () => {
    // Counting what is in a group reads zero unless the include is sent.
    const fake = always(() => json([{ id: 1, assignments: [] }]));
    await client(fake.fetch).listAssignmentGroups("123", { withAssignments: true });
    expect(new URL(last(fake.calls).url).searchParams.get("include[]")).toBe("assignments");
  });

  it("the listing without the include sends no include", async () => {
    const fake = always(() => json([{ id: 1 }]));
    await client(fake.fetch).listAssignmentGroups("123");
    expect(new URL(last(fake.calls).url).searchParams.has("include[]")).toBe(false);
  });

  it("update puts to the group", async () => {
    const fake = always(() => json({ id: 9 }));
    await client(fake.fetch).updateAssignmentGroup("123", "9", { group_weight: "40" });
    const call = last(fake.calls);
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://c.test/api/v1/courses/123/assignment_groups/9");
  });

  it("weighting is a course setting", async () => {
    // Group weights do nothing until the course itself is set to weight by group.
    const fake = always(() => json({ id: 123 }));
    await client(fake.fetch).setGroupWeighting("123", true);
    const call = last(fake.calls);
    expect([call.method, call.url]).toEqual(["PUT", "https://c.test/api/v1/courses/123"]);
    expect(formObject(call)).toEqual({ "course[apply_assignment_group_weights]": "true" });
  });
});

describe("asNumber", () => {
  it("passes numbers through", () => {
    expect(asNumber(40)).toBe(40);
    expect(asNumber(40.5)).toBe(40.5);
  });

  it("reads numeric strings", () => {
    expect(asNumber("40")).toBe(40);
  });

  it("makes anything else zero", () => {
    expect(asNumber(null)).toBe(0);
    expect(asNumber("")).toBe(0);
    expect(asNumber(true)).toBe(0);
    expect(asNumber({ a: 1 })).toBe(0);
    expect(asNumber("0x10")).toBe(0);
  });
});
