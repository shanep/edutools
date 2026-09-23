/**
 * Tests for course due-date generation.
 *
 * These need no Canvas token: dates.ts is pure computation.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LAYOUT,
  DateConfig,
  DateConfigError,
  ItemDates,
  Layout,
  Term,
  classify,
  compute,
  crossCheckSyllabus,
  isoformat,
  loadConfig,
  loadGroups,
  loadLayout,
  moduleTitle,
  parseHeader,
  resolve,
  validate,
} from "@edutools/core/dates";
import { DateTime } from "luxon";
import { parse as parseToml } from "smol-toml";
import { beforeAll, describe, expect, it } from "vitest";

const CS331 = path.join(os.homedir(), "repos", "CS331");

function tmpRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

function makeTerm(overrides: Partial<ConstructorParameters<typeof Term>[0]> = {}): Term {
  return new Term({
    timezone: "America/Denver",
    firstMonday: "2027-01-11",
    weeks: 15,
    breakAfterWeek: 9,
    lastDayOfInstruction: "2027-04-30",
    finalsStart: "2027-05-03",
    finalsEnd: "2027-05-07",
    ...overrides,
  });
}

function denver(year: number, month: number, day: number, hour = 0, minute = 0): DateTime {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: makeTerm().tz });
}

// Whole calendar days between two timestamps in one zone, the way subtracting
// two Python datetimes that share a tzinfo counts them: by wall clock.
function daysBetween(later: DateTime, earlier: DateTime): number {
  return later.diff(earlier, "days").days;
}

describe("term arithmetic", () => {
  it("week one starts on first monday", () => {
    expect(makeTerm().mondayOf(1)).toBe("2027-01-11");
  });

  it("weeks before the break are consecutive", () => {
    expect(makeTerm().mondayOf(9)).toBe("2027-03-08");
  });

  it("break week is skipped", () => {
    // Week 10 must start Mar 22, matching the promise on the week 9 page.
    expect(makeTerm().mondayOf(10)).toBe("2027-03-22");
  });

  it("last week lands on the final instructional week", () => {
    expect(makeTerm().mondayOf(15)).toBe("2027-04-26");
  });

  it("break monday", () => {
    expect(makeTerm().breakMonday()).toBe("2027-03-15");
  });

  it("week out of range is rejected", () => {
    expect(() => makeTerm().mondayOf(16)).toThrow(DateConfigError);
  });

  it("a term with no break does not skip", () => {
    expect(makeTerm({ breakAfterWeek: null }).mondayOf(10)).toBe("2027-03-15");
  });
});

describe("resolve", () => {
  it("weekday offset", () => {
    const monday = "2027-01-11";
    const tz = makeTerm().tz;
    expect(resolve("mon 00:00", monday, tz).day).toBe(11);
    expect(resolve("fri 23:59", monday, tz).day).toBe(15);
    expect(resolve("sun 23:59", monday, tz).day).toBe(17);
  });

  it("bad spec is rejected", () => {
    expect(() => resolve("someday 23:59", "2027-01-11", makeTerm().tz)).toThrow(DateConfigError);
  });

  it("writes the same ISO string Python's isoformat does", () => {
    const tz = makeTerm().tz;
    expect(isoformat(resolve("sun 23:59", "2027-01-11", tz))).toBe("2027-01-17T23:59:00-07:00");
    expect(isoformat(resolve("wed 23:59", "2026-10-12", tz))).toBe("2026-10-14T23:59:00-06:00");
    expect(isoformat(DateTime.fromObject({ year: 2027, month: 1, day: 1 }, { zone: "UTC" }))).toBe(
      "2027-01-01T00:00:00+00:00",
    );
  });

  it("computes in the term's zone, whatever the machine's zone", () => {
    const tz = new Term({ ...makeTerm(), timezone: "Asia/Tokyo" }).tz;
    expect(isoformat(resolve("mon 00:00", "2027-01-11", tz))).toBe("2027-01-11T00:00:00+09:00");
  });
});

describe("parse header", () => {
  it("weekly item", () => {
    expect(parseHeader("**Week 7 · 38 points · about 90 minutes**")).toEqual([7, 38.0]);
  });

  it("finals item has no week", () => {
    expect(parseHeader("**Finals week · 150 points · 90 minutes**")).toEqual([null, 150.0]);
  });

  it("zero point diagnostic", () => {
    expect(parseHeader("**Week 1 · 0 points · ungraded**")).toEqual([1, 0.0]);
  });

  it("missing header is an error", () => {
    expect(() => parseHeader("# A page with no header line\n\nSome prose.\n")).toThrow(DateConfigError);
  });
});

describe("classify", () => {
  it.each([
    ["assignments/lab-04-symmetric-encryption.md", "lab"],
    ["assignments/midterm-exam-guide.md", "exam"],
    ["assignments/final-exam-guide.md", "exam"],
    ["quizzes/quiz-03-cryptography.md", "quiz"],
    ["discussions/d05-current-security-failure.md", "discussion"],
    ["modules/week-01-what-is-cyber-security.md", null],
    ["data/sqli_demo.py", null],
    // A course whose projects are p0.md, p1.md rather than lab-*.md.
    ["assignments/p0.md", "project"],
    ["assignments/p12.md", "project"],
    // Neither of these is gradable even though it sits under assignments/.
    ["assignments/index.md", null],
    ["assignments/grading-rubric.md", null],
  ])("classifies %s as %s", (file, expected) => {
    expect(classify(file)).toBe(expected);
  });

  it("an exam guide wins over the project glob", () => {
    // Both patterns sit under assignments/; the guide must not become a project.
    expect(classify("assignments/midterm-exam-guide.md")).toBe("exam");
  });

  it("a custom layout replaces the default globs", () => {
    const layout = new Layout({ gradable: [["assignments/hw*.md", "lab"]] });
    expect(classify("assignments/hw3.md", layout)).toBe("lab");
    expect(classify("assignments/lab-01.md", layout)).toBeNull();
  });
});

describe("layout", () => {
  it("an absent section keeps the defaults", () => {
    expect(loadLayout({})).toBe(DEFAULT_LAYOUT);
  });

  it("syllabus can be renamed", () => {
    const layout = loadLayout({ layout: { syllabus: "index.md" } });
    expect(layout.syllabus).toBe("index.md");
    // Everything not named falls back to the default.
    expect(layout.pages).toEqual(DEFAULT_LAYOUT.pages);
  });

  it("globs are read as lists", () => {
    const layout = loadLayout({ layout: { pages: ["notes/*.md"], files: [] } });
    expect(layout.pages).toEqual(["notes/*.md"]);
    expect(layout.files).toEqual([]);
  });

  it("gradable maps kind to glob", () => {
    const layout = loadLayout({ layout: { gradable: { project: "assignments/p*.md" } } });
    expect(layout.gradable).toEqual([["assignments/p*.md", "project"]]);
  });

  it("gradable dirs deduplicates", () => {
    const layout = new Layout({
      gradable: [
        ["assignments/lab-*.md", "lab"],
        ["assignments/p*.md", "project"],
        ["quizzes/quiz-*.md", "quiz"],
      ],
    });
    expect(layout.gradableDirs).toEqual(["assignments", "quizzes"]);
  });

  it("an unknown kind is an error", () => {
    expect(() => loadLayout({ layout: { gradable: { homework: "assignments/hw*.md" } } })).toThrow(
      /not a known item kind/,
    );
  });

  it("a glob list of the wrong shape is an error", () => {
    expect(() => loadLayout({ layout: { pages: "notes/*.md" } })).toThrow(/list of glob strings/);
  });
});

// The generated schedule has to agree with the course as written. Python gates
// this class on canvas.toml alone. The ~/repos/CS331 checkout currently holds
// canvas.toml but none of the course files or syllabus.md it names, and with
// that gate seven of these fail identically in Python and here (no items, a
// missing syllabus). Gating on syllabus.md as well skips the class until the
// course content is back, rather than leaving the suite red.
describe.skipIf(!existsSync(path.join(CS331, "canvas.toml")) || !existsSync(path.join(CS331, "syllabus.md")))(
  "CS331 schedule",
  () => {
    let config: DateConfig;
    let items: ItemDates[];

    beforeAll(() => {
      config = loadConfig(CS331);
      items = compute(CS331, config);
    });

    it("no problems", () => {
      expect(validate(items, config.term)).toEqual([]);
    });

    it("agrees with the syllabus schedule table", () => {
      expect(crossCheckSyllabus(path.join(CS331, "syllabus.md"), config.term)).toEqual([]);
    });

    it("points total one thousand", () => {
      expect(items.reduce((sum, item) => sum + item.points, 0)).toBe(1000);
    });

    it("every item has all three dates in order", () => {
      for (const item of items) {
        expect(item.unlockAt, item.path).not.toBeNull();
        const unlock = item.unlockAt?.toMillis() ?? Number.POSITIVE_INFINITY;
        const due = item.dueAt.toMillis();
        expect(unlock <= due && due <= item.lockAt.toMillis(), item.path).toBe(true);
      }
    });

    it("labs get two days of grace", () => {
      // Except in week 15, where the last day of instruction clamps it.
      const labs = items.filter((i) => i.kind === "lab" && i.week !== 15);
      expect(labs.length, "expected some labs").toBeGreaterThan(0);
      for (const lab of labs) {
        expect(daysBetween(lab.lockAt, lab.dueAt), lab.path).toBe(2);
      }
    });

    it("quizzes and discussions get no grace", () => {
      for (const item of items) {
        if (item.kind === "quiz" || item.kind === "discussion") {
          expect(item.lockAt.equals(item.dueAt), item.path).toBe(true);
        }
      }
    });

    it("nothing from an instructional week locks after the last day", () => {
      const cutoff = DateTime.fromObject(
        { year: 2027, month: 4, day: 30, hour: 23, minute: 59 },
        { zone: config.term.tz },
      );
      for (const item of items) {
        if (item.week !== null) {
          expect(item.lockAt.toMillis() <= cutoff.toMillis(), item.path).toBe(true);
        }
      }
    });

    it("finals week items use the finals window", () => {
      const finals = items.filter((i) => i.week === null);
      expect(finals.length, "the final exam and D6").toBe(2);
      for (const item of finals) {
        expect(item.unlockAt?.toISODate()).toBe("2027-05-03");
        expect(item.dueAt.toISODate()).toBe("2027-05-07");
      }
    });

    it("nothing falls in the break week", () => {
      for (const item of items) {
        for (const stamp of [item.unlockAt, item.dueAt, item.lockAt]) {
          const day = stamp?.toISODate() ?? "";
          expect("2027-03-15" <= day && day <= "2027-03-21", item.path).toBe(false);
        }
      }
    });

    it("daylight saving transition is handled", () => {
      // DST starts Mar 14 2027: weeks 1-9 are MST, weeks 10-15 MDT.
      const byWeek = new Map(items.filter((i) => i.week !== null).map((i) => [i.week, i]));
      expect(byWeek.get(1)?.dueAt.offset).toBe(-7 * 60);
      expect(byWeek.get(10)?.dueAt.offset).toBe(-6 * 60);
      expect(byWeek.get(15)?.dueAt.offset).toBe(-6 * 60);
    });

    it("week fifteen ends on the last day of instruction", () => {
      const week15 = items.filter((i) => i.week === 15);
      expect(week15.length).toBeGreaterThan(0);
      for (const item of week15) {
        expect(item.dueAt.toISODate()).toBe("2027-04-30");
      }
    });

    it("shift moves everything together", () => {
      const shifted = items.map((i) => i.shifted(7));
      items.forEach((before, n) => {
        expect(daysBetween((shifted[n] as ItemDates).dueAt, before.dueAt)).toBe(7);
      });
    });
  },
);

describe("validation", () => {
  it("out of order dates are reported", () => {
    const bad = new ItemDates({
      path: "assignments/lab-x.md",
      title: "Lab X",
      kind: "lab",
      week: 1,
      points: 1000,
      unlockAt: denver(2027, 1, 20),
      dueAt: denver(2027, 1, 15),
      lockAt: denver(2027, 1, 17),
    });
    const problems = validate([bad], makeTerm());
    expect(problems.some((p) => p.includes("out of order"))).toBe(true);
  });

  it("first monday must be a monday", () => {
    const repo = tmpRepo();
    writeFileSync(
      path.join(repo, "canvas.toml"),
      "[term]\n" +
        'timezone = "America/Denver"\n' +
        "first_monday = 2027-01-12\n" +
        "weeks = 15\n" +
        "last_day_of_instruction = 2027-04-30\n" +
        "finals_start = 2027-05-03\n" +
        "finals_end = 2027-05-07\n" +
        'policy.lab = { unlock = "mon 00:00", due = "sun 23:59", grace_days = 2 }\n',
    );
    expect(() => loadConfig(repo)).toThrow(/not a Monday/);
    expect(() => loadConfig(repo)).toThrow("2027-01-12 is a Tuesday");
  });

  it("missing canvas toml", () => {
    expect(() => loadConfig(tmpRepo())).toThrow(/no canvas.toml/);
  });
});

// CS331 grades out of a fixed 1000; CS425 grades by weighted groups instead.
describe("total points", () => {
  function item(points: number): ItemDates {
    const due = denver(2027, 1, 15, 23, 59);
    return new ItemDates({
      path: "assignments/p0.md",
      title: "P0",
      kind: "project",
      week: 1,
      points,
      unlockAt: due.minus({ days: 4 }),
      dueAt: due,
      lockAt: due,
    });
  }

  it("the default total is still checked", () => {
    const problems = validate([item(850)], makeTerm());
    expect(problems.some((p) => p.includes("not 1000"))).toBe(true);
  });

  it("a custom total is checked against", () => {
    const problems = validate([item(850)], makeTerm({ totalPoints: 850 }));
    expect(problems.some((p) => p.includes("sum to"))).toBe(false);
  });

  it("zero disables the check", () => {
    const problems = validate([item(37)], makeTerm({ totalPoints: 0 }));
    expect(problems.some((p) => p.includes("sum to"))).toBe(false);
  });
});

// A policy with no `unlock` leaves Canvas's "Available from" blank.
describe("optional unlock", () => {
  function setup(unlockLine: string): [string, DateConfig] {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, "assignments"), { recursive: true });
    writeFileSync(path.join(repo, "assignments", "p0.md"), "# P0\n\n**Week 2 · 50 points · x**\n", "utf-8");
    writeFileSync(
      path.join(repo, "canvas.toml"),
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\n" +
        "weeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\n" +
        "finals_end = 2026-12-18\n" +
        "total_points = 0\n\n" +
        "[term.policy.project]\n" +
        `${unlockLine}` +
        'due = "tue 23:59"\n' +
        "grace_days = 2\n\n" +
        "[layout]\n" +
        'syllabus = "index.md"\n\n' +
        "[layout.gradable]\n" +
        'project = "assignments/p[0-9]*.md"\n',
      "utf-8",
    );
    return [repo, loadConfig(repo)];
  }

  function first(repo: string, config: DateConfig): ItemDates {
    return compute(repo, config)[0] as ItemDates;
  }

  it("an absent unlock yields no unlock date", () => {
    const [repo, config] = setup("");
    expect(config.policies.project?.unlock).toBeNull();
    const item = first(repo, config);
    expect(item.unlockAt).toBeNull();
    expect(item.dueAt).not.toBeNull();
  });

  it("a present unlock still works", () => {
    const [repo, config] = setup('unlock = "mon 00:00"\n');
    const item = first(repo, config);
    expect(item.unlockAt).not.toBeNull();
    expect(item.unlockAt?.hour).toBe(0);
  });

  it("validate accepts an item with no unlock", () => {
    const [repo, config] = setup("");
    expect(validate(compute(repo, config), config.term)).toEqual([]);
  });

  it("validate still catches due after lock", () => {
    const [repo, config] = setup("");
    const item = first(repo, config);
    const broken = new ItemDates({ ...item, unlockAt: null, lockAt: item.dueAt.minus({ days: 1 }) });
    expect(validate([broken], config.term).some((p) => p.includes("out of order"))).toBe(true);
  });

  it("shifting keeps the absent unlock", () => {
    const [repo, config] = setup("");
    expect(first(repo, config).shifted(3).unlockAt).toBeNull();
  });

  it("sends Canvas the Boise offset of the due date", () => {
    const [repo, config] = setup("");
    // Week 2 starts Aug 31 2026; Tuesday is Sep 1, in MDT.
    expect(isoformat(first(repo, config).dueAt)).toBe("2026-09-01T23:59:00-06:00");
  });
});

// [[group]] declares the Canvas assignment groups and their weights.
describe("assignment groups", () => {
  const raw = (toml: string): Record<string, unknown> => parseToml(toml);

  it("no group section declares nothing", () => {
    expect(loadGroups(raw("[term]\n"))).toEqual([]);
  });

  it("a group keeps its name weight and kinds", () => {
    const groups = loadGroups(raw('[[group]]\nname = "Projects"\nweight = 10\nkinds = ["project"]\n'));
    expect(groups).toEqual([{ name: "Projects", weight: 10.0, kinds: ["project"] }]);
  });

  it("declaration order is kept", () => {
    const groups = loadGroups(raw('[[group]]\nname = "Exams"\n\n[[group]]\nname = "Projects"\n'));
    expect(groups.map((group) => group.name)).toEqual(["Exams", "Projects"]);
  });

  it("a group needs neither weight nor kinds", () => {
    // An exam group whose quizzes are built by hand still has to exist.
    const groups = loadGroups(raw('[[group]]\nname = "Exams"\n'));
    expect(groups[0]?.weight).toBeNull();
    expect(groups[0]?.kinds).toEqual([]);
  });

  it("group for finds the group of a kind", () => {
    const config = new DateConfig({
      term: makeTerm(),
      policies: {},
      overrides: {},
      groups: loadGroups(raw('[[group]]\nname = "In Class"\nkinds = ["lab", "discussion"]\n')),
    });
    const found = config.groupFor("lab");
    expect(found?.name).toBe("In Class");
    expect(config.groupFor("project")).toBeNull();
  });

  it("total weight adds the declared weights", () => {
    const config = new DateConfig({
      term: makeTerm(),
      policies: {},
      overrides: {},
      groups: loadGroups(
        raw(
          '[[group]]\nname = "Exams"\nweight = 50\n\n' +
            '[[group]]\nname = "Projects"\nweight = 10\n\n' +
            '[[group]]\nname = "Ungraded"\n',
        ),
      ),
    });
    expect(config.totalWeight).toBe(60.0);
  });

  it("two groups cannot claim the same kind", () => {
    expect(() =>
      loadGroups(raw('[[group]]\nname = "A"\nkinds = ["lab"]\n\n[[group]]\nname = "B"\nkinds = ["lab"]\n')),
    ).toThrow(/claimed by both/);
  });

  it("an unknown kind is rejected", () => {
    expect(() => loadGroups(raw('[[group]]\nname = "A"\nkinds = ["homework"]\n'))).toThrow(
      /not a known item kind/,
    );
  });

  it("a duplicate group name is rejected", () => {
    expect(() => loadGroups(raw('[[group]]\nname = "A"\n\n[[group]]\nname = "A"\n'))).toThrow(/declared twice/);
  });

  it("a nameless group is rejected", () => {
    expect(() => loadGroups(raw("[[group]]\nweight = 10\n"))).toThrow(/non-empty string/);
  });

  it("a non numeric weight is rejected", () => {
    expect(() => loadGroups(raw('[[group]]\nname = "A"\nweight = "lots"\n'))).toThrow(/weight must be a number/);
  });

  it("groups load from canvas toml", () => {
    const repo = tmpRepo();
    writeFileSync(
      path.join(repo, "canvas.toml"),
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\nweeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\nfinals_end = 2026-12-18\n\n" +
        '[term.policy.lab]\ndue = "wed 23:59"\n\n' +
        '[[group]]\nname = "In Class"\nweight = 40\nkinds = ["lab"]\n',
      "utf-8",
    );
    const found = loadConfig(repo).groupFor("lab");
    expect(found?.name).toBe("In Class");
    expect(found?.weight).toBe(40.0);
  });
});

// A draft is not a Canvas object, so it never gets a due date.
describe("drafts take no dates", () => {
  function makeRepo(a1Frontmatter: string): string {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, "activities"), { recursive: true });
    writeFileSync(
      path.join(repo, "activities", "a1-devbox.md"),
      `${a1Frontmatter}# A1\n\n**Week 1 · 20 points · x**\n`,
      "utf-8",
    );
    writeFileSync(path.join(repo, "activities", "a2-sockets.md"), "# A2\n\n**Week 3 · 20 points · x**\n", "utf-8");
    writeFileSync(
      path.join(repo, "canvas.toml"),
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\n" +
        "weeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\n" +
        "finals_end = 2026-12-18\n" +
        "total_points = 0\n\n" +
        "[term.policy.lab]\n" +
        'due = "wed 23:59"\n' +
        "grace_days = 0\n\n" +
        "[layout]\n" +
        'syllabus = "index.md"\n\n' +
        "[layout.gradable]\n" +
        'lab = "activities/a[0-9]*.md"\n',
      "utf-8",
    );
    return repo;
  }

  it("a draft is left out", () => {
    const repo = makeRepo("---\ndraft: true\n---\n\n");
    expect(compute(repo).map((item) => item.path)).toEqual(["activities/a2-sockets.md"]);
  });

  it("the same file counts once the flag comes off", () => {
    const repo = makeRepo("---\nnext: false\n---\n\n");
    expect(compute(repo)).toHaveLength(2);
  });

  it("a draft needs no header line", () => {
    // Half written work has no "**Week N · P points**" line yet, and demanding
    // one would mean a draft could not be committed until it was finished.
    const repo = makeRepo("");
    writeFileSync(
      path.join(repo, "activities", "a1-devbox.md"),
      "---\ndraft: true\n---\n\n# A1\n\nStill thinking about this one.\n",
      "utf-8",
    );
    expect(compute(repo).map((item) => item.path)).toEqual(["activities/a2-sockets.md"]);
  });
});

describe("module title", () => {
  it("no week leaves the title alone", () => {
    expect(moduleTitle({ title: "Course Resources" }, makeTerm())).toBe("Course Resources");
  });

  it("a week appends monday to sunday", () => {
    const title = moduleTitle({ title: "Module 1: Intro", week: 1 }, makeTerm());
    expect(title).toBe("Module 1: Intro (January 11 - January 17)");
  });

  it("the break week is skipped", () => {
    // Week 10 follows the break after week 9, so it starts a week late.
    expect(moduleTitle({ title: "M", week: 10 }, makeTerm())).toBe("M (March 22 - March 28)");
  });

  it("the last week stops at the last day of instruction", () => {
    expect(moduleTitle({ title: "M", week: 15 }, makeTerm())).toBe("M (April 26 - April 30)");
  });

  it("finals uses the finals window", () => {
    expect(moduleTitle({ title: "F", week: "finals" }, makeTerm())).toBe("F (May 3 - May 7)");
  });

  it("a bad week is a config error", () => {
    expect(() => moduleTitle({ title: "M", week: "three" }, makeTerm())).toThrow(DateConfigError);
    expect(() => moduleTitle({ title: "M", week: 16 }, makeTerm())).toThrow(DateConfigError);
  });
});
