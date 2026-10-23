/**
 * An objectives page as an objective alignment sheet: which parts of the page
 * become rows, the CSV Drive turns into a Google Sheet, and the requests that
 * write the rows into the eCampus template.
 */

import {
  ALIGNMENT_HEADER,
  alignmentCells,
  alignmentCsv,
  asTemplateChoices,
  parseObjectives,
  plainText,
  type SheetRequest,
  templateRequests,
} from "@edutools/core/alignment";
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
      terminal: true,
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
      terminal: false,
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
  const csv = alignmentCsv(alignmentCells(parseObjectives(PAGE), (target) => `https://drive.example/${target}`));
  const lines = csv.trimEnd().split("\r\n");

  it("starts with the eCampus template's columns", () => {
    expect(lines[0]).toBe(ALIGNMENT_HEADER.map((name) => `"${name}"`).join(","));
  });

  it("links a cell with one link and keeps the text of a cell with two", () => {
    expect(lines[2]).toContain('"=HYPERLINK(""https://drive.example/assignments/lab-00.md"", ""Week 1: Lab 0"")"');
    expect(lines[3]).toContain('"Weeks 1 and 2: D1 and D2"');
  });

  it("leaves a link it cannot place as its text", () => {
    expect(alignmentCsv(alignmentCells(parseObjectives(PAGE), () => null))).toContain('"Week 1: Lab 0"');
  });

  it("drops markdown marks", () => {
    expect(lines[2]).toContain('"Define integrity."');
    expect(plainText("Use `risk` and **bold** [here](x.md)")).toBe("Use risk and bold here");
  });
});

describe("asTemplateChoices", () => {
  it("spells each facet the way the template's dropdown does", () => {
    const [terminal, supporting] = parseObjectives(PAGE).map(asTemplateChoices);
    expect(terminal?.introduced).toBe("Introduced In This Course");
    expect(supporting?.bloom).toBe("Remember");
  });

  it("leaves a value no dropdown offers as it is", () => {
    const [row] = parseObjectives(PAGE.replace("Bloom: Understand", "Bloom: Ponder")).map(asTemplateChoices);
    expect(row?.bloom).toBe("Ponder");
  });
});

describe("templateRequests", () => {
  const rows = parseObjectives(PAGE).map(asTemplateChoices);
  const cells = alignmentCells(rows, (target) => `https://drive.example/${target}`);
  const requests = templateRequests(rows, cells, 7);
  const kinds = requests.map((request) => Object.keys(request)[0]);
  const ofKind = (kind: string) => requests.filter((request) => kind in request).map((request) => request[kind]);

  it("drops the template's spare rows in columns A to I", () => {
    expect(requests[0]).toEqual({
      deleteRange: {
        range: { sheetId: 7, startRowIndex: 4, endRowIndex: 49, startColumnIndex: 0, endColumnIndex: 9 },
        shiftDimension: "ROWS",
      },
    });
  });

  it("styles each run of rows from the template's row of its kind, bottom up", () => {
    const pastes = ofKind("copyPaste") as { source: { startRowIndex: number }; destination: { startRowIndex: number; endRowIndex: number }; pasteType: string }[];
    expect(pastes.map((paste) => [paste.source.startRowIndex, paste.destination.startRowIndex, paste.destination.endRowIndex, paste.pasteType])).toEqual([
      [2, 2, 4, "PASTE_FORMAT"],
      [2, 2, 4, "PASTE_DATA_VALIDATION"],
      [1, 1, 2, "PASTE_FORMAT"],
      [1, 1, 2, "PASTE_DATA_VALIDATION"],
    ]);
  });

  it("writes the rows from A2, linking a cell with one link", () => {
    const [write] = ofKind("updateCells") as { start: unknown; rows: { values: SheetRequest[] }[] }[];
    expect(write?.start).toEqual({ sheetId: 7, rowIndex: 1, columnIndex: 0 });
    expect(write?.rows).toHaveLength(3);
    expect(write?.rows[0]?.values[0]).toEqual({ userEnteredValue: { stringValue: "TLO: 1" } });
    expect(write?.rows[0]?.values[6]).toEqual({});
    expect(write?.rows[1]?.values[7]).toEqual({
      userEnteredValue: { formulaValue: '=HYPERLINK("https://drive.example/assignments/lab-00.md", "Week 1: Lab 0")' },
    });
  });

  it("removes the letter, clips the rows and fits the header", () => {
    expect(kinds.slice(-4)).toEqual(["repeatCell", "unmergeCells", "updateCells", "autoResizeDimensions"]);
    const letter = { sheetId: 7, startRowIndex: 0, endRowIndex: 20, startColumnIndex: 9, endColumnIndex: 15 };
    expect(requests.at(-2)).toEqual({ updateCells: { range: letter, fields: "userEnteredValue,userEnteredFormat" } });
    expect(requests.at(-1)).toEqual({
      autoResizeDimensions: { dimensions: { sheetId: 7, dimension: "ROWS", startIndex: 0, endIndex: 1 } },
    });
  });

  it("keeps the template's spare rows when the course fills them", () => {
    const many = Array.from({ length: 48 }, (_, index) => rows[index % rows.length]).filter((row) => row !== undefined);
    expect(templateRequests(many, alignmentCells(many, () => null), 7).some((request) => "deleteRange" in request)).toBe(false);
  });
});
