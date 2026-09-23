"""Compare the manifest against what a course actually contains.

`verify` walks the manifest and proves each tracked object is still in Canvas
and intact. It never looks the other way, so an exam quiz built by hand, a page
someone added in the Canvas UI, or a file uploaded from a laptop is invisible
to it. This module takes both inventories and reports the differences in both
directions:

    stale      the manifest points at something Canvas no longer has
    untracked  Canvas has something no repo file produced
    pending    canvas.toml declares a module the next push will create

Modules are not in the manifest at all; the push pairs them with the
``[[module]]`` tables in canvas.toml by name, so they are compared by name here
too, and their items are checked against the manifest one by one.

Everything here is pure: the caller fetches the live inventory and hands it in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from edutools.dates import Term, module_title
from edutools.publish import Manifest, NativeItem, module_entries, parse_native_items

Side = Literal["stale", "untracked", "pending"]


@dataclass(frozen=True)
class DeclaredModule:
    """One [[module]] table from canvas.toml, as far as the audit cares."""

    title: str
    native: tuple[NativeItem, ...] = ()


def declared_modules(raw: dict[str, object], term: Term | None = None) -> list[DeclaredModule]:
    """The [[module]] tables of a parsed canvas.toml.

    A malformed ``canvas`` list is the push's problem to report; here it just
    contributes no native items, so its module's hand placed items show up as
    untracked, which is the truthful answer.
    """
    modules = raw.get("module", [])
    if not isinstance(modules, list):
        return []
    out: list[DeclaredModule] = []
    for module in modules:
        if not isinstance(module, dict):
            continue
        try:
            native = tuple(parse_native_items(module))
            native += tuple(e.native for e in module_entries(module) if e.native is not None)
        except ValueError:
            native = ()
        title = module_title(module, term) if term is not None else str(module.get("title", ""))
        out.append(DeclaredModule(title, native))
    return out


@dataclass(frozen=True)
class LiveObject:
    """One thing that exists in the course right now."""

    kind: str
    ident: str
    title: str
    published: bool = False
    detail: str = ""


@dataclass(frozen=True)
class Difference:
    side: Side
    kind: str
    ident: str
    title: str
    key: str = ""
    detail: str = ""


def _ident(kind: str, entry_id: str, page_url: str) -> str:
    return page_url if kind == "page" else entry_id


def live_pages(pages: list[dict[str, object]]) -> list[LiveObject]:
    return [
        LiveObject("page", str(p.get("url", "")), str(p.get("title", "")), bool(p.get("published")))
        for p in pages
    ]


def live_assignments(assignments: list[dict[str, object]]) -> list[LiveObject]:
    """Plain assignments only.

    Canvas lists a quiz and a graded discussion as assignments too, with the
    real object hanging off them. Those are tracked as quizzes and discussions,
    so they are left out here rather than reported twice.
    """
    out: list[LiveObject] = []
    for a in assignments:
        if a.get("is_quiz_assignment") or a.get("quiz_id"):
            continue
        if a.get("discussion_topic"):
            continue
        out.append(
            LiveObject("assignment", str(a.get("id", "")), str(a.get("name", "")), bool(a.get("published")))
        )
    return out


def live_discussions(topics: list[dict[str, object]]) -> list[LiveObject]:
    return [
        LiveObject("discussion", str(t.get("id", "")), str(t.get("title", "")), bool(t.get("published")))
        for t in topics
    ]


def live_quizzes(quizzes: list[dict[str, object]]) -> list[LiveObject]:
    return [
        LiveObject("quiz", str(q.get("id", "")), str(q.get("title", "")), bool(q.get("published")))
        for q in quizzes
    ]


def live_files(files: list[dict[str, object]]) -> list[LiveObject]:
    return [
        LiveObject(
            "file",
            str(f.get("id", "")),
            str(f.get("display_name") or f.get("filename", "")),
            not bool(f.get("locked")) and not bool(f.get("hidden")),
            f"{f.get('size', '')} bytes",
        )
        for f in files
    ]


def live_modules(
    modules: list[dict[str, object]], items: dict[str, list[dict[str, object]]]
) -> list[LiveObject]:
    """Modules, with the count of items each holds in ``detail``."""
    return [
        LiveObject(
            "module",
            str(m.get("id", "")),
            str(m.get("name", "")),
            bool(m.get("published")),
            f"{len(items.get(str(m.get('id', '')), []))} items",
        )
        for m in modules
    ]


def audit_objects(manifest: Manifest, live: list[LiveObject], drafts: set[str]) -> list[Difference]:
    """Manifest entries against the live pages, assignments, discussions, quizzes and files."""
    tracked: dict[tuple[str, str], str] = {}
    for key, entry in manifest.entries.items():
        if entry.kind in ("module", "syllabus"):
            continue
        tracked[(entry.kind, _ident(entry.kind, entry.canvas_id, entry.page_url))] = key

    present = {(obj.kind, obj.ident) for obj in live}
    differences: list[Difference] = []

    for (kind, ident), key in sorted(tracked.items(), key=lambda item: item[1]):
        if (kind, ident) in present:
            continue
        entry = manifest.entries[key]
        note = "draft, so the next push will not recreate it" if key in drafts else ""
        differences.append(Difference("stale", kind, ident, entry.title, key, note))

    for obj in sorted(live, key=lambda o: (o.kind, o.title)):
        if (obj.kind, obj.ident) in tracked:
            continue
        state = "published" if obj.published else "unpublished"
        detail = f"{state}; {obj.detail}" if obj.detail else state
        differences.append(Difference("untracked", obj.kind, obj.ident, obj.title, "", detail))

    return differences


def audit_modules(
    declared: list[DeclaredModule],
    modules: list[LiveObject],
    items: dict[str, list[dict[str, object]]],
    manifest: Manifest,
) -> list[Difference]:
    """The [[module]] tables against the live modules, and each module's items
    against the manifest and the module's own ``canvas`` list.

    A module item that neither the manifest nor the ``canvas`` list knows is
    reported, because the next push deletes every item in a tracked module and
    rebuilds it from canvas.toml, so anything added by hand is about to
    disappear. Naming it under ``canvas`` is what keeps it.
    """
    differences: list[Difference] = []
    live_by_name = {m.title: m for m in modules}
    declared_by_title = {d.title: d for d in declared}

    # A declared module Canvas lacks is not an inconsistency: modules have no
    # manifest entry, and the next push creates it. It is listed so nobody is
    # surprised when it appears.
    for title in declared_by_title:
        if title not in live_by_name:
            differences.append(
                Difference("pending", "module", "", title, "", "declared in canvas.toml; the next push creates it")
            )

    tracked: set[tuple[str, str]] = set()
    for entry in manifest.entries.values():
        tracked.add((entry.kind, _ident(entry.kind, entry.canvas_id, entry.page_url)))

    for module in modules:
        declared_module = declared_by_title.get(module.title)
        if declared_module is None:
            state = "published" if module.published else "unpublished"
            differences.append(
                Difference("untracked", "module", module.ident, module.title, "", f"{state}; {module.detail}")
            )
            continue
        known = tracked | {(n.kind, n.ident) for n in declared_module.native}
        for item in items.get(module.ident, []):
            kind = str(item.get("type", "")).lower()
            if kind == "page":
                ident = str(item.get("page_url", ""))
            elif kind in ("assignment", "discussion", "quiz", "file"):
                ident = str(item.get("content_id", ""))
            else:
                # Headers, external links and tools have no repo counterpart.
                ident = ""
            if not ident or (kind, ident) in known:
                continue
            differences.append(
                Difference(
                    "untracked", "module item", str(item.get("id", "")), str(item.get("title", "")),
                    "", f"{kind} in module {module.title!r}; the next push removes it "
                    f"unless canvas.toml lists it as {{ {kind} = {ident} }}",
                )
            )

    return differences


def summarise(differences: list[Difference]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for d in differences:
        label = f"{d.side} {d.kind}"
        counts[label] = counts.get(label, 0) + 1
    return counts


# ---------------------------------------------------------------------------
# Clean sync: what a start-of-term push --clean removes
# ---------------------------------------------------------------------------

# Files are left out on purpose. A course card or a hand-uploaded handout is
# referenced from course settings and from pages the repo does not know about,
# and a stray file costs nothing, so a clean sync never deletes one.
CLEANABLE: tuple[str, ...] = ("page", "assignment", "discussion", "quiz", "module")


def clean_keep(raw: dict[str, object], declared: list[DeclaredModule]) -> set[tuple[str, str]]:
    """Everything a clean sync must leave: every native item a [[module]] names,
    plus the `[clean] keep` list, written like a module's native items::

        [clean]
        keep = [{ quiz = 393731 }, { page = "home-page" }]
    """
    keep = {(n.kind, n.ident) for module in declared for n in module.native}
    section = raw.get("clean", {})
    if not isinstance(section, dict):
        raise ValueError("canvas.toml [clean] must be a table")
    listed = cast(dict[str, object], section).get("keep", [])
    keep.update((n.kind, n.ident) for n in parse_native_items({"canvas": listed}))
    return keep


def clean_targets(differences: list[Difference], keep: set[tuple[str, str]]) -> list[Difference]:
    """The untracked objects a clean sync deletes, in a safe order.

    Modules go last, so a failure part-way through never leaves a module
    pointing at content that is already gone.
    """
    chosen = [
        d for d in differences
        if d.side == "untracked" and d.kind in CLEANABLE and (d.kind, d.ident) not in keep
    ]
    return sorted(chosen, key=lambda d: (d.kind == "module", d.kind, d.title))


def student_work(
    kind: str, stored: dict[str, object], assignment: dict[str, object] | None
) -> str:
    """Why this object holds student work, or "" if it holds none.

    A clean sync is for a course nobody has used yet. Deleting a graded object
    takes its submissions and grades with it, so anything with work in it is
    refused rather than deleted.
    """
    if assignment is not None and assignment.get("has_submitted_submissions"):
        return "has submissions"
    if kind == "assignment" and stored.get("has_submitted_submissions"):
        return "has submissions"
    if kind == "discussion":
        replies = stored.get("discussion_subentry_count")
        if isinstance(replies, int) and replies > 0:
            return f"has {replies} post(s)"
    return ""
