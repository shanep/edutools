"""The module outline a push will build, computed from the repo alone.

A course website wants to show the same structure Canvas shows under Modules,
and it wants it at build time with no Canvas token in reach. Everything Canvas
will display is already in the repo: the ``[[module]]`` tables say what goes
where, each file's ``# Title`` is the item's name, and the meta line plus the
term skeleton give the due date and the points. This module assembles that
into one plain structure that a site can commit and render.

Pure: the caller reads canvas.toml and the item dates and hands them in.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from edutools.dates import ItemDates, Term, module_title
from edutools.publish import is_draft, module_entries, parse_native_items, strip_title


@dataclass(frozen=True)
class OutlineItem:
    """One row under a module, as Canvas will show it."""

    kind: str                    # page, assignment, discussion, quiz, file, header
    title: str
    path: str = ""               # repo path without .md, for the site to link; "" for a native item
    due_at: str | None = None    # ISO 8601 with offset
    points: float | None = None
    canvas_id: str = ""          # native items only


@dataclass(frozen=True)
class OutlineModule:
    title: str
    items: tuple[OutlineItem, ...] = field(default_factory=tuple)


def _title_of(path: Path) -> str:
    title, _ = strip_title(path.read_text(encoding="utf-8"))
    return title or path.stem


def outline(
    repo: Path,
    modules: list[dict[str, object]],
    kinds: dict[str, str],
    dates: dict[str, ItemDates],
    term: Term | None = None,
) -> list[OutlineModule]:
    """Build the outline.

    ``modules`` are the raw ``[[module]]`` tables, ``kinds`` maps a repo key to
    the Canvas kind the push gives it (page, assignment, quiz, ...), and
    ``dates`` holds the computed dates of every gradable item. A draft is left
    out, the same as the push leaves it out of its module. With ``term``, a
    module that declares a week is titled with its dates, as Canvas names it.
    """
    out: list[OutlineModule] = []
    for module in modules:
        # A never_publish module is instructor-only; students never see it in
        # Canvas, so the site's copy of the module list leaves it out too.
        if not isinstance(module, dict) or module.get("never_publish") is True:
            continue
        rows: list[OutlineItem] = []
        try:
            entries = module_entries(module)
        except ValueError:
            entries = []
        for line in entries:
            if line.header:
                rows.append(OutlineItem(kind="header", title=line.header))
                continue
            if line.native is not None:
                n = line.native
                rows.append(
                    OutlineItem(kind=n.kind, title=n.title or f"{n.kind} {n.ident}", canvas_id=n.ident)
                )
                continue
            key = line.key
            source = repo / key
            if not source.is_file() or is_draft(source.read_text(encoding="utf-8")):
                continue
            item = dates.get(key)
            rows.append(
                OutlineItem(
                    kind=kinds.get(key, "page"),
                    title=item.title if item else _title_of(source),
                    path=key[:-3] if key.endswith(".md") else key,
                    due_at=item.due_at.isoformat() if item else None,
                    points=item.points if item else None,
                )
            )
        try:
            native = parse_native_items(module)
        except ValueError:
            native = []
        for n in native:
            rows.append(
                OutlineItem(
                    kind=n.kind, title=n.title or f"{n.kind} {n.ident}", canvas_id=n.ident
                )
            )
        title = module_title(module, term) if term is not None else str(module.get("title", ""))
        out.append(OutlineModule(title, tuple(rows)))
    return out


def to_json(modules: list[OutlineModule]) -> list[dict[str, object]]:
    return [{"title": m.title, "items": [asdict(i) for i in m.items]} for m in modules]
