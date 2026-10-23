/**
 * An objectives page as an objective alignment sheet: which parts of the page
 * become rows, and the CSV Drive turns into a Google Sheet.
 */

import { ALIGNMENT_HEADER, alignmentCsv, parseObjectives, plainText } from "@edutools/core/alignment";
import { describe, expect, it } from "vitest";

const PAGE = `# CS 999: Objectives

## How this page maps to the spreadsheet

| Spreadsheet column | Where it appears here |
| --- | --- |
| A: Obj. # | The # column |

## TLO 1: Security goals

> **The student will be able to** explain core security goals
> and terminology.

*Introduced in this course · Required · Bloom: Understand · Knowledge type: Concept*

| # | Location in course | The student will be able to… | Bloom | Knowledge type | How it will be assessed |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Week 1: [Lab 0](assignments/lab-00.md) | Define *integrity*. | Remember | Fact | Lab 0 rubric row 3 |
| 1.2 | Weeks 1 and 2: [D1](d1.md) and [D2](d2.md) | Use \`risk\` correctly. | Understand | Concept | D1 row 1 |

**Notes.** Carried forward into every lab,
and every discussion.

---

## Reverse index

| Week | Assessment |
| --- | --- |
| 1 | Lab 0 |
`;

describe("parseObjectives", () => {
  const rows = parseObjectives(PAGE);

  it("makes a row for the terminal objective and one per supporting objective, and nothing else", () => {
    expect(rows.map((row) => row.number)).toEqual(["TLO: 1", "1.1", "1.2"]);
  });

  it("reads the terminal objective from the quote, its facets and its notes", () => {
    expect(rows[0]).toEqual({
      number: "TLO: 1",
      objective: "Explain core security goals and terminology.",
      introduced: "Introduced in this course",
      required: "Required",
      bloom: "Understand",
      knowledge: "Concept",
      assessed: "",
      location: "",
      notes: "Carried forward into every lab, and every discussion.",
    });
  });

  it("matches table columns by header, whatever their order", () => {
    expect(rows[1]).toMatchObject({
      objective: "Define *integrity*.",
      introduced: "Introduced in this course",
      bloom: "Remember",
      knowledge: "Fact",
      assessed: "Lab 0 rubric row 3",
      location: "Week 1: [Lab 0](assignments/lab-00.md)",
    });
  });

  it("finds nothing on a page in another shape", () => {
    expect(parseObjectives("# Objectives\n\n1. Learn things.\n")).toEqual([]);
  });
});

describe("alignmentCsv", () => {
  const csv = alignmentCsv(parseObjectives(PAGE), (target) => `https://drive.example/${target}`);
  const lines = csv.trimEnd().split("\r\n");

  it("starts with the eCampus template's columns", () => {
    expect(lines[0]).toBe(ALIGNMENT_HEADER.map((name) => `"${name}"`).join(","));
  });

  it("links a cell with one link and keeps the text of a cell with two", () => {
    expect(lines[2]).toContain('"=HYPERLINK(""https://drive.example/assignments/lab-00.md"", ""Week 1: Lab 0"")"');
    expect(lines[3]).toContain('"Weeks 1 and 2: D1 and D2"');
  });

  it("leaves a link it cannot place as its text", () => {
    expect(alignmentCsv(parseObjectives(PAGE), () => null)).toContain('"Week 1: Lab 0"');
  });

  it("drops markdown marks", () => {
    expect(lines[2]).toContain('"Define integrity."');
    expect(plainText("Use `risk` and **bold** [here](x.md)")).toBe("Use risk and bold here");
  });
});
