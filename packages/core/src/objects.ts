/**
 * Field mapping for one-off Canvas object create / update / delete.
 *
 * `edutools push` drives a whole course repository. This module covers the other
 * half: touching a single object. Canvas names the same idea differently on every
 * endpoint - an assignment has a `name`, a page has a `title`, a discussion takes
 * its parameters unprefixed while a quiz nests everything under `quiz[...]` - so
 * the mapping lives here as data and the CLI stays a thin wrapper over it.
 *
 * Everything here is pure, so the whole mapping can be tested without a token.
 */

// Canvas object kinds this module can build fields for.
export const KINDS: readonly string[] = ["page", "assignment", "discussion", "quiz", "module"];

/** Raised when a value cannot be expressed for the requested kind. */
export class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldError";
  }
}

// ---------------------------------------------------------------------------
// Python formatting, for messages and form values that must read exactly as the
// Python version wrote them.
// ---------------------------------------------------------------------------

/** Python's `repr()`, for the values that show up in error messages. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of value) {
      // A for-of character is never empty, so it always has a code point.
      const code = ch.codePointAt(0) as number;
      if (ch === "\\") out += "\\\\";
      else if (ch === quote) out += `\\${quote}`;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
      else out += ch;
    }
    return `${quote}${out}${quote}`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

/** Python's `str()`: a string as itself, anything else as its repr. */
function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/**
 * Python's `format(x, "g")`: six significant digits, trailing zeros dropped, and
 * scientific notation outside 1e-4 <= |x| < 1e6. Canvas receives points this way.
 */
export function formatG(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  // toExponential always writes exactly one "e" for a finite number.
  const [mantissa, exp] = value.toExponential(5).split("e") as [string, string];
  const exponent = Number(exp);
  const strip = (s: string): string => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  if (exponent < -4 || exponent >= 6) {
    const sign = exponent < 0 ? "-" : "+";
    return `${strip(mantissa)}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return strip(value.toFixed(5 - exponent));
}

// ---------------------------------------------------------------------------
// Per-kind field names
// ---------------------------------------------------------------------------

/**
 * How one Canvas kind names the fields every object shares.
 *
 * `prefix` is the bracket namespace ("" when Canvas takes bare parameters).
 * `points` and `dates` are absolute keys because Canvas hangs a graded
 * discussion's points and dates off `assignment[...]`, not off the topic.
 */
export class KindSpec {
  readonly prefix: string;
  readonly title: string;
  readonly body: string | null;
  readonly published: string;
  readonly points: string | null;
  readonly dates: string | null;

  constructor(fields: {
    prefix: string;
    title: string;
    body: string | null;
    published: string;
    points: string | null;
    dates: string | null;
  }) {
    this.prefix = fields.prefix;
    this.title = fields.title;
    this.body = fields.body;
    this.published = fields.published;
    this.points = fields.points;
    this.dates = fields.dates;
  }

  key(name: string): string {
    return this.prefix ? `${this.prefix}[${name}]` : name;
  }
}

export const SPECS: Readonly<Record<string, KindSpec>> = {
  page: new KindSpec({
    prefix: "wiki_page",
    title: "title",
    body: "body",
    published: "wiki_page[published]",
    points: null,
    dates: null,
  }),
  assignment: new KindSpec({
    prefix: "assignment",
    title: "name",
    body: "description",
    published: "assignment[published]",
    points: "assignment[points_possible]",
    dates: "assignment",
  }),
  discussion: new KindSpec({
    prefix: "",
    title: "title",
    body: "message",
    published: "published",
    points: "assignment[points_possible]",
    dates: "assignment",
  }),
  quiz: new KindSpec({
    prefix: "quiz",
    title: "title",
    body: "description",
    published: "quiz[published]",
    points: null,
    dates: "quiz",
  }),
  module: new KindSpec({
    prefix: "module",
    title: "name",
    body: null,
    published: "module[published]",
    points: null,
    dates: null,
  }),
};

export function specFor(kind: string): KindSpec {
  const spec = Object.hasOwn(SPECS, kind) ? SPECS[kind] : undefined;
  if (spec === undefined) {
    throw new FieldError(`unknown kind ${pyRepr(kind)}; expected one of ${KINDS.join(", ")}`);
  }
  return spec;
}

export interface BuildFieldsOptions {
  title?: string | null;
  body?: string | null;
  points?: number | null;
  due?: string | null;
  unlock?: string | null;
  lock?: string | null;
  published?: boolean | null;
  position?: number | null;
  overrides?: Record<string, string> | null;
}

/**
 * Build the form body for a create or update, omitting anything unset.
 *
 * Omission is the point: an update must not clear a field the caller never
 * mentioned, so only what is passed here is sent to Canvas. `overrides` is
 * applied last and wins, which is how any Canvas field this function does not
 * model can still be set.
 */
export function buildFields(kind: string, options: BuildFieldsOptions = {}): Record<string, string> {
  const spec = specFor(kind);
  const fields: Record<string, string> = {};
  const { title, body, points, due, unlock, lock, published, position, overrides } = options;

  if (title != null) {
    fields[spec.key(spec.title)] = title;
  }

  if (body != null) {
    if (spec.body === null) {
      throw new FieldError(`a ${kind} has no body`);
    }
    fields[spec.key(spec.body)] = body;
  }

  if (points != null) {
    if (spec.points === null) {
      throw new FieldError(
        kind === "quiz" ? `a ${kind} takes no points; it scores from its questions` : `a ${kind} takes no points`,
      );
    }
    fields[spec.points] = formatG(points);
  }

  const dates: Array<[string, string | null | undefined]> = [
    ["due_at", due],
    ["unlock_at", unlock],
    ["lock_at", lock],
  ];
  const given = dates.filter((entry): entry is [string, string] => entry[1] != null);
  if (given.length > 0) {
    if (spec.dates === null) {
      throw new FieldError(`a ${kind} has no due / available dates`);
    }
    for (const [name, value] of given) {
      fields[`${spec.dates}[${name}]`] = value;
    }
  }

  if (published != null) {
    fields[spec.published] = String(published);
  }

  if (position != null) {
    if (kind !== "module") {
      throw new FieldError(`a ${kind} has no position; only modules are ordered`);
    }
    fields[spec.key("position")] = String(position);
  }

  Object.assign(fields, overrides ?? {});
  return fields;
}

/** Turn --set 'assignment[omit_from_final_grade]=true' into a field pair. */
export function parseOverrides(pairs: readonly string[] | null | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const at = pair.indexOf("=");
    const name = at === -1 ? pair : pair.slice(0, at);
    if (at === -1 || !name.trim()) {
      throw new FieldError(`--set expects key=value, got ${pyRepr(pair)}`);
    }
    parsed[name.trim()] = pair.slice(at + 1);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Grading input
// ---------------------------------------------------------------------------

// Column and key spellings accepted for each field, so a gradebook export and a
// hand-written JSON file both load without renaming anything.
const ALIASES = {
  user_id: ["user_id", "student_id", "student", "id"],
  grade: ["grade", "score", "posted_grade", "points"],
  comment: ["comment", "feedback", "text_comment"],
  excuse: ["excuse", "excused"],
  late_policy_status: ["late_policy_status", "late_status"],
} as const;

/** A rubric assessment: criterion id to its fields (points, rating_id, comments). */
export type Rubric = Record<string, Record<string, string | number>>;

/** One student's grade and feedback. */
export class GradeRow {
  readonly userId: string;
  readonly grade: string | null;
  readonly comment: string | null;
  readonly excuse: boolean | null;
  readonly latePolicyStatus: string | null;
  readonly rubric: Rubric;

  constructor(fields: {
    userId: string;
    grade?: string | null;
    comment?: string | null;
    excuse?: boolean | null;
    latePolicyStatus?: string | null;
    rubric?: Rubric;
  }) {
    this.userId = fields.userId;
    this.grade = fields.grade ?? null;
    this.comment = fields.comment ?? null;
    this.excuse = fields.excuse ?? null;
    this.latePolicyStatus = fields.latePolicyStatus ?? null;
    this.rubric = fields.rubric ?? {};
    if (
      this.grade === null &&
      !this.comment &&
      this.excuse === null &&
      Object.keys(this.rubric).length === 0
    ) {
      throw new FieldError(`nothing to apply for student ${this.userId}`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Python truthiness, for the `a or b` fallbacks carried over from the original.
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function pick(row: Record<string, unknown>, name: keyof typeof ALIASES): unknown {
  for (const alias of ALIASES[name]) {
    if (Object.hasOwn(row, alias)) {
      const value = row[alias];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return null;
}

function asBool(value: unknown): boolean {
  return ["1", "true", "yes", "y"].includes(pyStr(value).trim().toLowerCase());
}

function rowFromMapping(row: Record<string, unknown>): GradeRow {
  const userId = pick(row, "user_id");
  if (userId === null) {
    throw new FieldError(`row is missing a student id: ${pyRepr(row)}`);
  }
  const grade = pick(row, "grade");
  const comment = pick(row, "comment");
  const excuse = pick(row, "excuse");
  const late = pick(row, "late_policy_status");
  const rubric = truthy(row.rubric) ? row.rubric : row.rubric_assessment;
  if (rubric !== null && rubric !== undefined && !isObject(rubric)) {
    throw new FieldError(`rubric for student ${pyStr(userId)} must be an object, got ${pyRepr(rubric)}`);
  }
  return new GradeRow({
    userId: pyStr(userId),
    grade: grade === null ? null : pyStr(grade),
    comment: comment === null ? null : pyStr(comment),
    excuse: excuse === null ? null : asBool(excuse),
    latePolicyStatus: late === null ? null : pyStr(late),
    // The shape inside is Canvas's rubric_assessment, passed through untouched;
    // only the outer object is checked, as the Python version did.
    rubric: isObject(rubric) ? ({ ...rubric } as Rubric) : {},
  });
}

/**
 * Split CSV text into rows of fields, RFC 4180 style: quoted fields may hold
 * commas, newlines, and doubled quotes. Like Python's csv module, a blank line
 * is an empty row and a quote in the middle of an unquoted field is literal.
 */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endRow = (): void => {
    if (started || row.length > 0) row.push(field);
    rows.push(row);
    row = [];
    field = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    // i is within bounds, which noUncheckedIndexedAccess cannot see.
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (started || row.length > 0) endRow();
  return rows;
}

/** `csv.DictReader`: the first non-empty row names the columns. */
function csvRecords(text: string): Array<Record<string, unknown>> {
  const rows = csvRows(text).filter((row) => row.length > 0);
  const header = rows.shift();
  if (header === undefined) return [];
  return rows.map((row) => {
    const record: Record<string, unknown> = {};
    header.forEach((name, i) => {
      // A short row fills the missing columns with None, as DictReader does.
      record[name] = i < row.length ? row[i] : null;
    });
    return record;
  });
}

/**
 * Read a batch of grades from JSON or CSV.
 *
 * JSON is either a list of objects or an object keyed by student id. CSV needs
 * a header row. Either way the column names are matched loosely, so `score`,
 * `grade`, and `points` all mean the same thing.
 */
export function parseGrades(text: string, options: { asCsv?: boolean } = {}): GradeRow[] {
  if (options.asCsv) {
    const records = csvRecords(text);
    if (records.length === 0) {
      throw new FieldError("no rows found; the CSV needs a header row");
    }
    return records.map(rowFromMapping);
  }

  let loaded: unknown;
  try {
    loaded = JSON.parse(text);
  } catch (error) {
    throw new FieldError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (isObject(loaded)) {
    const rows: GradeRow[] = [];
    for (const [key, value] of Object.entries(loaded)) {
      if (isObject(value)) {
        // A keyed object may still name the student inside; the key is
        // only the fallback.
        const merged: Record<string, unknown> = { ...value };
        if (!Object.hasOwn(merged, "user_id")) merged.user_id = key;
        rows.push(rowFromMapping(merged));
      } else {
        rows.push(rowFromMapping({ user_id: key, grade: value }));
      }
    }
    return rows;
  }
  if (Array.isArray(loaded)) {
    return loaded.map((entry: unknown) => {
      if (!isObject(entry)) {
        throw new FieldError(`expected a list of objects, found ${pyRepr(entry)}`);
      }
      return rowFromMapping(entry);
    });
  }
  throw new FieldError("expected a JSON list of objects or an object keyed by student id");
}
