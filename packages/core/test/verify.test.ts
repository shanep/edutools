/**
 * Tests for the post-publish verification pass.
 *
 * Each check is fed a known-good Canvas payload and a known-mangled one, so we
 * know the check actually fires rather than merely existing.
 */

import { Entry } from "@edutools/core/publish";
import type { Payload } from "@edutools/core/types";
import {
  checkBody,
  checkFile,
  checkGradebookTotal,
  checkIdentity,
  checkLinks,
  checkMetadata,
  checkModule,
  checkModuleMembership,
  checkModuleVisibility,
  checkOverrides,
  checkQuizQuestions,
  type Intent,
  type ModuleSlot,
  summarise,
} from "@edutools/core/verify";
import { describe, expect, it } from "vitest";

const GOOD = '<h2>Read</h2><table><tr><td>CyBOK §10.4</td></tr></table><p style="color: red">x</p>';

describe("identity", () => {
  it("reports a missing object", () => {
    const failures = checkIdentity("k", new Entry({ kind: "page", canvasId: "1", title: "Week 1" }), null);
    expect(failures[0]?.check).toBe("missing");
  });

  it("reports a title mismatch", () => {
    const failures = checkIdentity("k", new Entry({ kind: "page", canvasId: "1", title: "Week 1" }), {
      title: "Week Two",
    });
    expect(failures[0]?.check).toBe("title");
    expect(failures[0]?.detail).toBe("expected 'Week 1', Canvas has 'Week Two'");
  });

  it("passes a matching title", () => {
    expect(
      checkIdentity("k", new Entry({ kind: "page", canvasId: "1", title: "Week 1" }), { title: "Week 1" }),
    ).toEqual([]);
  });
});

describe("body", () => {
  it("passes an identical body", () => {
    expect(checkBody("k", GOOD, GOOD)).toEqual([]);
  });

  it("is not tripped by Canvas added attributes", () => {
    const stored = GOOD.replace("<td>", '<td data-api-endpoint="https://x" data-api-returntype="Page">');
    expect(checkBody("k", GOOD, stored)).toEqual([]);
  });

  it("is not tripped by whitespace differences", () => {
    expect(checkBody("k", GOOD, GOOD.replace("<h2>", "\n  <h2>\n  "))).toEqual([]);
  });

  it("catches dropped text", () => {
    const stored = GOOD.replace("CyBOK §10.4", "");
    const checks = new Set(checkBody("k", GOOD, stored).map((f) => f.check));
    expect(checks.has("content")).toBe(true);
  });

  it("catches a dropped table", () => {
    const stored = GOOD.replace("<table><tr><td>CyBOK §10.4</td></tr></table>", "<p>CyBOK §10.4</p>");
    const checks = new Set(checkBody("k", GOOD, stored).map((f) => f.check));
    expect(checks.has("structure")).toBe(true);
  });

  it("catches a stripped style, the silent failure the styling phase is most exposed to", () => {
    const stored = GOOD.replace(' style="color: red"', "");
    const failures = checkBody("k", GOOD, stored);
    expect(failures.some((f) => f.check === "styles")).toBe(true);
    expect(failures.some((f) => f.check === "styles" && f.detail.includes("color:red"))).toBe(true);
  });
});

describe("links", () => {
  it("passes a known target", async () => {
    const html = '<a href="/courses/42/pages/week-01">x</a>';
    expect(await checkLinks("k", html, "42", new Set(["/courses/42/pages/week-01"]), () => false)).toEqual([]);
  });

  it("passes an unknown but resolvable target", async () => {
    const html = '<a href="/courses/42/assignments/9">x</a>';
    expect(await checkLinks("k", html, "42", new Set(), () => true)).toEqual([]);
  });

  it("catches a dangling link", async () => {
    const html = '<a href="/courses/42/assignments/9">x</a>';
    const failures = await checkLinks("k", html, "42", new Set(), async () => false);
    expect(failures[0]?.check).toBe("link");
  });

  it("ignores external links", async () => {
    const html = '<a href="https://cybok.org">x</a>';
    expect(await checkLinks("k", html, "42", new Set(), () => false)).toEqual([]);
  });
});

describe("metadata", () => {
  const intent = (fields: Partial<Intent> = {}): Intent => ({ key: "k", kind: "assignment", title: "Lab 4", ...fields });

  it("compares dates as instants, so Canvas's UTC copy of a local date passes", () => {
    const failures = checkMetadata("k", intent({ points: 38, published: false, dueAt: "2027-02-28T23:59:00-07:00" }), {
      points_possible: 38,
      published: false,
      due_at: "2027-03-01T06:59:00Z",
    });
    expect(failures).toEqual([]);
  });

  it("ignores the seconds the Canvas date picker adds to 11:59 PM", () => {
    const failures = checkMetadata("k", intent({ dueAt: "2027-02-28T23:59:00-07:00" }), {
      due_at: "2027-03-01T06:59:59Z",
    });
    expect(failures).toEqual([]);
  });

  it("catches a date moved in Canvas", () => {
    const failures = checkMetadata("k", intent({ dueAt: "2027-02-28T23:59:00-07:00" }), {
      due_at: "2027-03-02T06:59:00Z",
    });
    expect(failures.map((f) => f.check)).toEqual(["due_at"]);
    expect(failures[0]?.detail).toBe("expected 2027-02-28T23:59:00-07:00, Canvas has 2027-03-02T06:59:00Z");
  });

  it("leaves visibility alone when the intent does not decide it", () => {
    expect(checkMetadata("k", intent({ points: 38 }), { points_possible: 38, published: true })).toEqual([]);
  });

  it("catches wrong points", () => {
    const failures = checkMetadata("k", intent({ points: 38 }), { points_possible: 30 });
    expect(failures[0]?.check).toBe("points");
    expect(failures[0]?.detail).toBe("expected 38, Canvas has 30.0");
  });

  it("catches an accidentally published object", () => {
    const failures = checkMetadata("k", intent({ published: false }), { published: true });
    expect(failures.some((f) => f.check === "published")).toBe(true);
    expect(failures[0]?.detail).toBe("expected published=False, Canvas has True");
  });

  it("passes an exact date match", () => {
    expect(checkMetadata("k", intent({ dueAt: "2027-02-28T23:59:00Z" }), { due_at: "2027-02-28T23:59:00Z" })).toEqual(
      [],
    );
  });
});

describe("overrides", () => {
  const base: Payload = { due_at: "2026-09-19T05:59:00Z", lock_at: "2026-09-21T05:59:00Z" };

  it("lists an extension in the course's time zone and does not fail it", () => {
    const { note, failures } = checkOverrides(
      "k",
      base,
      [{ title: "1 student", due_at: "2026-09-19T05:59:59Z", lock_at: "2026-09-24T05:59:59Z" }],
      "America/Boise",
    );
    expect(failures).toEqual([]);
    expect(note).toEqual({ key: "k", detail: "1 override: 1 student (due Sep 18 23:59, lock Sep 23 23:59)" });
  });

  it("fails an override that now ends before the class does", () => {
    const { failures } = checkOverrides(
      "k",
      { ...base, lock_at: "2026-09-28T05:59:00Z" },
      [{ title: "1 student", lock_at: "2026-09-24T05:59:59Z" }],
      "America/Boise",
    );
    expect(failures.map((f) => [f.check, f.detail])).toEqual([
      ["override", "1 student: lock Sep 23 23:59 is earlier than the class's Sep 27 23:59"],
    ]);
  });

  it("says nothing for an assignment with no overrides", () => {
    expect(checkOverrides("k", base, [], "America/Boise")).toEqual({ note: null, failures: [] });
  });
});

describe("quiz questions", () => {
  const q = (fields: Payload = {}): Payload => ({
    question_name: "Q1",
    question_type: "multiple_choice_question",
    neutral_comments: "because",
    answers: [{ weight: 100 }, { weight: 0 }],
    ...fields,
  });

  it("passes a complete quiz", () => {
    expect(checkQuizQuestions("k", 2, [q(), q()])).toEqual([]);
  });

  it("catches a partial write, a quiz that got 12 of its 15 questions", () => {
    const failures = checkQuizQuestions("k", 15, Array.from({ length: 12 }, () => q()));
    expect(failures.some((f) => f.check === "questions")).toBe(true);
  });

  it("catches an unkeyed answer", () => {
    const failures = checkQuizQuestions("k", 1, [q({ answers: [{ weight: 0 }, { weight: 0 }] })]);
    expect(failures.some((f) => f.detail.includes("no correct answer"))).toBe(true);
  });

  it("catches multiple choice with two correct answers", () => {
    const failures = checkQuizQuestions("k", 1, [q({ answers: [{ weight: 100 }, { weight: 100 }] })]);
    expect(failures.some((f) => f.detail.includes("2 correct"))).toBe(true);
  });

  it("catches a missing rationale", () => {
    const failures = checkQuizQuestions("k", 1, [q({ neutral_comments: "" })]);
    expect(failures.some((f) => f.check === "rationale")).toBe(true);
  });
});

describe("files", () => {
  it("passes a complete upload", () => {
    expect(checkFile("k", 21703405, { size: 21703405, upload_status: "success" })).toEqual([]);
  });

  it("catches a truncated upload, the 21 MB CyBOK PDF arriving short", () => {
    const failures = checkFile("k", 21703405, { size: 1048576, upload_status: "success" });
    expect(failures[0]?.detail).toContain("21703405");
  });

  it("catches a pending upload", () => {
    const failures = checkFile("k", 100, { size: 100, upload_status: "pending" });
    expect(failures.some((f) => f.detail.includes("not available"))).toBe(true);
    expect(failures[0]?.detail).toBe("upload state is 'pending', not available");
  });
});

describe("modules and gradebook", () => {
  const slots: ModuleSlot[] = [
    { type: "SubHeader", ident: "Due Thursday", title: "Due Thursday" },
    { type: "Page", ident: "week-1", title: "Week 1" },
    { type: "Assignment", ident: "7", title: "P0" },
  ];
  const live = (): Payload[] => [
    { position: 1, type: "SubHeader", title: "Due Thursday" },
    { position: 2, type: "Page", page_url: "week-1", title: "Week 1" },
    { position: 3, type: "Assignment", content_id: 7, title: "P0" },
  ];

  it("passes a module with the right items", () => {
    expect(checkModule("k", slots, live())).toEqual([]);
  });

  it("catches a missing module item", () => {
    const failures = checkModule("k", slots, live().slice(0, 1));
    expect(failures[0]?.detail).toContain("expected 3 items");
  });

  it("catches out of order items", () => {
    const items = live();
    items.reverse();
    const failures = checkModule("k", slots, items);
    expect(failures.some((f) => f.detail.includes("out of order"))).toBe(true);
  });

  it("names the first item that differs, and only that one", () => {
    const items = live();
    items.splice(1, 0, { position: 2, type: "ExternalUrl", external_url: "https://x.org", title: "Slides" });
    const failures = checkModule("k", slots, items);
    expect(failures.map((f) => f.detail)).toEqual([
      "expected 3 items, Canvas has 4",
      "item 2: expected Page 'Week 1', Canvas has ExternalUrl 'Slides'",
    ]);
  });

  it("catches a module published against canvas.toml", () => {
    expect(checkModuleVisibility("k", false, { published: false })).toEqual([]);
    expect(checkModuleVisibility("k", false, { published: true })[0]?.check).toBe("published");
  });

  it("passes a gradebook that adds up", () => {
    expect(checkGradebookTotal([{ points_possible: 400 }, { points_possible: 600 }], 1000)).toEqual([]);
  });

  it("catches a gradebook shortfall", () => {
    const failures = checkGradebookTotal([{ points_possible: 962 }], 1000);
    expect(failures[0]?.detail).toContain("962");
    expect(failures[0]?.detail).toBe("points total 962, expected 1000");
  });

  it("passes when every item is in a module", () => {
    expect(checkModuleMembership([])).toEqual([]);
  });

  it("fails an item in no module", () => {
    const failures = checkModuleMembership(["assignments/lab-03.md", "assignments/lab-04.md"]);
    expect(failures.map((f) => f.key)).toEqual(["assignments/lab-03.md", "assignments/lab-04.md"]);
    expect(failures.every((f) => f.check === "module" && f.detail.includes("no [[module]]"))).toBe(true);
  });
});

it("summarise groups by check", () => {
  const failures = [
    ...checkIdentity("a", new Entry({ kind: "page", canvasId: "1", title: "X" }), null),
    ...checkIdentity("b", new Entry({ kind: "page", canvasId: "2", title: "Y" }), null),
    ...checkGradebookTotal([{ points_possible: 1 }], 1000),
  ];
  expect(summarise(failures)).toEqual({ missing: 2, gradebook: 1 });
});

describe("rationale field: Canvas fills neutral_comments or neutral_comments_html, never both", () => {
  const stored = (comments: Record<string, string> = {}): Payload[] => [
    {
      question_name: "Q1",
      question_type: "multiple_choice_question",
      question_text: "<p>s</p>",
      answers: [{ text: "a", weight: 100.0 }],
      neutral_comments: "",
      neutral_comments_html: "",
      ...comments,
    },
  ];

  it("passes a plain rationale", () => {
    const failures = checkQuizQuestions("q.md", 1, stored({ neutral_comments: "because" }));
    expect(failures.filter((f) => f.check === "rationale")).toEqual([]);
  });

  it("passes a rendered rationale", () => {
    const failures = checkQuizQuestions("q.md", 1, stored({ neutral_comments_html: "<p>because</p>" }));
    expect(failures.filter((f) => f.check === "rationale")).toEqual([]);
  });

  it("still fails no rationale at all", () => {
    const failures = checkQuizQuestions("q.md", 1, stored());
    expect(failures.filter((f) => f.check === "rationale").length).toBeGreaterThan(0);
  });
});
