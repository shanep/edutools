/**
 * Course due-date generation.
 *
 * A course repository declares a *term skeleton* and one date policy per item type
 * in its `canvas.toml`. This module turns that into concrete, timezone-aware
 * `unlock_at` / `due_at` / `lock_at` timestamps for every gradable item, so
 * that seventy-odd timestamps are derived rather than typed, and rolling the
 * course to a new semester means changing one date.
 *
 * Nothing here talks to Canvas. It is pure computation so it can be reviewed
 * (`edutools canvas dates --show`) and unit tested without a token.
 *
 * Calendar dates are ISO strings ("2027-01-11"), which compare correctly as
 * strings. Timestamps are luxon DateTimes set to the term's IANA zone, never the
 * machine's, so a daylight saving change inside the term lands where it should.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DateTime, IANAZone } from "luxon";
import { TomlDate, parse as parseToml } from "smol-toml";
import { formatG, pyRepr } from "./objects";
import { fnmatch, globRepo } from "./paths";
import { isDraft } from "./publish";

export const ITEM_KINDS = ["lab", "project", "extra", "quiz", "discussion", "exam", "reminder"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** A calendar date as "YYYY-MM-DD"; Python's `datetime.date`. */
export type ISODate = string;

const WEEKDAY_OFFSET: Readonly<Record<string, number>> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

// "**Week 7 · 38 points · about 90 minutes · submit in Canvas**"
// "**Finals week · 150 points · 90 minutes · taken in Canvas**"
const HEADER_RE = /^\*\*(?<when>Week\s+(?<week>\d+)|Finals week)\s*·\s*(?<points>[\d.]+)\s+points/m;

// "| 1 | Jan 11-17 | ..."  from the syllabus schedule table. The range may use a
// hyphen or an en dash (U+2013), so both are accepted.
const SCHEDULE_ROW_RE =
  /^\|\s*(?<week>\d+)\s*\|\s*(?<dates>[A-Z][a-z]{2}\s+\d{1,2}\s*[\u2013-]\s*(?:[A-Z][a-z]{2}\s+)?\d{1,2})/gm;

const MONTHS: Readonly<Record<string, number>> = Object.fromEntries(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m, i) => [m, i + 1]),
);

// Month and weekday names in messages and module titles are English whatever the
// machine's locale, as Python's strftime is under the C locale.
const LOCALE = "en-US";

/** Raised when canvas.toml cannot produce a coherent set of dates. */
export class DateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateConfigError";
  }
}

function dateOf(iso: ISODate): DateTime {
  return DateTime.fromISO(iso, { zone: "UTC", locale: LOCALE });
}

/** `date + timedelta(days=n)` on a calendar date. */
function addDays(iso: ISODate, days: number): ISODate {
  // toISODate() is only null for an invalid DateTime, and a valid date plus days is valid.
  return dateOf(iso).plus({ days }).toISODate() as ISODate;
}

/** strftime-style formatting of a calendar date, with a luxon format string. */
function formatDate(iso: ISODate, format: string): string {
  return dateOf(iso).toFormat(format);
}

/**
 * Python's `datetime.isoformat()` for an aware timestamp, which is what Canvas
 * receives: `2026-10-14T23:59:00-06:00`, with `+00:00` rather than `Z` for UTC
 * and microseconds only when there are any.
 */
export function isoformat(stamp: DateTime): string {
  const fraction = stamp.millisecond ? `.${String(stamp.millisecond).padStart(3, "0")}000` : "";
  return `${stamp.toFormat("yyyy-LL-dd'T'HH:mm:ss")}${fraction}${stamp.toFormat("ZZ")}`;
}

/** The academic skeleton every date is derived from. */
export class Term {
  readonly timezone: string;
  readonly firstMonday: ISODate;
  readonly weeks: number;
  readonly breakAfterWeek: number | null;
  readonly lastDayOfInstruction: ISODate;
  readonly finalsStart: ISODate;
  readonly finalsEnd: ISODate;
  // What every gradable item should add up to. Zero means the course grades by
  // weighted assignment groups instead, so there is no total to check against.
  readonly totalPoints: number;

  constructor(fields: {
    timezone: string;
    firstMonday: ISODate;
    weeks: number;
    breakAfterWeek: number | null;
    lastDayOfInstruction: ISODate;
    finalsStart: ISODate;
    finalsEnd: ISODate;
    totalPoints?: number;
  }) {
    this.timezone = fields.timezone;
    this.firstMonday = fields.firstMonday;
    this.weeks = fields.weeks;
    this.breakAfterWeek = fields.breakAfterWeek;
    this.lastDayOfInstruction = fields.lastDayOfInstruction;
    this.finalsStart = fields.finalsStart;
    this.finalsEnd = fields.finalsEnd;
    this.totalPoints = fields.totalPoints ?? 1000;
  }

  get tz(): IANAZone {
    const zone = IANAZone.create(this.timezone);
    if (!zone.isValid) {
      throw new DateConfigError(`[term] timezone ${pyRepr(this.timezone)} is not a known IANA zone`);
    }
    return zone;
  }

  /** The real calendar Monday that starts `week`, skipping any break week. */
  mondayOf(week: number): ISODate {
    if (!(week >= 1 && week <= this.weeks)) {
      throw new DateConfigError(`week ${week} is outside 1..${this.weeks}`);
    }
    const skipped = this.breakAfterWeek !== null && week > this.breakAfterWeek ? 1 : 0;
    return addDays(this.firstMonday, 7 * (week - 1 + skipped));
  }

  /** The Monday of the break week, if the term has one. */
  breakMonday(): ISODate | null {
    if (this.breakAfterWeek === null) {
      return null;
    }
    return addDays(this.firstMonday, 7 * this.breakAfterWeek);
  }
}

/** How one kind of item is scheduled within its week. */
export interface Policy {
  // Null when a course wants no "Available from" date, which leaves the item
  // visible as soon as it is published.
  readonly unlock: string | null; // e.g. "mon 00:00"
  readonly due: string; // e.g. "sun 23:59"
  readonly graceDays: number; // days between due_at and lock_at
}

/**
 * One Canvas assignment group, and which item kinds belong in it.
 *
 * Weights live here rather than on the per-kind date policy because Canvas
 * weights a group, not a kind, and because a group can carry weight with no
 * repository item in it at all: a course whose exams are hand built quizzes
 * still needs an "Exams" group worth 50% of the grade.
 */
export interface Group {
  readonly name: string;
  // Null means the weight is managed in Canvas and a push must not send one.
  // An extra credit group that is raised by hand before final grades depends
  // on that: a declared 0 would put it back every time the course is pushed.
  readonly weight: number | null;
  readonly kinds: readonly ItemKind[];
}

/** The three Canvas date fields for one gradable item. */
export class ItemDates {
  readonly path: string;
  readonly title: string;
  readonly kind: ItemKind;
  readonly week: number | null; // null for finals-week items
  readonly points: number;
  readonly unlockAt: DateTime | null;
  readonly dueAt: DateTime;
  readonly lockAt: DateTime;

  constructor(fields: {
    path: string;
    title: string;
    kind: ItemKind;
    week: number | null;
    points: number;
    unlockAt: DateTime | null;
    dueAt: DateTime;
    lockAt: DateTime;
  }) {
    this.path = fields.path;
    this.title = fields.title;
    this.kind = fields.kind;
    this.week = fields.week;
    this.points = fields.points;
    this.unlockAt = fields.unlockAt;
    this.dueAt = fields.dueAt;
    this.lockAt = fields.lockAt;
  }

  // Adding days keeps the wall clock time, across a daylight saving change too,
  // as adding a timedelta to an aware datetime does in Python.
  shifted(days: number): ItemDates {
    return new ItemDates({
      ...this,
      unlockAt: this.unlockAt ? this.unlockAt.plus({ days }) : null,
      dueAt: this.dueAt.plus({ days }),
      lockAt: this.lockAt.plus({ days }),
    });
  }
}

/** Combine a date with a "HH:MM" clock time in `tz`. */
function at(day: ISODate, clock: string, tz: IANAZone): DateTime {
  const parts = clock.split(":");
  if (parts.length !== 2 || !parts.every((part) => /^\s*[+-]?\d+\s*$/.test(part))) {
    throw new DateConfigError(`bad clock time ${pyRepr(clock)}; expected e.g. '23:59'`);
  }
  const [hour, minute] = parts.map(Number);
  const [year, month, date] = day.split("-").map(Number);
  const stamp = DateTime.fromObject({ year, month, day: date, hour, minute }, { zone: tz, locale: LOCALE });
  if (!stamp.isValid) {
    throw new DateConfigError(`bad clock time ${pyRepr(clock)}; expected e.g. '23:59'`);
  }
  return stamp;
}

/** Turn a spec like "sun 23:59" into a datetime in the week starting `monday`. */
export function resolve(spec: string, monday: ISODate, tz: IANAZone): DateTime {
  const parts = spec.trim().split(/\s+/);
  const weekday = (parts[0] ?? "").toLowerCase();
  const offset = Object.hasOwn(WEEKDAY_OFFSET, weekday) ? WEEKDAY_OFFSET[weekday] : undefined;
  if (parts.length !== 2 || offset === undefined) {
    throw new DateConfigError(`bad date spec ${pyRepr(spec)}; expected e.g. 'sun 23:59'`);
  }
  // parts has exactly two entries, checked above.
  return at(addDays(monday, offset), parts[1] as string, tz);
}

/**
 * Read the bold header line of a course file.
 *
 * Returns `[week, points]`; `week` is null for finals-week items.
 */
export function parseHeader(text: string): [number | null, number] {
  const match = HEADER_RE.exec(text);
  if (match?.groups === undefined) {
    throw new DateConfigError("no '**Week N · P points …**' header line found");
  }
  const { week, points } = match.groups;
  const value = Number(points);
  if (Number.isNaN(value)) {
    throw new DateConfigError(`could not convert string to float: ${pyRepr(points)}`);
  }
  return [week ? Number.parseInt(week, 10) : null, value];
}

/**
 * What a course repo calls its files.
 *
 * Two courses name the same things differently: CS331 has `assignments/lab-*.md`
 * and a `syllabus.md`, CS425 has `assignments/p0.md` and uses `index.md` as
 * its syllabus because the same directory is also a VitePress site. Rather than
 * grow a second set of hardcoded globs, a repo declares its own shape in the
 * `[layout]` section of `canvas.toml` and everything else reads it from here.
 */
export class Layout {
  readonly syllabus: string;
  readonly pages: readonly string[];
  readonly files: readonly string[];
  // Ungraded discussions, such as a course Q&A board: no points, no dates.
  readonly discussions: readonly string[];
  readonly gradable: ReadonlyArray<readonly [string, ItemKind]>;

  constructor(
    fields: {
      syllabus?: string;
      pages?: readonly string[];
      files?: readonly string[];
      discussions?: readonly string[];
      gradable?: ReadonlyArray<readonly [string, ItemKind]>;
    } = {},
  ) {
    this.syllabus = fields.syllabus ?? "syllabus.md";
    this.pages = fields.pages ?? ["objectives.md", "resources.md", "modules/*.md", "assignments/*-exam-guide.md"];
    this.files = fields.files ?? ["docs/*.pdf", "data/*"];
    this.discussions = fields.discussions ?? [];
    this.gradable = fields.gradable ?? [
      ["assignments/lab-*.md", "lab"],
      ["assignments/p[0-9]*.md", "project"],
      ["quizzes/quiz-*.md", "quiz"],
      ["discussions/*.md", "discussion"],
    ];
  }

  /** Every directory a gradable item can live in, without duplicates. */
  get gradableDirs(): string[] {
    return [...new Set(this.gradable.map(([pattern]) => path.posix.dirname(pattern)))];
  }
}

export const DEFAULT_LAYOUT: Layout = new Layout();

// Pages are matched before gradable items so that a file caught by both, such as
// an exam guide that also sits under assignments/, stays a page.
const EXAM_GUIDE_RE = /-exam-guide\.md$/;

/** Decide what kind of gradable item a repo file is, or null if it is not one. */
export function classify(file: string, layout: Layout = DEFAULT_LAYOUT): ItemKind | null {
  const parts = file.split(/[\\/]/).filter((part) => part !== "");
  const name = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  if (parent === "assignments" && EXAM_GUIDE_RE.test(name)) {
    return "exam";
  }
  for (const [pattern, kind] of layout.gradable) {
    if (parent === path.posix.dirname(pattern) && fnmatch(name, path.posix.basename(pattern))) {
      return kind;
    }
  }
  return null;
}

/** The document's first level-1 heading. */
export function titleOf(text: string, fallback: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith("# ")) {
      return line.slice(2).trim();
    }
  }
  return fallback;
}

/** One entry of the [icons] table: headings matching `pattern` get `path`. */
export interface HeadingIcon {
  // Lower case, matched with fnmatch against the heading's visible text.
  readonly pattern: string;
  // Repo-relative path to the image, uploaded to Canvas as a course file.
  readonly path: string;
}

/** Everything canvas.toml says about scheduling. */
export class DateConfig {
  readonly term: Term;
  readonly policies: Readonly<Record<string, Policy>>;
  readonly overrides: Readonly<Record<string, Record<string, unknown>>>;
  readonly layout: Layout;
  readonly groups: readonly Group[];
  readonly icons: readonly HeadingIcon[];

  constructor(fields: {
    term: Term;
    policies: Record<string, Policy>;
    overrides: Record<string, Record<string, unknown>>;
    layout?: Layout;
    groups?: readonly Group[];
    icons?: readonly HeadingIcon[];
  }) {
    this.term = fields.term;
    this.policies = fields.policies;
    this.overrides = fields.overrides;
    this.layout = fields.layout ?? DEFAULT_LAYOUT;
    this.groups = fields.groups ?? [];
    this.icons = fields.icons ?? [];
  }

  /** The assignment group an item of this kind belongs in, if any. */
  groupFor(kind: string): Group | null {
    // Widened so any string can be looked up; a non-kind simply matches nothing.
    return this.groups.find((group) => (group.kinds as readonly string[]).includes(kind)) ?? null;
  }

  /** The declared weights added up, for a course that weights by group. */
  get totalWeight(): number {
    return this.groups.reduce((sum, group) => sum + (group.weight ?? 0), 0);
  }
}

// A TOML table, as opposed to an array, a date, or a scalar.
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function get(table: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function asDate(value: unknown, field: string): ISODate {
  // A TOML date-time counts too, by its date as written, as datetime.date() does.
  if (value instanceof TomlDate && value.isValid() && !value.isTime()) {
    return value.toISOString().slice(0, 10);
  }
  throw new DateConfigError(`[term] ${field} must be a date, got ${pyRepr(value)}`);
}

// Python's int() and float() on a TOML value: numbers, numeric strings, booleans.
function asNumber(value: unknown, field: string, integer: boolean): number {
  let result = Number.NaN;
  if (typeof value === "number") result = integer ? Math.trunc(value) : value;
  else if (typeof value === "bigint") result = Number(value);
  else if (typeof value === "boolean") result = value ? 1 : 0;
  else if (typeof value === "string" && value.trim() !== "") {
    result = integer && !/^\s*[+-]?\d+\s*$/.test(value) ? Number.NaN : Number(value);
  }
  if (Number.isNaN(result)) {
    throw new DateConfigError(`${field} must be ${integer ? "an integer" : "a number"}, got ${pyRepr(value)}`);
  }
  return result;
}

/** Read the [term], [policy] and [override] sections of <repo>/canvas.toml. */
export function loadConfig(repo: string): DateConfig {
  const configPath = path.join(repo, "canvas.toml");
  if (!existsSync(configPath)) {
    throw new DateConfigError(`no canvas.toml in ${repo}`);
  }
  const raw: Record<string, unknown> = parseToml(readFileSync(configPath, "utf-8"));

  const termRaw = get(raw, "term");
  if (!isTable(termRaw)) {
    throw new DateConfigError("canvas.toml has no [term] section");
  }

  const breakAfter = get(termRaw, "break_after_week");
  const term = new Term({
    timezone: String(get(termRaw, "timezone") ?? "America/Denver"),
    firstMonday: asDate(get(termRaw, "first_monday"), "first_monday"),
    weeks: asNumber(get(termRaw, "weeks") ?? 0, "[term] weeks", true),
    breakAfterWeek: breakAfter !== undefined ? asNumber(breakAfter, "[term] break_after_week", true) : null,
    lastDayOfInstruction: asDate(get(termRaw, "last_day_of_instruction"), "last_day_of_instruction"),
    finalsStart: asDate(get(termRaw, "finals_start"), "finals_start"),
    finalsEnd: asDate(get(termRaw, "finals_end"), "finals_end"),
    totalPoints: asNumber(get(termRaw, "total_points") ?? 1000, "[term] total_points", false),
  });
  if (dateOf(term.firstMonday).weekday !== 1) {
    throw new DateConfigError(
      `[term] first_monday ${term.firstMonday} is a ${formatDate(term.firstMonday, "cccc")}, not a Monday`,
    );
  }

  const policyRaw = get(termRaw, "policy");
  if (!isTable(policyRaw)) {
    throw new DateConfigError("canvas.toml [term] has no policy.* entries");
  }
  const policies: Record<string, Policy> = {};
  for (const [kind, spec] of Object.entries(policyRaw)) {
    if (!isTable(spec)) {
      throw new DateConfigError(`policy.${kind} must be a table`);
    }
    const unlock = get(spec, "unlock");
    const due = get(spec, "due");
    if (due === undefined) {
      throw new DateConfigError(`policy.${kind} has no due`);
    }
    policies[kind] = {
      unlock: unlock !== undefined ? String(unlock) : null,
      due: String(due),
      graceDays: asNumber(get(spec, "grace_days") ?? 0, `policy.${kind} grace_days`, true),
    };
  }

  const overridesRaw = get(raw, "override") ?? {};
  const overrides: Record<string, Record<string, unknown>> = {};
  if (isTable(overridesRaw)) {
    for (const [key, value] of Object.entries(overridesRaw)) {
      if (isTable(value)) overrides[key] = { ...value };
    }
  }
  return new DateConfig({
    term,
    policies,
    overrides,
    layout: loadLayout(raw),
    groups: loadGroups(raw),
    icons: loadIcons(raw, repo),
  });
}

function day(date: ISODate): string {
  return formatDate(date, "LLLL d");
}

/**
 * A [[module]] table's Canvas name, with its dates when it declares a week.
 *
 * The Boise State Online shell names modules "Module 3: Title (start date -
 * end date)". Writing the dates into canvas.toml would mean editing every
 * title each term, so a module says `week = 3` (or `week = "finals"`) and the
 * span comes from the term skeleton: Monday to Sunday, skipping the break,
 * clipped to the last day of instruction.
 */
export function moduleTitle(module: Record<string, unknown>, term: Term): string {
  const title = String(get(module, "title") ?? "");
  const week = get(module, "week");
  if (week === undefined || week === null) {
    return title;
  }
  let start: ISODate;
  let end: ISODate;
  if (week === "finals") {
    start = term.finalsStart;
    end = term.finalsEnd;
  } else if (typeof week === "number" && Number.isInteger(week)) {
    start = term.mondayOf(week);
    const sunday = addDays(start, 6);
    end = sunday < term.lastDayOfInstruction ? sunday : term.lastDayOfInstruction;
  } else {
    throw new DateConfigError(
      `[[module]] ${pyRepr(title)}: week must be a week number or "finals", got ${pyRepr(week)}`,
    );
  }
  return `${title} (${day(start)} - ${day(end)})`;
}

/**
 * Read the optional [icons] table of heading pattern = image path.
 *
 * Order is kept, and the first pattern that matches a heading wins, so a
 * specific pattern belongs above a catch-all one. A path that does not exist is
 * an error here rather than a broken image on every page later.
 */
export function loadIcons(raw: Record<string, unknown>, repo: string): HeadingIcon[] {
  const section = get(raw, "icons");
  if (section === undefined) {
    return [];
  }
  if (!isTable(section)) {
    throw new DateConfigError("canvas.toml [icons] must be a table of heading = image path");
  }
  const icons: HeadingIcon[] = [];
  for (const [pattern, file] of Object.entries(section)) {
    if (typeof file !== "string" || !file) {
      throw new DateConfigError(`[icons] ${pyRepr(pattern)} must name an image path, got ${pyRepr(file)}`);
    }
    if (!isFileAt(path.resolve(repo, file))) {
      throw new DateConfigError(`[icons] ${pyRepr(pattern)}: ${file} does not exist`);
    }
    icons.push({ pattern: pattern.trim().toLowerCase(), path: file });
  }
  return icons;
}

function isFileAt(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isItemKind(value: unknown): value is ItemKind {
  // Widened so includes() accepts any string; this is the check that narrows it.
  return typeof value === "string" && (ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * Read the optional [[group]] blocks, in the order they are declared.
 *
 * An absent section returns nothing, and a push then leaves the course's
 * assignment groups and its weighting setting exactly as they are. File order
 * becomes the Canvas position, so the gradebook reads the way the syllabus does.
 */
export function loadGroups(raw: Record<string, unknown>): Group[] {
  const section = get(raw, "group");
  if (section === undefined) {
    return [];
  }
  if (!Array.isArray(section)) {
    throw new DateConfigError("canvas.toml [[group]] must be a list of tables");
  }

  const groups: Group[] = [];
  const names = new Set<string>();
  const claimed = new Map<string, string>();
  // Array.isArray narrows to any[]; unknown keeps every entry checked.
  for (const entry of section as unknown[]) {
    if (!isTable(entry)) {
      throw new DateConfigError(`each [[group]] must be a table, got ${pyRepr(entry)}`);
    }

    const name = get(entry, "name");
    if (typeof name !== "string" || !name.trim()) {
      throw new DateConfigError(`[[group]] name must be a non-empty string, got ${pyRepr(name)}`);
    }
    if (names.has(name)) {
      throw new DateConfigError(`[[group]] ${pyRepr(name)} is declared twice`);
    }
    names.add(name);

    const weight = get(entry, "weight");
    if (weight !== undefined && typeof weight !== "number" && typeof weight !== "bigint") {
      throw new DateConfigError(`[[group]] ${pyRepr(name)} weight must be a number, got ${pyRepr(weight)}`);
    }

    const kindsRaw = get(entry, "kinds") ?? [];
    if (!Array.isArray(kindsRaw)) {
      throw new DateConfigError(`[[group]] ${pyRepr(name)} kinds must be a list of item kinds`);
    }
    const kinds: ItemKind[] = [];
    // Array.isArray narrows to any[]; unknown keeps every entry checked.
    for (const kind of kindsRaw as unknown[]) {
      if (!isItemKind(kind)) {
        throw new DateConfigError(
          `[[group]] ${pyRepr(name)} kind ${pyRepr(kind)} is not a known item kind (${ITEM_KINDS.join(", ")})`,
        );
      }
      // Canvas files an assignment under exactly one group, so two groups
      // claiming the same kind is a configuration bug rather than a merge.
      const owner = claimed.get(kind);
      if (owner !== undefined) {
        throw new DateConfigError(`item kind ${pyRepr(kind)} is claimed by both ${pyRepr(owner)} and ${pyRepr(name)}`);
      }
      claimed.set(kind, name);
      kinds.push(kind);
    }

    groups.push({ name, weight: weight !== undefined ? Number(weight) : null, kinds });
  }
  return groups;
}

function globList(raw: Record<string, unknown>, key: string, fallback: readonly string[]): readonly string[] {
  const value = get(raw, key);
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new DateConfigError(`[layout] ${key} must be a list of glob strings, got ${pyRepr(value)}`);
  }
  // every() above checked each item is a string, which TypeScript cannot carry over.
  return [...(value as string[])];
}

/** Read the optional [layout] section; an absent section keeps the defaults. */
export function loadLayout(raw: Record<string, unknown>): Layout {
  const section = get(raw, "layout");
  if (section === undefined) {
    return DEFAULT_LAYOUT;
  }
  if (!isTable(section)) {
    throw new DateConfigError("canvas.toml [layout] must be a table");
  }

  const syllabus = get(section, "syllabus") ?? DEFAULT_LAYOUT.syllabus;
  if (typeof syllabus !== "string") {
    throw new DateConfigError(`[layout] syllabus must be a string, got ${pyRepr(syllabus)}`);
  }

  const gradableRaw = get(section, "gradable");
  let gradable: ReadonlyArray<readonly [string, ItemKind]>;
  if (gradableRaw === undefined) {
    gradable = DEFAULT_LAYOUT.gradable;
  } else {
    if (!isTable(gradableRaw)) {
      throw new DateConfigError("[layout] gradable must be a table of kind = glob");
    }
    const pairs: Array<readonly [string, ItemKind]> = [];
    for (const [kind, pattern] of Object.entries(gradableRaw)) {
      if (!isItemKind(kind)) {
        throw new DateConfigError(
          `[layout] gradable.${kind} is not a known item kind (${ITEM_KINDS.join(", ")})`,
        );
      }
      if (typeof pattern !== "string") {
        throw new DateConfigError(`[layout] gradable.${kind} must be a glob string`);
      }
      pairs.push([pattern, kind]);
    }
    gradable = pairs;
  }

  return new Layout({
    syllabus,
    pages: globList(section, "pages", DEFAULT_LAYOUT.pages),
    files: globList(section, "files", DEFAULT_LAYOUT.files),
    discussions: globList(section, "discussions", DEFAULT_LAYOUT.discussions),
    gradable,
  });
}

function strOverride(override: Record<string, unknown>, key: string, fallback: string, where: string): string {
  const value = get(override, key) ?? fallback;
  if (typeof value !== "string") {
    throw new DateConfigError(`[override.${pyRepr(where)}] ${key} must be a string, got ${pyRepr(value)}`);
  }
  return value;
}

function intOverride(override: Record<string, unknown>, key: string, fallback: number, where: string): number {
  const value = get(override, key) ?? fallback;
  // TOML's 2 and 2.0 both arrive as a JavaScript number, so an integral float
  // passes here where Python's isinstance(value, int) would refuse it.
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DateConfigError(`[override.${pyRepr(where)}] ${key} must be an integer, got ${pyRepr(value)}`);
  }
  return value;
}

// Aware datetimes in one zone, ordered by instant.
function earlier(a: DateTime, b: DateTime): DateTime {
  return a.toMillis() <= b.toMillis() ? a : b;
}

/** Generate dates for every gradable item in the repository. */
export function compute(repo: string, config?: DateConfig | null): ItemDates[] {
  const cfg = config ?? loadConfig(repo);
  const term = cfg.term;
  const tz = term.tz;
  const items: ItemDates[] = [];

  for (const directory of cfg.layout.gradableDirs) {
    const pattern = directory === "." ? "*.md" : `${directory}/*.md`;
    for (const rel of globRepo(repo, pattern)) {
      const kind = classify(rel, cfg.layout);
      if (kind === null) {
        continue;
      }
      const text = readFileSync(path.join(repo, rel), "utf-8");
      if (isDraft(text)) {
        // A draft is not a Canvas object, so it has no due date and does
        // not count toward the course total.
        continue;
      }
      const [week, points] = parseHeader(text);

      const policy = Object.hasOwn(cfg.policies, kind) ? cfg.policies[kind] : undefined;
      if (policy === undefined) {
        throw new DateConfigError(`no policy.${kind} in canvas.toml for ${rel}`);
      }

      const override = Object.hasOwn(cfg.overrides, rel) ? (cfg.overrides[rel] ?? {}) : {};
      const unlockRaw = get(override, "unlock") ?? policy.unlock;
      const unlockSpec = unlockRaw === null ? null : strOverride(override, "unlock", policy.unlock ?? "", rel);
      const dueSpec = strOverride(override, "due", policy.due, rel);
      const grace = intOverride(override, "grace_days", policy.graceDays, rel);

      let unlockAt: DateTime | null;
      let dueAt: DateTime;
      let lockAt: DateTime;
      if (week === null) {
        // A finals-week item: the finals window replaces the weekly one.
        unlockAt = unlockSpec ? at(term.finalsStart, "00:00", tz) : null;
        dueAt = at(term.finalsEnd, "23:59", tz);
        lockAt = dueAt;
      } else {
        const monday = term.mondayOf(week);
        unlockAt = unlockSpec ? resolve(unlockSpec, monday, tz) : null;
        dueAt = resolve(dueSpec, monday, tz);
        lockAt = dueAt.plus({ days: grace });
        // The Late Work Policy forbids accepting anything after the last
        // day of instruction, whatever the grace period would allow.
        const cutoff = at(term.lastDayOfInstruction, "23:59", tz);
        lockAt = earlier(lockAt, cutoff);
      }

      items.push(
        new ItemDates({
          path: rel,
          title: titleOf(text, path.posix.parse(rel).name),
          kind,
          week,
          points,
          unlockAt,
          dueAt,
          lockAt,
        }),
      );
    }
  }

  items.sort((a, b) => a.dueAt.toMillis() - b.dueAt.toMillis() || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return items;
}

/** strftime "%b %d %H:%M" / "%b %d" for a timestamp, in its own zone. */
function stamp(value: DateTime, withTime = true): string {
  return value.setLocale(LOCALE).toFormat(withTime ? "LLL dd HH:mm" : "LLL dd");
}

/** Return a list of problems; empty means the schedule is coherent. */
export function validate(items: readonly ItemDates[], term: Term): string[] {
  const problems: string[] = [];
  const tz = term.tz;
  const cutoff = at(term.lastDayOfInstruction, "23:59", tz);
  const breakMonday = term.breakMonday();

  for (const item of items) {
    const due = item.dueAt.toMillis();
    const lock = item.lockAt.toMillis();
    if (item.unlockAt === null) {
      if (due > lock) {
        problems.push(
          `${item.path}: dates out of order (due ${stamp(item.dueAt)}, lock ${stamp(item.lockAt)})`,
        );
      }
    } else if (!(item.unlockAt.toMillis() <= due && due <= lock)) {
      problems.push(
        `${item.path}: dates out of order ` +
          `(unlock ${stamp(item.unlockAt)}, due ${stamp(item.dueAt)}, lock ${stamp(item.lockAt)})`,
      );
    }
    if (item.week !== null && lock > cutoff.toMillis()) {
      problems.push(
        `${item.path}: locks ${stamp(item.lockAt, false)}, after the last day of ` +
          `instruction (${formatDate(term.lastDayOfInstruction, "LLL dd")})`,
      );
    }
    if (breakMonday !== null) {
      const breakEnd = addDays(breakMonday, 6);
      const unlockDay = item.unlockAt?.toISODate();
      if (item.unlockAt && unlockDay && breakMonday <= unlockDay && unlockDay <= breakEnd) {
        problems.push(`${item.path}: unlocks ${stamp(item.unlockAt, false)}, during the break week`);
      }
      // Null only for an invalid DateTime, and compute never builds one.
      const dueDay = item.dueAt.toISODate() as ISODate;
      if (breakMonday <= dueDay && dueDay <= breakEnd) {
        problems.push(`${item.path}: due ${stamp(item.dueAt, false)}, during the break week`);
      }
    }
  }

  const total = items.reduce((sum, item) => sum + item.points, 0);
  if (term.totalPoints && total !== term.totalPoints) {
    problems.push(`points across all gradable items sum to ${formatG(total)}, not ${formatG(term.totalPoints)}`);
  }
  return problems;
}

/** Assert the generated week boundaries match the ranges printed in the syllabus. */
export function crossCheckSyllabus(syllabus: string, term: Term): string[] {
  const problems: string[] = [];
  const text = readFileSync(syllabus, "utf-8");
  const year = Number(term.firstMonday.slice(0, 4));
  for (const match of text.matchAll(SCHEDULE_ROW_RE)) {
    const week = Number.parseInt(match.groups?.week ?? "", 10);
    if (week > term.weeks) {
      continue;
    }
    const printed = match.groups?.dates ?? "";
    const start = /^([A-Z][a-z]{2})\s+(\d{1,2})/.exec(printed);
    if (start === null) {
      problems.push(`week ${week}: cannot read the date range ${pyRepr(printed)}`);
      continue;
    }
    const month = Object.hasOwn(MONTHS, start[1] ?? "") ? MONTHS[start[1] ?? ""] : undefined;
    const actualDate = DateTime.fromObject({ year, month, day: Number(start[2]) }, { zone: "UTC", locale: LOCALE });
    if (month === undefined || !actualDate.isValid) {
      // Python raises here too (a KeyError or ValueError); this says why.
      throw new DateConfigError(`week ${week}: ${pyRepr(printed)} is not a real date`);
    }
    const expected = term.mondayOf(week);
    // Checked valid just above, so toISODate() is not null.
    const actual = actualDate.toISODate() as ISODate;
    if (expected !== actual) {
      problems.push(
        `week ${week}: syllabus says the week starts ${formatDate(actual, "LLL dd")}, ` +
          `canvas.toml computes ${formatDate(expected, "LLL dd")}`,
      );
    }
  }
  return problems;
}
