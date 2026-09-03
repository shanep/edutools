"""Read published content back out of Canvas and prove it arrived intact.

A 200 response does not mean the content landed. Canvas scrubs page bodies
against its own allowlist and returns success either way, throttling can leave a
run half-finished, and a quiz can end up with some of its questions. So after
writing, we go and look.

Comparison is semantic rather than byte-for-byte: Canvas normalises markup and
adds its own data-api-* attributes, so both sides are reduced to visible text,
structural element counts, style declarations, and link targets before compare.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from edutools.publish import (
    Entry,
    Manifest,
    internal_links,
    structure_counts,
    style_declarations,
    visible_text,
)


@dataclass(frozen=True)
class Failure:
    """One thing that is wrong in Canvas."""

    key: str
    check: str
    detail: str


@dataclass(frozen=True)
class Intent:
    """What the publisher meant to put in Canvas, for one object."""

    key: str
    kind: str
    title: str
    body: str = ""
    points: float | None = None
    published: bool = False
    due_at: str | None = None
    unlock_at: str | None = None
    lock_at: str | None = None
    question_count: int = 0
    file_size: int | None = None
    module_items: int | None = None


def _iso(value: object) -> str | None:
    """Canvas returns UTC ISO 8601 with a Z; normalise for comparison."""
    if not isinstance(value, str) or not value:
        return None
    return value.replace("+00:00", "Z")


def _diff_text(intended: str, stored: str) -> str | None:
    """First point of divergence between two visible-text renderings."""
    if intended == stored:
        return None
    limit = min(len(intended), len(stored))
    index = next((i for i in range(limit) if intended[i] != stored[i]), limit)
    return (
        f"diverges at character {index} of {len(intended)}: "
        f"expected …{intended[max(0, index - 40):index + 40]!r}, "
        f"Canvas has …{stored[max(0, index - 40):index + 40]!r}"
    )


def check_body(key: str, intended: str, stored: str) -> list[Failure]:
    """Checks 2, 3 and 4: text, structure, and surviving style declarations."""
    failures: list[Failure] = []

    difference = _diff_text(visible_text(intended), visible_text(stored))
    if difference:
        failures.append(Failure(key, "content", difference))

    want, got = structure_counts(intended), structure_counts(stored)
    changed = {tag: (want[tag], got[tag]) for tag in want if want[tag] != got[tag]}
    if changed:
        summary = ", ".join(f"{tag}: sent {a}, stored {b}" for tag, (a, b) in sorted(changed.items()))
        failures.append(Failure(key, "structure", summary))

    sent_styles, kept_styles = style_declarations(intended), set(style_declarations(stored))
    lost = sorted({d for d in sent_styles if d not in kept_styles})
    if lost:
        shown = ", ".join(lost[:6]) + (f" (+{len(lost) - 6} more)" if len(lost) > 6 else "")
        failures.append(Failure(key, "styles", f"{len(lost)} declarations stripped: {shown}"))

    return failures


def check_links(
    key: str, body: str, course_id: str, known: set[str], resolves: Callable[[str], bool]
) -> list[Failure]:
    """Check 5: every course-relative link points at something that exists."""
    failures: list[Failure] = []
    for link in internal_links(body, course_id):
        if link in known:
            continue
        if not resolves(link):
            failures.append(Failure(key, "link", f"{link} does not resolve"))
    return failures


def check_metadata(key: str, intent: Intent, stored: dict[str, object]) -> list[Failure]:
    """Checks 6 and 7: points, published state, and the three date fields."""
    failures: list[Failure] = []

    if intent.points is not None:
        raw = stored.get("points_possible")
        actual = float(raw) if isinstance(raw, (int, float)) else None
        if actual != intent.points:
            failures.append(Failure(key, "points", f"expected {intent.points:g}, Canvas has {actual}"))

    if "published" in stored:
        actual_published = bool(stored.get("published"))
        if actual_published != intent.published:
            failures.append(
                Failure(key, "published", f"expected published={intent.published}, Canvas has {actual_published}")
            )

    for field_name in ("due_at", "unlock_at", "lock_at"):
        expected = getattr(intent, field_name)
        if expected is None:
            continue
        actual_date = _iso(stored.get(field_name))
        if actual_date != _iso(expected):
            failures.append(
                Failure(key, field_name, f"expected {_iso(expected)}, Canvas has {actual_date}")
            )

    return failures


def check_quiz_questions(
    key: str, expected_count: int, questions: list[dict[str, object]]
) -> list[Failure]:
    """Check 8: every question present, correctly typed and correctly keyed."""
    failures: list[Failure] = []
    if len(questions) != expected_count:
        failures.append(
            Failure(key, "questions", f"expected {expected_count} questions, Canvas has {len(questions)}")
        )

    for question in questions:
        name = str(question.get("question_name", "?"))
        answers = question.get("answers")
        if not isinstance(answers, list) or not answers:
            failures.append(Failure(key, "answers", f"{name}: no answers stored"))
            continue
        correct = [
            a for a in answers
            if isinstance(a, dict) and float(a.get("weight", 0) or 0) == 100
        ]
        if not correct:
            failures.append(Failure(key, "answers", f"{name}: no correct answer keyed"))
        kind = str(question.get("question_type", ""))
        if kind == "multiple_choice_question" and len(correct) != 1:
            failures.append(
                Failure(key, "answers", f"{name}: multiple choice with {len(correct)} correct answers")
            )
        if not str(question.get("neutral_comments", "")).strip():
            failures.append(Failure(key, "rationale", f"{name}: rationale missing"))
    return failures


def check_file(key: str, expected_size: int, stored: dict[str, object]) -> list[Failure]:
    """Check 9: the upload finished and the bytes all arrived."""
    failures: list[Failure] = []
    state = str(stored.get("upload_status") or stored.get("workflow_state") or "")
    if state not in ("", "success", "available"):
        failures.append(Failure(key, "file", f"upload state is {state!r}, not available"))
    raw = stored.get("size")
    actual = int(raw) if isinstance(raw, (int, str)) else None
    if actual != expected_size:
        failures.append(Failure(key, "file", f"expected {expected_size} bytes, Canvas has {actual}"))
    return failures


def check_module(key: str, expected_items: int, items: list[dict[str, object]]) -> list[Failure]:
    """Check 10: the module holds what it should, in order."""
    failures: list[Failure] = []
    if len(items) != expected_items:
        failures.append(
            Failure(key, "module", f"expected {expected_items} items, Canvas has {len(items)}")
        )
    positions = [int(str(i.get("position", 0))) for i in items]
    if positions != sorted(positions):
        failures.append(Failure(key, "module", "items are out of order"))
    return failures


def check_gradebook_total(assignments: list[dict[str, object]], expected: float) -> list[Failure]:
    """Check 11: nothing was lost between the repository and the gradebook."""
    total = 0.0
    for assignment in assignments:
        raw = assignment.get("points_possible")
        if isinstance(raw, (int, float)):
            total += float(raw)
    if total != expected:
        return [Failure("<course>", "gradebook", f"points total {total:g}, expected {expected:g}")]
    return []


def check_identity(key: str, entry: Entry, stored: dict[str, object] | None) -> list[Failure]:
    """Check 1: the object still exists and is still the one we created."""
    if stored is None:
        return [Failure(key, "missing", f"{entry.kind} {entry.canvas_id} does not resolve in Canvas")]
    title = str(stored.get("title") or stored.get("name") or "")
    if entry.title and title and title != entry.title:
        return [Failure(key, "title", f"expected {entry.title!r}, Canvas has {title!r}")]
    return []


def summarise(failures: list[Failure]) -> dict[str, int]:
    """Failure counts by check name, for the report table."""
    counts: dict[str, int] = {}
    for failure in failures:
        counts[failure.check] = counts.get(failure.check, 0) + 1
    return counts


def known_link_targets(manifest: Manifest, course_id: str) -> set[str]:
    """Every course-relative URL the manifest can vouch for."""
    from edutools.publish import canvas_path

    return {canvas_path(entry, course_id) for entry in manifest.entries.values()}
