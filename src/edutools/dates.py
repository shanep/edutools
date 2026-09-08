"""Course due-date generation.

A course repository declares a *term skeleton* and one date policy per item type
in its ``canvas.toml``.  This module turns that into concrete, timezone-aware
``unlock_at`` / ``due_at`` / ``lock_at`` timestamps for every gradable item, so
that seventy-odd timestamps are derived rather than typed, and rolling the
course to a new semester means changing one date.

Nothing here talks to Canvas.  It is pure computation so it can be reviewed --
``edutools canvas dates --show`` -- and unit tested without a token.
"""

from __future__ import annotations

import datetime as dt
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final, Literal, cast, get_args
from zoneinfo import ZoneInfo

ItemKind = Literal["lab", "project", "quiz", "discussion", "exam"]

_WEEKDAY_OFFSET: Final[dict[str, int]] = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}

# "**Week 7 · 38 points · about 90 minutes · submit in Canvas**"
# "**Finals week · 150 points · 90 minutes · taken in Canvas**"
_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"^\*\*(?P<when>Week\s+(?P<week>\d+)|Finals week)\s*·\s*(?P<points>[\d.]+)\s+points",
    re.MULTILINE,
)

# "| 1 | Jan 11–17 | ..."  from the syllabus schedule table
_SCHEDULE_ROW_RE: Final[re.Pattern[str]] = re.compile(
    r"^\|\s*(?P<week>\d+)\s*\|\s*(?P<dates>[A-Z][a-z]{2}\s+\d{1,2}\s*[–-]\s*(?:[A-Z][a-z]{2}\s+)?\d{1,2})",
    re.MULTILINE,
)

_MONTHS: Final[dict[str, int]] = {
    m: i + 1
    for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    )
}


class DateConfigError(ValueError):
    """Raised when canvas.toml cannot produce a coherent set of dates."""


@dataclass(frozen=True)
class Term:
    """The academic skeleton every date is derived from."""

    timezone: str
    first_monday: dt.date
    weeks: int
    break_after_week: int | None
    last_day_of_instruction: dt.date
    finals_start: dt.date
    finals_end: dt.date
    # What every gradable item should add up to. Zero means the course grades by
    # weighted assignment groups instead, so there is no total to check against.
    total_points: float = 1000

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    def monday_of(self, week: int) -> dt.date:
        """The real calendar Monday that starts `week`, skipping any break week."""
        if not 1 <= week <= self.weeks:
            raise DateConfigError(f"week {week} is outside 1..{self.weeks}")
        skipped = 1 if (self.break_after_week is not None and week > self.break_after_week) else 0
        return self.first_monday + dt.timedelta(weeks=week - 1 + skipped)

    def break_monday(self) -> dt.date | None:
        """The Monday of the break week, if the term has one."""
        if self.break_after_week is None:
            return None
        return self.first_monday + dt.timedelta(weeks=self.break_after_week)


@dataclass(frozen=True)
class Policy:
    """How one kind of item is scheduled within its week."""

    # Omitted entirely when a course wants no "Available from" date, which leaves
    # the item visible as soon as it is published.
    unlock: str | None  # e.g. "mon 00:00"
    due: str            # e.g. "sun 23:59"
    grace_days: int  # days between due_at and lock_at


@dataclass(frozen=True)
class Group:
    """One Canvas assignment group, and which item kinds belong in it.

    Weights live here rather than on the per-kind date policy because Canvas
    weights a group, not a kind, and because a group can carry weight with no
    repository item in it at all: a course whose exams are hand built quizzes
    still needs an "Exams" group worth 50% of the grade.
    """

    name: str
    # None means the weight is managed in Canvas and a push must not send one.
    # An extra credit group that is raised by hand before final grades depends
    # on that: a declared 0 would put it back every time the course is pushed.
    weight: float | None = None
    kinds: tuple[ItemKind, ...] = ()


@dataclass(frozen=True)
class ItemDates:
    """The three Canvas date fields for one gradable item."""

    path: str
    title: str
    kind: ItemKind
    week: int | None      # None for finals-week items
    points: float
    unlock_at: dt.datetime | None
    due_at: dt.datetime
    lock_at: dt.datetime

    def shifted(self, days: int) -> ItemDates:
        delta = dt.timedelta(days=days)
        return ItemDates(
            self.path, self.title, self.kind, self.week, self.points,
            self.unlock_at + delta if self.unlock_at else None,
            self.due_at + delta, self.lock_at + delta,
        )


def _at(day: dt.date, clock: str, tz: ZoneInfo) -> dt.datetime:
    """Combine a date with a "HH:MM" clock time in `tz`."""
    hour, minute = (int(part) for part in clock.split(":"))
    return dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)


def resolve(spec: str, monday: dt.date, tz: ZoneInfo) -> dt.datetime:
    """Turn a spec like "sun 23:59" into a datetime in the week starting `monday`."""
    try:
        weekday, clock = spec.split()
        offset = _WEEKDAY_OFFSET[weekday.lower()]
    except (ValueError, KeyError) as exc:
        raise DateConfigError(
            f"bad date spec {spec!r}; expected e.g. 'sun 23:59'"
        ) from exc
    return _at(monday + dt.timedelta(days=offset), clock, tz)


def parse_header(text: str) -> tuple[int | None, float]:
    """Read the bold header line of a course file.

    Returns ``(week, points)``; ``week`` is None for finals-week items.
    """
    match = _HEADER_RE.search(text)
    if match is None:
        raise DateConfigError("no '**Week N · P points …**' header line found")
    week = int(match.group("week")) if match.group("week") else None
    return week, float(match.group("points"))


@dataclass(frozen=True)
class Layout:
    """What a course repo calls its files.

    Two courses name the same things differently: CS331 has ``assignments/lab-*.md``
    and a ``syllabus.md``, CS425 has ``assignments/p0.md`` and uses ``index.md`` as
    its syllabus because the same directory is also a VitePress site.  Rather than
    grow a second set of hardcoded globs, a repo declares its own shape in the
    ``[layout]`` section of ``canvas.toml`` and everything else reads it from here.
    """

    syllabus: str = "syllabus.md"
    pages: tuple[str, ...] = (
        "objectives.md",
        "resources.md",
        "modules/*.md",
        "assignments/*-exam-guide.md",
    )
    files: tuple[str, ...] = ("docs/*.pdf", "data/*")
    gradable: tuple[tuple[str, ItemKind], ...] = (
        ("assignments/lab-*.md", "lab"),
        ("assignments/p[0-9]*.md", "project"),
        ("quizzes/quiz-*.md", "quiz"),
        ("discussions/*.md", "discussion"),
    )

    @property
    def gradable_dirs(self) -> tuple[str, ...]:
        """Every directory a gradable item can live in, without duplicates."""
        seen: dict[str, None] = {}
        for pattern, _ in self.gradable:
            seen.setdefault(PurePosixPath(pattern).parent.as_posix(), None)
        return tuple(seen)


DEFAULT_LAYOUT: Final[Layout] = Layout()

# Pages are matched before gradable items so that a file caught by both, such as
# an exam guide that also sits under assignments/, stays a page.
_EXAM_GUIDE_RE: Final[re.Pattern[str]] = re.compile(r"-exam-guide\.md$")


def classify(path: Path, layout: Layout = DEFAULT_LAYOUT) -> ItemKind | None:
    """Decide what kind of gradable item a repo file is, or None if it is not one."""
    name, parent = path.name, path.parent.name
    if parent == "assignments" and _EXAM_GUIDE_RE.search(name):
        return "exam"
    for pattern, kind in layout.gradable:
        pure = PurePosixPath(pattern)
        if parent == pure.parent.as_posix() and PurePosixPath(name).match(pure.name):
            return kind
    return None


def title_of(text: str, fallback: str) -> str:
    """The document's first level-1 heading."""
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


@dataclass(frozen=True)
class DateConfig:
    """Everything canvas.toml says about scheduling."""

    term: Term
    policies: dict[str, Policy]
    overrides: dict[str, dict[str, object]]
    layout: Layout = DEFAULT_LAYOUT
    groups: tuple[Group, ...] = ()

    def group_for(self, kind: str) -> Group | None:
        """The assignment group an item of this kind belongs in, if any."""
        for group in self.groups:
            if kind in group.kinds:
                return group
        return None

    @property
    def total_weight(self) -> float:
        """The declared weights added up, for a course that weights by group."""
        return sum(group.weight for group in self.groups if group.weight is not None)


def _as_date(value: object, field: str) -> dt.date:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    raise DateConfigError(f"[term] {field} must be a date, got {value!r}")


def load_config(repo: Path) -> DateConfig:
    """Read the [term], [policy] and [override] sections of <repo>/canvas.toml."""
    config_path = repo / "canvas.toml"
    if not config_path.exists():
        raise DateConfigError(f"no canvas.toml in {repo}")
    with config_path.open("rb") as handle:
        raw = tomllib.load(handle)

    term_raw = raw.get("term")
    if not isinstance(term_raw, dict):
        raise DateConfigError("canvas.toml has no [term] section")

    break_after = term_raw.get("break_after_week")
    term = Term(
        timezone=str(term_raw.get("timezone", "America/Denver")),
        first_monday=_as_date(term_raw.get("first_monday"), "first_monday"),
        weeks=int(term_raw.get("weeks", 0)),
        break_after_week=int(break_after) if break_after is not None else None,
        last_day_of_instruction=_as_date(
            term_raw.get("last_day_of_instruction"), "last_day_of_instruction"
        ),
        finals_start=_as_date(term_raw.get("finals_start"), "finals_start"),
        finals_end=_as_date(term_raw.get("finals_end"), "finals_end"),
        total_points=float(term_raw.get("total_points", 1000)),
    )
    if term.first_monday.weekday() != 0:
        raise DateConfigError(
            f"[term] first_monday {term.first_monday} is a "
            f"{term.first_monday.strftime('%A')}, not a Monday"
        )

    policy_raw = term_raw.get("policy")
    if not isinstance(policy_raw, dict):
        raise DateConfigError("canvas.toml [term] has no policy.* entries")
    policies: dict[str, Policy] = {}
    for kind, spec in policy_raw.items():
        if not isinstance(spec, dict):
            raise DateConfigError(f"policy.{kind} must be a table")
        policies[str(kind)] = Policy(
            unlock=str(spec["unlock"]) if spec.get("unlock") is not None else None,
            due=str(spec["due"]),
            grace_days=int(spec.get("grace_days", 0)),
        )

    overrides_raw = raw.get("override", {})
    overrides: dict[str, dict[str, object]] = {
        str(k): dict(v) for k, v in overrides_raw.items() if isinstance(v, dict)
    }
    return DateConfig(
        term=term, policies=policies, overrides=overrides,
        layout=load_layout(raw), groups=load_groups(raw),
    )


def load_groups(raw: dict[str, object]) -> tuple[Group, ...]:
    """Read the optional [[group]] blocks, in the order they are declared.

    An absent section returns nothing, and a push then leaves the course's
    assignment groups and its weighting setting exactly as they are. File order
    becomes the Canvas position, so the gradebook reads the way the syllabus does.
    """
    section = raw.get("group")
    if section is None:
        return ()
    if not isinstance(section, list):
        raise DateConfigError("canvas.toml [[group]] must be a list of tables")

    groups: list[Group] = []
    names: set[str] = set()
    claimed: dict[str, str] = {}
    for entry in section:
        if not isinstance(entry, dict):
            raise DateConfigError(f"each [[group]] must be a table, got {entry!r}")

        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise DateConfigError(f"[[group]] name must be a non-empty string, got {name!r}")
        if name in names:
            raise DateConfigError(f"[[group]] {name!r} is declared twice")
        names.add(name)

        weight = entry.get("weight")
        if weight is not None and (isinstance(weight, bool) or not isinstance(weight, (int, float))):
            raise DateConfigError(f"[[group]] {name!r} weight must be a number, got {weight!r}")

        kinds_raw = entry.get("kinds", [])
        if not isinstance(kinds_raw, list):
            raise DateConfigError(f"[[group]] {name!r} kinds must be a list of item kinds")
        kinds: list[ItemKind] = []
        for kind in kinds_raw:
            if kind not in get_args(ItemKind):
                raise DateConfigError(
                    f"[[group]] {name!r} kind {kind!r} is not a known item kind "
                    f"({', '.join(get_args(ItemKind))})"
                )
            # Canvas files an assignment under exactly one group, so two groups
            # claiming the same kind is a configuration bug rather than a merge.
            if kind in claimed:
                raise DateConfigError(
                    f"item kind {kind!r} is claimed by both {claimed[str(kind)]!r} and {name!r}"
                )
            claimed[str(kind)] = name
            kinds.append(cast(ItemKind, kind))

        groups.append(
            Group(
                name=name,
                weight=float(weight) if weight is not None else None,
                kinds=tuple(kinds),
            )
        )
    return tuple(groups)


def _glob_list(raw: dict[str, object], key: str, default: tuple[str, ...]) -> tuple[str, ...]:
    value = raw.get(key)
    if value is None:
        return default
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise DateConfigError(f"[layout] {key} must be a list of glob strings, got {value!r}")
    return tuple(str(item) for item in value)


def load_layout(raw: dict[str, object]) -> Layout:
    """Read the optional [layout] section; an absent section keeps the defaults."""
    section = raw.get("layout")
    if section is None:
        return DEFAULT_LAYOUT
    if not isinstance(section, dict):
        raise DateConfigError("canvas.toml [layout] must be a table")

    syllabus = section.get("syllabus", DEFAULT_LAYOUT.syllabus)
    if not isinstance(syllabus, str):
        raise DateConfigError(f"[layout] syllabus must be a string, got {syllabus!r}")

    gradable_raw = section.get("gradable")
    if gradable_raw is None:
        gradable = DEFAULT_LAYOUT.gradable
    else:
        if not isinstance(gradable_raw, dict):
            raise DateConfigError("[layout] gradable must be a table of kind = glob")
        pairs: list[tuple[str, ItemKind]] = []
        for kind, pattern in gradable_raw.items():
            if kind not in get_args(ItemKind):
                raise DateConfigError(
                    f"[layout] gradable.{kind} is not a known item kind "
                    f"({', '.join(get_args(ItemKind))})"
                )
            if not isinstance(pattern, str):
                raise DateConfigError(f"[layout] gradable.{kind} must be a glob string")
            pairs.append((pattern, cast(ItemKind, kind)))
        gradable = tuple(pairs)

    return Layout(
        syllabus=syllabus,
        pages=_glob_list(section, "pages", DEFAULT_LAYOUT.pages),
        files=_glob_list(section, "files", DEFAULT_LAYOUT.files),
        gradable=gradable,
    )


def _str_override(override: dict[str, object], key: str, default: str, where: str) -> str:
    value = override.get(key, default)
    if not isinstance(value, str):
        raise DateConfigError(f"[override.{where!r}] {key} must be a string, got {value!r}")
    return value


def _int_override(override: dict[str, object], key: str, default: int, where: str) -> int:
    value = override.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise DateConfigError(f"[override.{where!r}] {key} must be an integer, got {value!r}")
    return value


def compute(repo: Path, config: DateConfig | None = None) -> list[ItemDates]:
    """Generate dates for every gradable item in the repository."""
    cfg = config or load_config(repo)
    term, tz = cfg.term, cfg.term.tz
    items: list[ItemDates] = []

    for directory in cfg.layout.gradable_dirs:
        for path in sorted((repo / directory).glob("*.md")):
            kind = classify(path, cfg.layout)
            if kind is None:
                continue
            text = path.read_text(encoding="utf-8")
            week, points = parse_header(text)
            rel = path.relative_to(repo).as_posix()

            policy = cfg.policies.get(kind)
            if policy is None:
                raise DateConfigError(f"no policy.{kind} in canvas.toml for {rel}")

            override = cfg.overrides.get(rel, {})
            unlock_raw = override.get("unlock", policy.unlock)
            unlock_spec = (
                None if unlock_raw is None
                else _str_override(override, "unlock", policy.unlock or "", rel)
            )
            due_spec = _str_override(override, "due", policy.due, rel)
            grace = _int_override(override, "grace_days", policy.grace_days, rel)

            if week is None:
                # A finals-week item: the finals window replaces the weekly one.
                unlock_at = _at(term.finals_start, "00:00", tz) if unlock_spec else None
                due_at = _at(term.finals_end, "23:59", tz)
                lock_at = due_at
            else:
                monday = term.monday_of(week)
                unlock_at = resolve(unlock_spec, monday, tz) if unlock_spec else None
                due_at = resolve(due_spec, monday, tz)
                lock_at = due_at + dt.timedelta(days=grace)
                # The Late Work Policy forbids accepting anything after the last
                # day of instruction, whatever the grace period would allow.
                cutoff = _at(term.last_day_of_instruction, "23:59", tz)
                lock_at = min(lock_at, cutoff)

            items.append(
                ItemDates(
                    path=rel,
                    title=title_of(text, path.stem),
                    kind=kind,
                    week=week,
                    points=points,
                    unlock_at=unlock_at,
                    due_at=due_at,
                    lock_at=lock_at,
                )
            )

    items.sort(key=lambda i: (i.due_at, i.path))
    return items


def validate(items: list[ItemDates], term: Term) -> list[str]:
    """Return a list of problems; empty means the schedule is coherent."""
    problems: list[str] = []
    tz = term.tz
    cutoff = _at(term.last_day_of_instruction, "23:59", tz)
    break_monday = term.break_monday()

    for item in items:
        if item.unlock_at is None:
            if item.due_at > item.lock_at:
                problems.append(
                    f"{item.path}: dates out of order "
                    f"(due {item.due_at:%b %d %H:%M}, lock {item.lock_at:%b %d %H:%M})"
                )
        elif not (item.unlock_at <= item.due_at <= item.lock_at):
            problems.append(
                f"{item.path}: dates out of order "
                f"(unlock {item.unlock_at:%b %d %H:%M}, due {item.due_at:%b %d %H:%M}, "
                f"lock {item.lock_at:%b %d %H:%M})"
            )
        if item.week is not None and item.lock_at > cutoff:
            problems.append(
                f"{item.path}: locks {item.lock_at:%b %d} — after the last day of "
                f"instruction ({term.last_day_of_instruction:%b %d})"
            )
        if break_monday is not None:
            break_end = break_monday + dt.timedelta(days=6)
            if item.unlock_at and break_monday <= item.unlock_at.date() <= break_end:
                problems.append(
                    f"{item.path}: unlocks {item.unlock_at:%b %d}, during the break week"
                )
            if break_monday <= item.due_at.date() <= break_end:
                problems.append(f"{item.path}: due {item.due_at:%b %d}, during the break week")

    total = sum(i.points for i in items)
    if term.total_points and total != term.total_points:
        problems.append(
            f"points across all gradable items sum to {total:g}, "
            f"not {term.total_points:g}"
        )
    return problems


def cross_check_syllabus(syllabus: Path, term: Term) -> list[str]:
    """Assert the generated week boundaries match the ranges printed in the syllabus."""
    problems: list[str] = []
    text = syllabus.read_text(encoding="utf-8")
    year = term.first_monday.year
    for match in _SCHEDULE_ROW_RE.finditer(text):
        week = int(match.group("week"))
        if week > term.weeks:
            continue
        printed = match.group("dates")
        start = re.match(r"([A-Z][a-z]{2})\s+(\d{1,2})", printed)
        if start is None:
            problems.append(f"week {week}: cannot read the date range {printed!r}")
            continue
        expected = term.monday_of(week)
        actual = dt.date(year, _MONTHS[start.group(1)], int(start.group(2)))
        if expected != actual:
            problems.append(
                f"week {week}: syllabus says the week starts {actual:%b %d}, "
                f"canvas.toml computes {expected:%b %d}"
            )
    return problems
