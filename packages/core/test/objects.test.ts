import {
  FieldError,
  GradeRow,
  buildFields,
  formatG,
  parseGrades,
  parseOverrides,
  specFor,
} from "@edutools/core/objects";
import { describe, expect, it } from "vitest";

// Each kind names the shared fields the way its own endpoint does.
describe("specs", () => {
  it("unknown kind is rejected", () => {
    expect(() => specFor("rubric")).toThrow(FieldError);
    expect(() => specFor("rubric")).toThrow(/unknown kind/);
  });

  it.each([
    ["page", { "wiki_page[title]": "Week 1" }],
    ["assignment", { "assignment[name]": "Week 1" }],
    ["discussion", { title: "Week 1" }], // discussions take bare params
    ["quiz", { "quiz[title]": "Week 1" }],
    ["module", { "module[name]": "Week 1" }],
  ])("title key for a %s", (kind, expected) => {
    expect(buildFields(kind, { title: "Week 1" })).toEqual(expected);
  });
});

describe("build fields", () => {
  it("omits everything not passed", () => {
    // An update must not clear fields the caller never mentioned.
    expect(buildFields("assignment", { title: "Lab 1" })).toEqual({ "assignment[name]": "Lab 1" });
  });

  it("nothing passed builds nothing", () => {
    expect(buildFields("assignment")).toEqual({});
  });

  it("body uses the per kind name", () => {
    expect(buildFields("assignment", { body: "<p>hi</p>" })).toEqual({ "assignment[description]": "<p>hi</p>" });
    expect(buildFields("discussion", { body: "<p>hi</p>" })).toEqual({ message: "<p>hi</p>" });
    expect(buildFields("page", { body: "<p>hi</p>" })).toEqual({ "wiki_page[body]": "<p>hi</p>" });
  });

  it("module has no body", () => {
    expect(() => buildFields("module", { body: "<p>hi</p>" })).toThrow(/no body/);
  });

  it("graded discussion points hang off the assignment", () => {
    expect(buildFields("discussion", { points: 25 })).toEqual({ "assignment[points_possible]": "25" });
  });

  it("points format drops trailing zeros", () => {
    expect(buildFields("assignment", { points: 12.5 })).toEqual({ "assignment[points_possible]": "12.5" });
  });

  it("quiz points come from its questions", () => {
    expect(() => buildFields("quiz", { points: 10 })).toThrow(/scores from its questions/);
  });

  it("page takes no points", () => {
    expect(() => buildFields("page", { points: 10 })).toThrow(/takes no points/);
  });

  it("dates use the kinds prefix", () => {
    expect(buildFields("quiz", { due: "2026-09-15T23:59:00-06:00" })).toEqual({
      "quiz[due_at]": "2026-09-15T23:59:00-06:00",
    });
    expect(buildFields("discussion", { due: "2026-09-15T23:59:00-06:00" })).toEqual({
      "assignment[due_at]": "2026-09-15T23:59:00-06:00",
    });
  });

  it("all three dates", () => {
    const fields = buildFields("assignment", { due: "2026-09-15", unlock: "2026-09-08", lock: "2026-09-22" });
    expect(fields).toEqual({
      "assignment[due_at]": "2026-09-15",
      "assignment[unlock_at]": "2026-09-08",
      "assignment[lock_at]": "2026-09-22",
    });
  });

  it("page has no dates", () => {
    expect(() => buildFields("page", { due: "2026-09-15" })).toThrow(/no due \/ available dates/);
  });

  it("published is lowercase for canvas", () => {
    expect(buildFields("assignment", { published: true })).toEqual({ "assignment[published]": "true" });
    expect(buildFields("assignment", { published: false })).toEqual({ "assignment[published]": "false" });
    expect(buildFields("discussion", { published: true })).toEqual({ published: "true" });
  });

  it("position is modules only", () => {
    expect(buildFields("module", { position: 3 })).toEqual({ "module[position]": "3" });
    expect(() => buildFields("assignment", { position: 3 })).toThrow(/only modules are ordered/);
  });

  it("overrides reach fields the flags do not model", () => {
    const fields = buildFields("assignment", {
      title: "Lab 1",
      overrides: { "assignment[submission_types][]": "online_upload" },
    });
    expect(fields["assignment[submission_types][]"]).toBe("online_upload");
  });

  it("overrides win", () => {
    const fields = buildFields("assignment", { points: 10, overrides: { "assignment[points_possible]": "99" } });
    expect(fields["assignment[points_possible]"]).toBe("99");
  });

  it("formats numbers the way Python's :g does", () => {
    expect(formatG(25)).toBe("25");
    expect(formatG(12.5)).toBe("12.5");
    expect(formatG(0.1)).toBe("0.1");
    expect(formatG(1000)).toBe("1000");
    expect(formatG(1234567)).toBe("1.23457e+06");
    expect(formatG(0.00001)).toBe("1e-05");
  });
});

describe("parse overrides", () => {
  it("splits on the first equals", () => {
    expect(parseOverrides(["assignment[name]=a=b"])).toEqual({ "assignment[name]": "a=b" });
  });

  it("empty value is allowed", () => {
    expect(parseOverrides(["assignment[due_at]="])).toEqual({ "assignment[due_at]": "" });
  });

  it("none is empty", () => {
    expect(parseOverrides(null)).toEqual({});
  });

  it("missing equals is rejected", () => {
    expect(() => parseOverrides(["assignment[name]"])).toThrow(/key=value/);
  });
});

describe("grade row", () => {
  it("a row that would send nothing is rejected", () => {
    expect(() => new GradeRow({ userId: "789" })).toThrow(/nothing to apply/);
  });

  it("a comment alone is enough", () => {
    // Feedback with no number on it is a real thing to want.
    expect(new GradeRow({ userId: "789", comment: "See notes." }).grade).toBeNull();
  });

  it("an excusal alone is enough", () => {
    expect(new GradeRow({ userId: "789", excuse: true }).excuse).toBe(true);
  });
});

describe("parse grades", () => {
  it("list of objects", () => {
    const rows = parseGrades('[{"student": 789, "score": 18, "comment": "Clean tests."}]');
    expect(rows).toEqual([new GradeRow({ userId: "789", grade: "18", comment: "Clean tests." })]);
  });

  it("aliases are matched loosely", () => {
    for (const key of ["user_id", "student_id", "student", "id"]) {
      expect(parseGrades(`[{"${key}": 7, "grade": 1}]`)[0]?.userId).toBe("7");
    }
    for (const key of ["grade", "score", "posted_grade", "points"]) {
      expect(parseGrades(`[{"student": 7, "${key}": 18}]`)[0]?.grade).toBe("18");
    }
    for (const key of ["comment", "feedback", "text_comment"]) {
      expect(parseGrades(`[{"student": 7, "${key}": "ok"}]`)[0]?.comment).toBe("ok");
    }
  });

  it("object keyed by student", () => {
    const rows = parseGrades('{"789": {"score": 18}, "790": {"score": 20}}');
    expect(rows.map((r) => [r.userId, r.grade])).toEqual([
      ["789", "18"],
      ["790", "20"],
    ]);
  });

  it("object keyed by student with a bare grade", () => {
    const rows = parseGrades('{"789": 18}');
    expect(rows).toEqual([new GradeRow({ userId: "789", grade: "18" })]);
  });

  it("an inner user id beats the key", () => {
    const rows = parseGrades('{"ignored": {"user_id": 789, "score": 18}}');
    expect(rows[0]?.userId).toBe("789");
  });

  it("excuse accepts the spellings a spreadsheet produces", () => {
    for (const value of ["true", "TRUE", "yes", "1"]) {
      expect(parseGrades(`[{"student": 7, "excuse": "${value}"}]`)[0]?.excuse).toBe(true);
    }
    expect(parseGrades('[{"student": 7, "score": 0, "excuse": "no"}]')[0]?.excuse).toBe(false);
  });

  it("rubric is carried through", () => {
    const rows = parseGrades('[{"student": 7, "rubric": {"crit_1": {"points": 4}}}]');
    expect(rows[0]?.rubric).toEqual({ crit_1: { points: 4 } });
  });

  it("rubric must be an object", () => {
    expect(() => parseGrades('[{"student": 7, "rubric": [1, 2]}]')).toThrow(/must be an object/);
  });

  it("missing student id is rejected", () => {
    expect(() => parseGrades('[{"score": 18}]')).toThrow(/missing a student id/);
  });

  it("row with nothing to apply is rejected", () => {
    expect(() => parseGrades('[{"student": 7}]')).toThrow(/nothing to apply/);
  });

  it("bad json is reported as such", () => {
    expect(() => parseGrades("{oops")).toThrow(/not valid JSON/);
  });

  it("a bare list of scalars is rejected", () => {
    expect(() => parseGrades("[1, 2]")).toThrow(/expected a list of objects/);
  });

  it("a json scalar is rejected", () => {
    expect(() => parseGrades('"18"')).toThrow(/expected a JSON list/);
  });

  it("csv with a header", () => {
    const rows = parseGrades("student_id,score,comment\n789,18,Clean tests.\n790,20,\n", { asCsv: true });
    expect(rows[0]).toEqual(new GradeRow({ userId: "789", grade: "18", comment: "Clean tests." }));
    expect(rows[1]).toEqual(new GradeRow({ userId: "790", grade: "20", comment: null }));
  });

  it("csv without rows is rejected", () => {
    expect(() => parseGrades("student_id,score\n", { asCsv: true })).toThrow(/header row/);
  });

  it("csv quoting follows RFC 4180", () => {
    const text =
      'student_id,score,comment\r\n789,18,"Good, but see ""notes"".\nSecond line."\r\n\r\n790,"20",plain\r\n';
    const rows = parseGrades(text, { asCsv: true });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.comment).toBe('Good, but see "notes".\nSecond line.');
    expect(rows[1]?.grade).toBe("20");
    expect(rows[1]?.comment).toBe("plain");
  });
});
