/**
 * End-to-end checks on the single-object commands, ported from tests/test_cli.py.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type FakeClient, fakeClient, invoke, recordingClient, tmpDir } from "./harness";

let canvas: FakeClient;

beforeEach(() => {
  canvas = fakeClient();
});

describe("create", () => {
  it("create assignment sends the assignment field names", async () => {
    canvas.createObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    const result = await invoke(
      [
        "create",
        "assignment",
        "-c",
        "123",
        "--title",
        "Lab 7",
        "--points",
        "50",
        "--due",
        "2026-10-14T23:59:00-06:00",
        "--body",
        "<p>do it</p>",
      ],
      { client: canvas },
    );

    expect(result.code, result.output).toBe(0);
    const [kind, courseId, fields] = canvas.createObject.mock.calls[0] ?? [];
    expect([kind, courseId]).toEqual(["assignment", "123"]);
    expect(fields).toEqual({
      "assignment[name]": "Lab 7",
      "assignment[description]": "<p>do it</p>",
      "assignment[points_possible]": "50",
      "assignment[due_at]": "2026-10-14T23:59:00-06:00",
      "assignment[published]": "false",
    });
  });

  it("create defaults to unpublished", async () => {
    canvas.createObject.mockResolvedValue({ id: 42 });
    const result = await invoke(["create", "page", "-c", "123", "--title", "Week 1"], { client: canvas });

    expect(canvas.createObject.mock.calls[0]?.[2]["wiki_page[published]"]).toBe("false");
    expect(result.output).toContain("Unpublished");
  });

  it("publish flag makes it visible", async () => {
    canvas.createObject.mockResolvedValue({ id: 42 });
    await invoke(["create", "page", "-c", "123", "--title", "Week 1", "--publish"], { client: canvas });

    expect(canvas.createObject.mock.calls[0]?.[2]["wiki_page[published]"]).toBe("true");
  });

  it("no-publish keeps it unpublished", async () => {
    canvas.createObject.mockResolvedValue({ id: 42 });
    await invoke(["create", "page", "-c", "123", "--title", "Week 1", "--no-publish"], { client: canvas });

    expect(canvas.createObject.mock.calls[0]?.[2]["wiki_page[published]"]).toBe("false");
  });

  it("set reaches a field with no flag", async () => {
    canvas.createObject.mockResolvedValue({ id: 42 });
    await invoke(
      [
        "create",
        "assignment",
        "-c",
        "123",
        "--title",
        "Lab 7",
        "--set",
        "assignment[submission_types][]=online_upload",
      ],
      { client: canvas },
    );

    expect(canvas.createObject.mock.calls[0]?.[2]["assignment[submission_types][]"]).toBe("online_upload");
  });

  it("a title is required", async () => {
    const result = await invoke(["create", "assignment", "-c", "123"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.output).toContain("needs --title");
    expect(canvas.createObject).not.toHaveBeenCalled();
  });

  it("body and body-file are mutually exclusive", async () => {
    const file = path.join(tmpDir(), "b.html");
    writeFileSync(file, "<p>x</p>", "utf-8");
    const result = await invoke(["create", "page", "-c", "123", "-t", "T", "--body", "x", "--body-file", file], {
      client: canvas,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("not both");
  });

  it("a non-markdown body file is sent verbatim", async () => {
    canvas.createObject.mockResolvedValue({ id: 42 });
    const file = path.join(tmpDir(), "b.html");
    writeFileSync(file, "<p>raw</p>", "utf-8");
    await invoke(["create", "page", "-c", "123", "-t", "T", "-f", file], { client: canvas });

    expect(canvas.createObject.mock.calls[0]?.[2]["wiki_page[body]"]).toBe("<p>raw</p>");
  });

  it("a missing body file is reported", async () => {
    const result = await invoke(["create", "page", "-c", "123", "-t", "T", "-f", path.join(tmpDir(), "gone.md")], {
      client: canvas,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("No such file");
  });

  it("a markdown body file is rendered and its heading becomes the title", async () => {
    canvas.createObject.mockResolvedValue({ url: "week-1", title: "Week 1" });
    const file = path.join(tmpDir(), "week-1.md");
    writeFileSync(file, "# Week 1\n\nRead **this**.\n", "utf-8");
    const result = await invoke(["create", "page", "-c", "123", "-f", file], { client: canvas });

    expect(result.code, result.output).toBe(0);
    const fields = canvas.createObject.mock.calls[0]?.[2];
    expect(fields?.["wiki_page[title]"]).toBe("Week 1");
    expect(fields?.["wiki_page[body]"]).toContain("<strong>this</strong>");
    expect(fields?.["wiki_page[body]"]).not.toContain("<h1");
  });

  it("an explicit title beats the markdown heading", async () => {
    canvas.createObject.mockResolvedValue({ id: 1 });
    const file = path.join(tmpDir(), "week-1.md");
    writeFileSync(file, "# Week 1\n\nText.\n", "utf-8");
    await invoke(["create", "page", "-c", "123", "-t", "Other", "-f", file], { client: canvas });

    expect(canvas.createObject.mock.calls[0]?.[2]["wiki_page[title]"]).toBe("Other");
  });

  it("points that are not a number are a usage error", async () => {
    const result = await invoke(["create", "assignment", "-c", "123", "-t", "T", "-p", "lots"], { client: canvas });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a valid float");
    expect(canvas.createObject).not.toHaveBeenCalled();
  });

  it("an unknown kind is refused before anything is sent", async () => {
    const result = await invoke(["create", "widget", "-c", "123", "-t", "T"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown kind 'widget'");
  });

  it("the form body on the wire carries the per-kind names", async () => {
    const recorder = recordingClient({ id: 42, name: "Lab 7" });
    const result = await invoke(
      ["create", "assignment", "-c", "123", "-t", "Lab 7", "-p", "50", "--set", "assignment[grading_type]=points"],
      { makeClient: recorder.makeClient },
    );

    expect(result.code, result.output).toBe(0);
    const [request] = recorder.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://boisestatecanvas.instructure.com/api/v1/courses/123/assignments");
    expect([...(request?.body ?? [])]).toEqual([
      ["assignment[name]", "Lab 7"],
      ["assignment[points_possible]", "50"],
      ["assignment[published]", "false"],
      ["assignment[grading_type]", "points"],
    ]);
  });
});

describe("update", () => {
  it("only the named fields are sent", async () => {
    canvas.updateObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    const result = await invoke(["update", "assignment", "42", "-c", "123", "--points", "40"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    const [kind, courseId, objectId, fields] = canvas.updateObject.mock.calls[0] ?? [];
    expect([kind, courseId, objectId]).toEqual(["assignment", "123", "42"]);
    expect(fields).toEqual({ "assignment[points_possible]": "40" });
  });

  it("an empty update is refused", async () => {
    const result = await invoke(["update", "assignment", "42", "-c", "123"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.output).toContain("Nothing to update");
    expect(canvas.updateObject).not.toHaveBeenCalled();
  });

  it("unpublish sends published false", async () => {
    canvas.updateObject.mockResolvedValue({ id: 42 });
    await invoke(["update", "quiz", "42", "-c", "123", "--unpublish"], { client: canvas });

    expect(canvas.updateObject.mock.calls[0]?.[3]).toEqual({ "quiz[published]": "false" });
  });

  it("publish and unpublish together are refused", async () => {
    const result = await invoke(["update", "quiz", "42", "-c", "123", "--publish", "--unpublish"], {
      client: canvas,
    });

    expect(result.code).toBe(1);
    expect(canvas.updateObject).not.toHaveBeenCalled();
  });
});

describe("publish and unpublish", () => {
  it("publish sets only the published field", async () => {
    canvas.updateObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    const result = await invoke(["publish", "assignment", "42", "-c", "123"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(canvas.updateObject.mock.calls[0]?.[3]).toEqual({ "assignment[published]": "true" });
  });

  it("unpublish addresses a page by slug", async () => {
    canvas.updateObject.mockResolvedValue({ url: "week-1", title: "Week 1" });
    await invoke(["unpublish", "page", "week-1", "-c", "123"], { client: canvas });

    const [, , objectId, fields] = canvas.updateObject.mock.calls[0] ?? [];
    expect(objectId).toBe("week-1");
    expect(fields).toEqual({ "wiki_page[published]": "false" });
  });
});

describe("delete", () => {
  it("it reads the object and asks first", async () => {
    canvas.getObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    const result = await invoke(["delete", "assignment", "42", "-c", "123"], { client: canvas, input: "n\n" });

    expect(result.output).toContain("Lab 7");
    expect(result.output).toContain("submissions and grades");
    expect(result.code).toBe(0);
    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });

  it("confirming deletes", async () => {
    canvas.getObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    canvas.deleteObject.mockResolvedValue({ id: 42 });
    const result = await invoke(["delete", "assignment", "42", "-c", "123"], { client: canvas, input: "y\n" });

    expect(result.code, result.output).toBe(0);
    expect(canvas.deleteObject.mock.calls[0]).toEqual(["assignment", "123", "42"]);
  });

  it("no answer at all leaves it alone", async () => {
    canvas.getObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    await invoke(["delete", "assignment", "42", "-c", "123"], { client: canvas });

    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });

  it("yes skips the prompt", async () => {
    canvas.getObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    canvas.deleteObject.mockResolvedValue({ id: 42 });
    await invoke(["delete", "assignment", "42", "-c", "123", "--yes"], { client: canvas });

    expect(canvas.deleteObject).toHaveBeenCalledOnce();
  });

  it("an unreadable object is never deleted", async () => {
    canvas.getObject.mockRejectedValue(new Error("Canvas API error 404"));
    const result = await invoke(["delete", "assignment", "42", "-c", "123", "--yes"], { client: canvas });

    expect(result.code).toBe(1);
    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });

  it("json after a confirmation is still only the deleted object", async () => {
    canvas.getObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    canvas.deleteObject.mockResolvedValue({ id: 42, name: "Lab 7" });
    const result = await invoke(["delete", "assignment", "42", "-c", "123", "--json"], {
      client: canvas,
      input: "y\n",
    });

    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 42, name: "Lab 7" });
    expect(result.stderr).toContain("Delete it?");
  });
});
