"""Snapshot a whole Canvas course to disk, exactly as Canvas stores it.

This is not the reverse of `push`. Nothing is converted: each object is written
as its raw JSON payload, its body as the HTML Canvas holds, and each course file
as its bytes. That keeps the snapshot lossless, so it serves as a backup, as
something to diff between two dates, and as input an agent can read without a
token.

`index.json` records every path a pull wrote. A later pull into the same
directory uses it to remove what it wrote before and did not write again (a
deleted page, a renamed assignment), and never touches anything else in the
directory. Whatever could not be fetched this time keeps its previous copy, so a
single 403 does not quietly erase part of the last good snapshot.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Final

from edutools.canvas import CanvasLMS

Reporter = Callable[[str], None]

# What `--only` accepts, in the order a pull walks them.
KINDS: Final[tuple[str, ...]] = (
    "syllabus",
    "pages",
    "assignments",
    "discussions",
    "announcements",
    "quizzes",
    "modules",
    "groups",
    "rubrics",
    "files",
)

INDEX_NAME: Final[str] = "index.json"

# The index kind of course.json, which every pull writes whatever --only says.
_COURSE: Final[str] = "course"

# What a failed fetch raises: the client's RuntimeError for an HTTP error, or a
# requests exception (an OSError) for a dropped connection mid-download.
_FETCH_ERRORS: Final = (RuntimeError, OSError)

# Every course folder hangs off this root, which would otherwise prefix every
# path in the snapshot without saying anything.
_ROOT_FOLDER: Final[str] = "course files"


class PullError(ValueError):
    """Raised when a pull is asked for something it cannot do."""


@dataclass
class Pulled:
    """One thing a pull wrote, and where."""

    kind: str
    ident: str
    title: str
    paths: list[str] = field(default_factory=list)


@dataclass
class PullResult:
    entries: list[Pulled] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    downloaded: int = 0
    # Course files already on disk at the size and time Canvas reports.
    unchanged: int = 0
    removed: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Pure path rules
# ---------------------------------------------------------------------------


def slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def stem(ident: str, title: str) -> str:
    """`<id>-<slug>`: the id keeps it unique, the slug keeps it readable."""
    tail = slug(title)
    return f"{ident}-{tail}" if tail else ident


def safe_component(name: str) -> str:
    """One path component that cannot climb out of the snapshot or split in two."""
    cleaned = name.replace("/", "_").replace("\\", "_").replace("\0", "_").strip()
    if cleaned in ("", ".", ".."):
        return "_"
    return cleaned


def file_path(folder: str, name: str) -> PurePosixPath:
    """Where a course file lands, under files/, mirroring its Canvas folder."""
    parts = [p for p in folder.split("/") if p]
    if parts and parts[0] == _ROOT_FOLDER:
        parts = parts[1:]
    return PurePosixPath("files", *[safe_component(p) for p in parts], safe_component(name))


def parse_time(value: object) -> float | None:
    """Epoch seconds for a Canvas timestamp, or None if it is not one."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def is_current(dest: Path, size: object, modified: float | None) -> bool:
    """True if a downloaded file already matches what Canvas reports.

    Size and modification time, as rsync does. The time is set from Canvas after
    each download, so an unchanged file costs no bytes on the next pull.
    """
    if not dest.is_file() or not isinstance(size, int) or modified is None:
        return False
    stat = dest.stat()
    return stat.st_size == size and int(stat.st_mtime) == int(modified)


def load_index(out: Path) -> dict[str, object]:
    path = out / INDEX_NAME
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def index_entries(index: dict[str, object]) -> list[Pulled]:
    raw = index.get("entries")
    entries: list[Pulled] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        paths = item.get("paths")
        entries.append(
            Pulled(
                kind=str(item.get("kind", "")),
                ident=str(item.get("ident", "")),
                title=str(item.get("title", "")),
                paths=[str(p) for p in paths] if isinstance(paths, list) else [],
            )
        )
    return entries


def stale_paths(previous: list[Pulled], current: list[Pulled], kinds: set[str]) -> list[str]:
    """Paths an earlier pull of these kinds wrote that this one did not."""
    kept = {p for entry in current for p in entry.paths}
    return sorted(
        {p for entry in previous if entry.kind in kinds for p in entry.paths} - kept
    )


def _title(payload: dict[str, object]) -> str:
    return str(payload.get("title") or payload.get("name") or payload.get("display_name") or "")


# ---------------------------------------------------------------------------
# The pull
# ---------------------------------------------------------------------------


class Puller:
    def __init__(
        self,
        canvas: CanvasLMS,
        course_id: str,
        out: Path,
        *,
        kinds: list[str] | None = None,
        report: Reporter = lambda _: None,
    ) -> None:
        unknown = [k for k in kinds or [] if k not in KINDS]
        if unknown:
            raise PullError(f"unknown kind {', '.join(unknown)}; expected one of {', '.join(KINDS)}")
        self.canvas = canvas
        self.course_id = course_id
        self.out = out
        self.kinds = [k for k in KINDS if not kinds or k in kinds]
        self.report = report
        self.previous = index_entries(load_index(out))
        self._previous_by_key = {(e.kind, e.ident): e for e in self.previous}
        self.result = PullResult()
        # Kinds whose listing came back whole. Only these are pruned: a listing
        # that failed says nothing about what was deleted.
        self._listed: set[str] = set()
        # Case-folded, since two files differing only in case collide on macOS.
        self._claimed: set[str] = set()

    # -- writing ---------------------------------------------------------

    def _write_json(self, rel: str, payload: object) -> str:
        path = self.out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return rel

    def _write_text(self, rel: str, text: str) -> str:
        path = self.out / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return rel

    def _object(self, kind: str, ident: str, title: str, base: str, payload: dict[str, object],
                body_field: str | None) -> Pulled:
        """Write one object's payload, and its body as HTML if it has one."""
        paths = [self._write_json(f"{base}.json", payload)]
        body = payload.get(body_field) if body_field else None
        if isinstance(body, str) and body:
            paths.append(self._write_text(f"{base}.html", body))
        return Pulled(kind=kind, ident=ident, title=title, paths=paths)

    def _failed(self, kind: str, ident: str, title: str, error: Exception) -> None:
        """Record the failure and keep whatever the last pull had for this object."""
        self.result.errors.append(f"{kind} {title or ident}: {error}")
        previous = self._previous_by_key.get((kind, ident))
        if previous is not None:
            self.result.entries.append(previous)

    # -- kinds -----------------------------------------------------------

    def _course(self) -> dict[str, object]:
        """course.json on every pull, since it names what the snapshot is of."""
        course = self.canvas.get_course_with_syllabus(self.course_id)
        title = _title(course)
        self.result.entries.append(Pulled(
            kind=_COURSE, ident=self.course_id, title=title,
            paths=[self._write_json("course.json", course)],
        ))
        self._listed.add(_COURSE)
        if "syllabus" in self.kinds:
            body = course.get("syllabus_body")
            paths = [self._write_text("syllabus.html", body)] if isinstance(body, str) and body else []
            self.result.entries.append(
                Pulled(kind="syllabus", ident=self.course_id, title=title, paths=paths)
            )
            self._listed.add("syllabus")
        return course

    def _pages(self) -> None:
        for listed in self.canvas.list_pages(self.course_id):
            # The listing leaves the body out, so each page is fetched on its own.
            page_url = str(listed.get("url", ""))
            title = _title(listed)
            try:
                page = self.canvas.get_page(self.course_id, page_url)
            except _FETCH_ERRORS as error:
                self._failed("pages", page_url, title, error)
                continue
            base = f"pages/{safe_component(page_url)}"
            self.result.entries.append(self._object("pages", page_url, title, base, page, "body"))

    def _collection(self, kind: str, items: list[dict[str, object]], body_field: str) -> None:
        for item in items:
            ident, title = str(item.get("id", "")), _title(item)
            base = f"{kind}/{stem(ident, title)}"
            self.result.entries.append(self._object(kind, ident, title, base, item, body_field))

    def _quizzes(self) -> None:
        for quiz in self.canvas.list_quizzes(self.course_id):
            ident, title = str(quiz.get("id", "")), _title(quiz)
            base = f"quizzes/{stem(ident, title)}"
            try:
                questions = self.canvas.list_quiz_questions(self.course_id, ident)
            except _FETCH_ERRORS as error:
                self._failed("quizzes", ident, title, error)
                continue
            entry = self._object("quizzes", ident, title, base, quiz, "description")
            entry.paths.append(self._write_json(f"{base}.questions.json", questions))
            self.result.entries.append(entry)

    def _modules(self) -> None:
        modules = self.canvas.list_modules(self.course_id)
        for module in modules:
            module["items"] = self.canvas.list_module_items(self.course_id, str(module.get("id", "")))
        self.result.entries.append(
            Pulled(kind="modules", ident="", title="modules",
                   paths=[self._write_json("modules.json", modules)])
        )

    def _files(self) -> None:
        folders = self.canvas.list_folders(self.course_id)
        files = self.canvas.list_files(self.course_id)
        names = {str(f.get("id", "")): str(f.get("full_name", "")) for f in folders}
        self.result.entries.append(
            Pulled(kind="files", ident="", title="files", paths=[
                self._write_json("folders.json", folders),
                self._write_json("files.json", files),
            ])
        )
        for stored in files:
            ident = str(stored.get("id", ""))
            name = str(stored.get("display_name") or stored.get("filename") or ident)
            rel = file_path(names.get(str(stored.get("folder_id", "")), ""), name)
            if str(rel).casefold() in self._claimed:
                rel = rel.with_name(f"{ident}-{rel.name}")
            self._claimed.add(str(rel).casefold())

            url = stored.get("url")
            if not isinstance(url, str) or not url:
                self._failed("files", ident, name, RuntimeError("Canvas gave no download url"))
                continue
            dest = self.out / rel
            modified = parse_time(stored.get("modified_at") or stored.get("updated_at"))
            self.report(f"Downloading {rel}")
            if is_current(dest, stored.get("size"), modified):
                self.result.unchanged += 1
            else:
                try:
                    self.canvas.download_attachment(url, dest)
                except _FETCH_ERRORS as error:
                    self._failed("files", ident, name, error)
                    continue
                if modified is not None:
                    os.utime(dest, (modified, modified))
                self.result.downloaded += 1
            self.result.entries.append(Pulled(kind="files", ident=ident, title=name, paths=[str(rel)]))

    # -- driver ----------------------------------------------------------

    def run(self) -> dict[str, object]:
        """Pull every selected kind, prune what went away, and return the index."""
        self.out.mkdir(parents=True, exist_ok=True)
        self.report("Reading course")
        course = self._course()

        steps: dict[str, Callable[[], None]] = {
            "pages": self._pages,
            "assignments": lambda: self._collection(
                "assignments", self.canvas.list_assignments(self.course_id), "description"),
            "discussions": lambda: self._collection(
                "discussions", self.canvas.list_discussions(self.course_id), "message"),
            "announcements": lambda: self._collection(
                "announcements", self.canvas.list_announcements(self.course_id), "message"),
            "quizzes": self._quizzes,
            "modules": self._modules,
            "groups": lambda: self.result.entries.append(Pulled(
                kind="groups", ident="", title="assignment groups",
                paths=[self._write_json("assignment_groups.json",
                                        self.canvas.list_assignment_groups(self.course_id))])),
            "rubrics": lambda: self.result.entries.append(Pulled(
                kind="rubrics", ident="", title="rubrics",
                paths=[self._write_json("rubrics.json", self.canvas.list_rubrics(self.course_id))])),
            "files": self._files,
        }
        for kind in self.kinds:
            step = steps.get(kind)
            if step is None:
                continue
            self.report(f"Reading {kind}")
            try:
                step()
            except _FETCH_ERRORS as error:
                # A course with a tool switched off answers 404 for its listing.
                # Report it and carry on, and keep the last snapshot of that kind.
                self.result.errors.append(f"{kind}: {error}")
                done = {(e.kind, e.ident) for e in self.result.entries}
                self.result.entries.extend(
                    e for e in self.previous if e.kind == kind and (e.kind, e.ident) not in done
                )
                continue
            self._listed.add(kind)

        self._prune()

        # A partial pull (--only) must not forget the kinds it did not visit, or
        # the next full pull could not prune them.
        visited = {*self.kinds, _COURSE}
        entries = [e for e in self.previous if e.kind not in visited] + self.result.entries
        index: dict[str, object] = {
            "course_id": self.course_id,
            "course_name": _title(course),
            "pulled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "kinds": self.kinds,
            "entries": [asdict(e) for e in entries],
            "errors": self.result.errors,
        }
        self._write_json(INDEX_NAME, index)
        return index

    def _prune(self) -> None:
        root = self.out.resolve()
        for rel in stale_paths(self.previous, self.result.entries, self._listed):
            path = (self.out / rel).resolve()
            # index.json is only a file on disk; never follow it outside the snapshot.
            if not path.is_relative_to(root) or path == root / INDEX_NAME or not path.is_file():
                continue
            path.unlink()
            self.result.removed.append(rel)
