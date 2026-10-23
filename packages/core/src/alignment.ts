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
 */

/** One row of the sheet, its cells still markdown. */
export interface AlignmentRow {
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

/**
 * The sheet as CSV, which Drive converts to a Google Sheet. A cell with one
 * link that `resolve` can place becomes a HYPERLINK to it; any other link is
 * left as its text.
 */
export function alignmentCsv(rows: readonly AlignmentRow[], resolve: (target: string) => string | null): string {
  const cell = (markdown: string): string => {
    const text = plainText(markdown);
    const targets = linkTargets(markdown);
    const url = targets.length === 1 && targets[0] ? resolve(targets[0]) : null;
    return url === null ? text : `=HYPERLINK(${formulaString(url)}, ${formulaString(text)})`;
  };
  const lines = [ALIGNMENT_HEADER, ...rows.map((row) => [
    row.number,
    row.objective,
    row.introduced,
    row.required,
    row.bloom,
    row.knowledge,
    row.assessed,
    row.location,
    row.notes,
  ].map(cell))];
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
