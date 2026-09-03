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
from pathlib import Path
from typing import Final, Literal
from zoneinfo import ZoneInfo

ItemKind = Literal["lab", "quiz", "discussion", "exam"]

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

    unlock: str      # e.g. "mon 00:00"
    due: str         # e.g. "sun 23:59"
    grace_days: int  # days between due_at and lock_at


@dataclass(frozen=True)
class ItemDates:
    """The three Canvas date fields for one gradable item."""

    path: str
    title: str
    kind: ItemKind
    week: int | None      # None for finals-week items
    points: float
    unlock_at: dt.datetime
    due_at: dt.datetime
    lock_at: dt.datetime

    def shifted(self, days: int) -> ItemDates:
        delta = dt.timedelta(days=days)
        return ItemDates(
            self.path, self.title, self.kind, self.week, self.points,
            self.unlock_at + delta, self.due_at + delta, self.lock_at + delta,
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


def classify(path: Path) -> ItemKind | None:
    """Decide what kind of gradable item a repo file is, or None if it is not one."""
    name, parent = path.name, path.parent.name
    if parent == "assignments" and name.startswith("lab-"):
        return "lab"
    if parent == "assignments" and name.endswith("-exam-guide.md"):
        return "exam"
    if parent == "quizzes" and name.startswith("quiz-"):
        return "quiz"
    if parent == "discussions":
        return "discussion"
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
            unlock=str(spec["unlock"]),
            due=str(spec["due"]),
            grace_days=int(spec.get("grace_days", 0)),
        )

    overrides_raw = raw.get("override", {})
    overrides: dict[str, dict[str, object]] = {
        str(k): dict(v) for k, v in overrides_raw.items() if isinstance(v, dict)
    }
    return DateConfig(term=term, policies=policies, overrides=overrides)


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

    for directory in ("assignments", "quizzes", "discussions"):
        for path in sorted((repo / directory).glob("*.md")):
            kind = classify(path)
            if kind is None:
                continue
            text = path.read_text(encoding="utf-8")
            week, points = parse_header(text)
            rel = path.relative_to(repo).as_posix()

            policy = cfg.policies.get(kind)
            if policy is None:
                raise DateConfigError(f"no policy.{kind} in canvas.toml for {rel}")

            override = cfg.overrides.get(rel, {})
            unlock_spec = _str_override(override, "unlock", policy.unlock, rel)
            due_spec = _str_override(override, "due", policy.due, rel)
            grace = _int_override(override, "grace_days", policy.grace_days, rel)

            if week is None:
                # A finals-week item: the finals window replaces the weekly one.
                unlock_at = _at(term.finals_start, "00:00", tz)
                due_at = _at(term.finals_end, "23:59", tz)
                lock_at = due_at
            else:
                monday = term.monday_of(week)
                unlock_at = resolve(unlock_spec, monday, tz)
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
        if not (item.unlock_at <= item.due_at <= item.lock_at):
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
            if break_monday <= item.unlock_at.date() <= break_end:
                problems.append(
                    f"{item.path}: unlocks {item.unlock_at:%b %d}, during the break week"
                )
            if break_monday <= item.due_at.date() <= break_end:
                problems.append(f"{item.path}: due {item.due_at:%b %d}, during the break week")

    total = sum(i.points for i in items)
    if total != 1000:
        problems.append(f"points across all gradable items sum to {total:g}, not 1000")
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
