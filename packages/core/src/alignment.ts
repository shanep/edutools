/**
 * Pure: a course's objectives page as an objective alignment sheet.
 *
 * Boise State eCampus maps every course objective to the work that assesses it
 * in an "Objective Alignment Sheet", one row per objective. A course whose
 * `objectives.md` is written in the same shape gets that sheet built from the
 * page, so the two never drift apart. The shape, per terminal objective:
 *
 *     ## TLO 1: Short title
 *
 *     > **The student will be able to** explain ...
 *
 *     *Introduced in this course · Required · Bloom: Understand · Knowledge type: Concept*
 *
 *     | # | The student will be able to… | Bloom | Knowledge type | How it will be assessed | Location in course |
 *     | --- | --- | --- | --- | --- | --- |
 *     | 1.1 | Define ... | Remember | Fact | Lab 0 rubric row 3 | Week 1: [Lab 0](assignments/lab-00.md) |
 *
 *     **Notes.** Anything eCampus should know about this objective.
 *
 * Columns are matched by header, so their order and any extra ones do not
 * matter. Every other section of the page is left out.
 *
 * The sheet comes out one of two ways: as CSV, plain cells under the template's
 * header, or written into eCampus's own template workbook, which keeps its
 * styling, dropdowns and notes (see templateRequests).
 */

/** One row of the sheet, its cells still markdown. */
export interface AlignmentRow {
  /** A terminal objective's row, rather than a supporting one. */
  readonly terminal: boolean;
  readonly number: string;
  readonly objective: string;
  readonly introduced: string;
  readonly required: string;
  readonly bloom: string;
  readonly knowledge: string;
  readonly assessed: string;
  readonly location: string;
  readonly notes: string;
}

/** The eCampus template's columns, A to I. */
export const ALIGNMENT_HEADER: readonly string[] = [
  "Obj. #",
  "Objectives: The student will be able to...",
  "Introduced In This Course; Reviewed From Previous Course; Built On From Previous Course",
  "Required; Optional; Covered in Previous Course So Not Necessary To Teach",
  "Bloom Level",
  "Knowledge Type",
  "How it will be assessed",
  "Location in course (In which week or module)",
  "NOTES",
];

const TLO_RE = /^##\s+TLO\s+(\d+)\b/;
const LEAD_RE = /^\*\*The student will be able to\*\*\s*/i;

function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Section {
  number: string;
  quote: string[];
  facets: string;
  table: string[];
  notes: string[];
}

/** The terminal objective's own row and one row per supporting objective. */
function rowsOf(section: Section): AlignmentRow[] {
  const facets = section.facets.split("·").map((part) => part.trim());
  const labelled = (label: string): string =>
    facets.find((part) => part.toLowerCase().startsWith(`${label}:`))?.slice(label.length + 1).trim() ?? "";
  const plain = facets.filter((part) => !part.includes(":"));
  const introduced = plain[0] ?? "";
  const required = plain[1] ?? "";
  const rows: AlignmentRow[] = [
    {
      terminal: true,
      number: `TLO: ${section.number}`,
      objective: capitalize(section.quote.join(" ").replace(LEAD_RE, "").trim()),
      introduced,
      required,
      bloom: labelled("bloom"),
      knowledge: labelled("knowledge type"),
      assessed: "",
      location: "",
      notes: section.notes.join(" ").replace(/^\*\*Notes\.?\*\*\s*/, ""),
    },
  ];
  const [head, , ...body] = section.table;
  if (head === undefined) return rows;
  const header = cellsOf(head).map((cell) => cell.toLowerCase());
  const column = (test: (name: string) => boolean): number => header.findIndex(test);
  const at = {
    number: column((name) => name === "#"),
    objective: column((name) => name.includes("able to")),
    bloom: column((name) => name.includes("bloom")),
    knowledge: column((name) => name.includes("knowledge")),
    assessed: column((name) => name.includes("assessed")),
    location: column((name) => name.includes("location")),
  };
  for (const line of body) {
    const cells = cellsOf(line);
    const cell = (index: number): string => (index === -1 ? "" : (cells[index] ?? ""));
    rows.push({
      terminal: false,
      number: cell(at.number),
      objective: cell(at.objective),
      introduced,
      required,
      bloom: cell(at.bloom),
      knowledge: cell(at.knowledge),
      assessed: cell(at.assessed),
      location: cell(at.location),
      notes: "",
    });
  }
  return rows;
}

/** The sheet's rows from an objectives page, or none when the page is not in that shape. */
export function parseObjectives(markdown: string): AlignmentRow[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let inNotes = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const tlo = TLO_RE.exec(line);
    if (tlo) {
      current = { number: tlo[1] ?? "", quote: [], facets: "", table: [], notes: [] };
      sections.push(current);
      inNotes = false;
      continue;
    }
    if (line.startsWith("#")) {
      current = null;
      continue;
    }
    if (current === null) continue;
    if (inNotes) {
      if (line === "" || line === "---") inNotes = false;
      else current.notes.push(line);
      continue;
    }
    if (line.startsWith(">")) current.quote.push(line.replace(/^>\s?/, ""));
    else if (line.startsWith("|")) current.table.push(line);
    else if (/^\*[^*].*\*$/.test(line) && current.facets === "") current.facets = line.slice(1, -1);
    else if (line.startsWith("**Notes")) {
      current.notes.push(line);
      inNotes = true;
    }
  }
  return sections.flatMap(rowsOf);
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** A markdown cell as plain text: link text kept, emphasis and code marks dropped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(LINK_RE, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

/** The link targets in a markdown cell. */
export function linkTargets(markdown: string): string[] {
  return [...markdown.matchAll(LINK_RE)].map((match) => match[2] ?? "");
}

function formulaString(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** A cell's plain text, and the URL it links to, if any. */
export interface AlignmentCell {
  readonly text: string;
  readonly url: string | null;
}

function columnsOf(row: AlignmentRow): string[] {
  return [
    row.number,
    row.objective,
    row.introduced,
    row.required,
    row.bloom,
    row.knowledge,
    row.assessed,
    row.location,
    row.notes,
  ];
}

/**
 * Each row's cells, in the template's column order. A cell with one link that
 * `resolve` can place links to it; any other link is left as its text.
 */
export function alignmentCells(
  rows: readonly AlignmentRow[],
  resolve: (target: string) => string | null,
): AlignmentCell[][] {
  return rows.map((row) =>
    columnsOf(row).map((markdown) => {
      const targets = linkTargets(markdown);
      const url = targets.length === 1 && targets[0] ? resolve(targets[0]) : null;
      return { text: plainText(markdown), url };
    }),
  );
}

function hyperlink(cell: AlignmentCell): string {
  return `=HYPERLINK(${formulaString(cell.url ?? "")}, ${formulaString(cell.text)})`;
}

/** The sheet as CSV, which Drive converts to a Google Sheet. A linked cell becomes a HYPERLINK. */
export function alignmentCsv(cells: readonly (readonly AlignmentCell[])[]): string {
  const body = cells.map((row) => row.map((cell) => (cell.url === null ? cell.text : hyperlink(cell))));
  const lines = [ALIGNMENT_HEADER, ...body];
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// ============================================================================
// The eCampus template
// ============================================================================

/**
 * The layout of eCampus's template workbook, whose "Objectives" tab the sheet is
 * written into. Row 1 is the header. Rows 2 to 49 are 8 blocks of a terminal
 * objective's row and 5 supporting rows, each row styled and given dropdowns for
 * its kind. Columns J to P hold eCampus's notes: a letter to the instructor in
 * J1, Bloom's pyramid, a legend of knowledge types and a citation.
 */
export const TEMPLATE_TAB = "Objectives";
const TERMINAL_ROW = 1;
const SUPPORTING_ROW = 2;
const BLOCKS_END = 49;
const COLUMNS = 9;
// The letter is merged over J1:O20.
const LETTER = { startRowIndex: 0, endRowIndex: 20, startColumnIndex: 9, endColumnIndex: 15 };

/** The template's dropdown choices. A value has to match one exactly to pass the sheet's validation. */
const CHOICES = {
  introduced: ["Introduced In This Course", "Reviewed From Previous Course", "Built On From Previous Course"],
  // The template capitalizes "in" differently in the two rows' lists.
  terminalRequired: ["Required", "Optional", "Covered in Previous Course So Not Necessary To Teach"],
  supportingRequired: ["Required", "Optional", "Covered In Previous Course So Not Necessary To Teach"],
  bloom: ["Create", "Evaluate", "Analyze", "Apply", "Understand", "Remember"],
  knowledge: ["Principle", "Process", "Procedure", "Concept", "Fact"],
};

/** `value` as the dropdown choice it names, ignoring case, or as it is when it names none. */
function choice(value: string, choices: readonly string[]): string {
  return choices.find((option) => option.toLowerCase() === value.trim().toLowerCase()) ?? value;
}

/** A row with its facets spelled the way the template's dropdowns spell them. */
export function asTemplateChoices(row: AlignmentRow): AlignmentRow {
  return {
    ...row,
    introduced: choice(row.introduced, CHOICES.introduced),
    required: choice(row.required, row.terminal ? CHOICES.terminalRequired : CHOICES.supportingRequired),
    bloom: choice(row.bloom, CHOICES.bloom),
    knowledge: choice(row.knowledge, CHOICES.knowledge),
  };
}

/** A Sheets API batchUpdate request. */
export type SheetRequest = Record<string, unknown>;

/**
 * The batchUpdate requests that write `rows` into the template's tab `tab`,
 * once the template workbook has been uploaded over the sheet.
 *
 * The rows replace the 8 blocks in columns A to I, so a course with fewer
 * objectives drops the template's spare rows and one with more grows past them,
 * and each row takes the styling and dropdowns of the template's row of its
 * kind. Columns J and on keep eCampus's notes, all but the letter in J1, which
 * is addressed to the instructor filling the sheet in by hand. Long text in
 * columns A to I is clipped so it does not spill over eCampus's notes.
 *
 * The workbook loses the header row's height on export, so the row is fitted
 * to its text again, as it is in the template.
 */
export function templateRequests(
  rows: readonly AlignmentRow[],
  cells: readonly (readonly AlignmentCell[])[],
  tab: number,
): SheetRequest[] {
  const range = (start: number, end: number) => ({
    sheetId: tab,
    startRowIndex: start,
    endRowIndex: end,
    startColumnIndex: 0,
    endColumnIndex: COLUMNS,
  });
  const requests: SheetRequest[] = [];
  const end = TERMINAL_ROW + rows.length;
  if (end < BLOCKS_END) requests.push({ deleteRange: { range: range(end, BLOCKS_END), shiftDimension: "ROWS" } });

  // Runs of rows of one kind, styled bottom up, so the template's two source
  // rows at the top are the last ones restyled.
  const runs: { start: number; end: number; terminal: boolean }[] = [];
  rows.forEach((row, index) => {
    const at = TERMINAL_ROW + index;
    const last = runs.at(-1);
    if (last && last.terminal === row.terminal) last.end = at + 1;
    else runs.push({ start: at, end: at + 1, terminal: row.terminal });
  });
  for (const run of runs.reverse()) {
    const source = run.terminal ? TERMINAL_ROW : SUPPORTING_ROW;
    for (const pasteType of ["PASTE_FORMAT", "PASTE_DATA_VALIDATION"]) {
      requests.push({ copyPaste: { source: range(source, source + 1), destination: range(run.start, run.end), pasteType } });
    }
  }

  const value = (cell: AlignmentCell) =>
    cell.url !== null
      ? { userEnteredValue: { formulaValue: hyperlink(cell) } }
      : cell.text === ""
        ? {}
        : { userEnteredValue: { stringValue: cell.text } };
  requests.push({
    updateCells: {
      start: { sheetId: tab, rowIndex: TERMINAL_ROW, columnIndex: 0 },
      rows: cells.map((row) => ({ values: row.map(value) })),
      fields: "userEnteredValue",
    },
  });
  requests.push({
    repeatCell: {
      range: range(TERMINAL_ROW, end),
      cell: { userEnteredFormat: { wrapStrategy: "CLIP" } },
      fields: "userEnteredFormat.wrapStrategy",
    },
  });
  const letter = { sheetId: tab, ...LETTER };
  requests.push({ unmergeCells: { range: letter } });
  requests.push({ updateCells: { range: letter, fields: "userEnteredValue,userEnteredFormat" } });
  requests.push({
    autoResizeDimensions: { dimensions: { sheetId: tab, dimension: "ROWS", startIndex: 0, endIndex: 1 } },
  });
  return requests;
}
