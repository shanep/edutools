"""Field mapping for one-off Canvas object create / update / delete.

`edutools push` drives a whole course repository. This module covers the other
half: touching a single object. Canvas names the same idea differently on every
endpoint - an assignment has a `name`, a page has a `title`, a discussion takes
its parameters unprefixed while a quiz nests everything under `quiz[...]` - so
the mapping lives here as data and the CLI stays a thin wrapper over it.

Everything here is pure, so the whole mapping can be tested without a token.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from typing import Final

# Canvas object kinds this module can build fields for.
KINDS: Final[tuple[str, ...]] = ("page", "assignment", "discussion", "quiz", "module")


class FieldError(ValueError):
    """Raised when a value cannot be expressed for the requested kind."""


@dataclass(frozen=True)
class KindSpec:
    """How one Canvas kind names the fields every object shares.

    `prefix` is the bracket namespace ("" when Canvas takes bare parameters).
    `points` and `dates` are absolute keys because Canvas hangs a graded
    discussion's points and dates off `assignment[...]`, not off the topic.
    """

    prefix: str
    title: str
    body: str | None
    published: str
    points: str | None
    dates: str | None

    def key(self, name: str) -> str:
        return f"{self.prefix}[{name}]" if self.prefix else name


SPECS: Final[dict[str, KindSpec]] = {
    "page": KindSpec(
        prefix="wiki_page", title="title", body="body",
        published="wiki_page[published]", points=None, dates=None,
    ),
    "assignment": KindSpec(
        prefix="assignment", title="name", body="description",
        published="assignment[published]",
        points="assignment[points_possible]", dates="assignment",
    ),
    "discussion": KindSpec(
        prefix="", title="title", body="message",
        published="published",
        points="assignment[points_possible]", dates="assignment",
    ),
    "quiz": KindSpec(
        prefix="quiz", title="title", body="description",
        published="quiz[published]", points=None, dates="quiz",
    ),
    "module": KindSpec(
        prefix="module", title="name", body=None,
        published="module[published]", points=None, dates=None,
    ),
}


def spec_for(kind: str) -> KindSpec:
    try:
        return SPECS[kind]
    except KeyError:
        raise FieldError(f"unknown kind {kind!r}; expected one of {', '.join(KINDS)}") from None


def build_fields(
    kind: str,
    *,
    title: str | None = None,
    body: str | None = None,
    points: float | None = None,
    due: str | None = None,
    unlock: str | None = None,
    lock: str | None = None,
    published: bool | None = None,
    position: int | None = None,
    overrides: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build the form body for a create or update, omitting anything unset.

    Omission is the point: an update must not clear a field the caller never
    mentioned, so only what is passed here is sent to Canvas. `overrides` is
    applied last and wins, which is how any Canvas field this function does not
    model can still be set.
    """
    spec = spec_for(kind)
    fields: dict[str, str] = {}

    if title is not None:
        fields[spec.key(spec.title)] = title

    if body is not None:
        if spec.body is None:
            raise FieldError(f"a {kind} has no body")
        fields[spec.key(spec.body)] = body

    if points is not None:
        if spec.points is None:
            raise FieldError(
                f"a {kind} takes no points; it scores from its questions"
                if kind == "quiz"
                else f"a {kind} takes no points"
            )
        fields[spec.points] = f"{points:g}"

    dates = {"due_at": due, "unlock_at": unlock, "lock_at": lock}
    given = {name: value for name, value in dates.items() if value is not None}
    if given:
        if spec.dates is None:
            raise FieldError(f"a {kind} has no due / available dates")
        for name, value in given.items():
            fields[f"{spec.dates}[{name}]"] = value

    if published is not None:
        fields[spec.published] = str(published).lower()

    if position is not None:
        if kind != "module":
            raise FieldError(f"a {kind} has no position; only modules are ordered")
        fields[spec.key("position")] = str(position)

    fields.update(overrides or {})
    return fields


def parse_overrides(pairs: list[str] | None) -> dict[str, str]:
    """Turn --set 'assignment[omit_from_final_grade]=true' into a field pair."""
    parsed: dict[str, str] = {}
    for pair in pairs or []:
        name, sep, value = pair.partition("=")
        if not sep or not name.strip():
            raise FieldError(f"--set expects key=value, got {pair!r}")
        parsed[name.strip()] = value
    return parsed


# ---------------------------------------------------------------------------
# Grading input
# ---------------------------------------------------------------------------

# Column and key spellings accepted for each field, so a gradebook export and a
# hand-written JSON file both load without renaming anything.
_ALIASES: Final[dict[str, tuple[str, ...]]] = {
    "user_id": ("user_id", "student_id", "student", "id"),
    "grade": ("grade", "score", "posted_grade", "points"),
    "comment": ("comment", "feedback", "text_comment"),
    "excuse": ("excuse", "excused"),
    "late_policy_status": ("late_policy_status", "late_status"),
}


@dataclass(frozen=True)
class GradeRow:
    """One student's grade and feedback."""

    user_id: str
    grade: str | None = None
    comment: str | None = None
    excuse: bool | None = None
    late_policy_status: str | None = None
    rubric: dict[str, dict[str, str | float]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.grade is None and not self.comment and self.excuse is None and not self.rubric:
            raise FieldError(f"nothing to apply for student {self.user_id}")


def _pick(row: dict[str, object], name: str) -> object | None:
    for alias in _ALIASES[name]:
        if alias in row and row[alias] not in (None, ""):
            return row[alias]
    return None


def _as_bool(value: object) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def _row_from_mapping(row: dict[str, object]) -> GradeRow:
    user_id = _pick(row, "user_id")
    if user_id is None:
        raise FieldError(f"row is missing a student id: {row!r}")
    grade = _pick(row, "grade")
    comment = _pick(row, "comment")
    excuse = _pick(row, "excuse")
    late = _pick(row, "late_policy_status")
    rubric = row.get("rubric") or row.get("rubric_assessment")
    if rubric is not None and not isinstance(rubric, dict):
        raise FieldError(f"rubric for student {user_id} must be an object, got {rubric!r}")
    return GradeRow(
        user_id=str(user_id),
        grade=None if grade is None else str(grade),
        comment=None if comment is None else str(comment),
        excuse=None if excuse is None else _as_bool(excuse),
        late_policy_status=None if late is None else str(late),
        rubric=dict(rubric) if isinstance(rubric, dict) else {},
    )


def parse_grades(text: str, *, as_csv: bool = False) -> list[GradeRow]:
    """Read a batch of grades from JSON or CSV.

    JSON is either a list of objects or an object keyed by student id. CSV needs
    a header row. Either way the column names are matched loosely, so `score`,
    `grade`, and `points` all mean the same thing.
    """
    if as_csv:
        records: list[dict[str, object]] = [
            {str(k): v for k, v in row.items()} for row in csv.DictReader(io.StringIO(text))
        ]
        if not records:
            raise FieldError("no rows found; the CSV needs a header row")
        return [_row_from_mapping(record) for record in records]

    try:
        loaded = json.loads(text)
    except json.JSONDecodeError as error:
        raise FieldError(f"not valid JSON: {error}") from None

    if isinstance(loaded, dict):
        rows: list[GradeRow] = []
        for key, value in loaded.items():
            if isinstance(value, dict):
                # A keyed object may still name the student inside; the key is
                # only the fallback.
                merged: dict[str, object] = {str(k): v for k, v in value.items()}
                merged.setdefault("user_id", key)
                rows.append(_row_from_mapping(merged))
            else:
                rows.append(_row_from_mapping({"user_id": str(key), "grade": value}))
        return rows
    if isinstance(loaded, list):
        rows = []
        for entry in loaded:
            if not isinstance(entry, dict):
                raise FieldError(f"expected a list of objects, found {entry!r}")
            rows.append(_row_from_mapping({str(k): v for k, v in entry.items()}))
        return rows
    raise FieldError("expected a JSON list of objects or an object keyed by student id")
