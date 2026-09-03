"""Drive a whole course repository into Canvas, then check it landed.

Two passes, because links need ids that do not exist until objects are created:
pass one creates or updates every object and records it in the manifest; pass two
rewrites relative links against that manifest and updates the bodies.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from edutools.canvas import CanvasLMS
from edutools.dates import ItemDates, compute, load_config
from edutools.publish import (
    Entry,
    Manifest,
    PublishError,
    assert_no_forbidden_tags,
    decorate,
    inline_css,
    mark_table_rows,
    parse_quiz,
    parse_rubric,
    question_fields,
    render_markdown,
    rewrite_links,
    rubric_fields,
    wrap_tables,
)

Reporter = Callable[[str], None]

# Files published as Canvas pages rather than gradable objects.
TOP_LEVEL_PAGES = ("objectives.md", "resources.md")


@dataclass
class Plan:
    """One object to publish."""

    key: str
    kind: str
    title: str
    source: Path | None = None
    points: float | None = None
    dates: ItemDates | None = None
    extra: dict[str, str] = field(default_factory=dict)


@dataclass
class Result:
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)


def _slug(title: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


class Publisher:
    def __init__(
        self,
        repo: Path,
        course_id: str,
        canvas: CanvasLMS | None = None,
        *,
        publish: bool = False,
        dry_run: bool = False,
        report: Reporter = print,
    ) -> None:
        self.repo = repo.resolve()
        self.course_id = course_id
        self.canvas = canvas
        self.publish = publish
        self.dry_run = dry_run
        self.report = report
        self.manifest = Manifest.for_course(self.repo, course_id)
        self.config = load_config(self.repo)
        self.dates = {item.path: item for item in compute(self.repo, self.config)}
        css_path = self.repo / "canvas.css"
        self.css = css_path.read_text(encoding="utf-8") if css_path.exists() else ""
        self.rendered: dict[str, str] = {}
        self.dropped_css: set[str] = set()

    # -- rendering ------------------------------------------------------

    def render(self, source: Path) -> tuple[str, str]:
        """Markdown -> decorated, styled, Canvas-safe HTML."""
        title, html = render_markdown(source)
        html = wrap_tables(mark_table_rows(decorate(html)))
        if self.css:
            html, dropped = inline_css(html, self.css)
            self.dropped_css.update(dropped)
        forbidden = assert_no_forbidden_tags(html)
        if forbidden:
            raise PublishError(f"{source.name}: Canvas would strip {', '.join(forbidden)}")
        return title, html

    # -- planning -------------------------------------------------------

    def plan(self) -> list[Plan]:
        """Everything that will be created or updated, in dependency order."""
        plans: list[Plan] = []

        for name in ("docs/CyBOK_v1.1.0.pdf",):
            path = self.repo / name
            if path.exists():
                plans.append(Plan(key=name, kind="file", title=path.name, source=path))
        for path in sorted((self.repo / "data").glob("*")):
            if path.is_file():
                key = path.relative_to(self.repo).as_posix()
                plans.append(Plan(key=key, kind="file", title=path.name, source=path))

        for name in TOP_LEVEL_PAGES:
            path = self.repo / name
            if path.exists():
                plans.append(Plan(key=name, kind="page", title="", source=path))
        for path in sorted((self.repo / "modules").glob("*.md")):
            plans.append(Plan(key=path.relative_to(self.repo).as_posix(), kind="page", title="", source=path))
        for path in sorted((self.repo / "assignments").glob("*-exam-guide.md")):
            plans.append(Plan(key=path.relative_to(self.repo).as_posix(), kind="page", title="", source=path))

        for path in sorted((self.repo / "assignments").glob("lab-*.md")):
            key = path.relative_to(self.repo).as_posix()
            item = self.dates.get(key)
            plans.append(Plan(key=key, kind="assignment", title="", source=path,
                              points=item.points if item else None, dates=item))
        for path in sorted((self.repo / "discussions").glob("*.md")):
            key = path.relative_to(self.repo).as_posix()
            item = self.dates.get(key)
            plans.append(Plan(key=key, kind="discussion", title="", source=path,
                              points=item.points if item else None, dates=item))
        for path in sorted((self.repo / "quizzes").glob("*.md")):
            key = path.relative_to(self.repo).as_posix()
            item = self.dates.get(key)
            plans.append(Plan(key=key, kind="quiz", title="", source=path,
                              points=item.points if item else None, dates=item))

        plans.append(Plan(key="syllabus.md", kind="syllabus", title="Syllabus",
                          source=self.repo / "syllabus.md"))
        return plans

    # -- helpers --------------------------------------------------------

    def _date_fields(self, prefix: str, item: ItemDates | None) -> dict[str, str]:
        if item is None:
            return {}
        return {
            f"{prefix}[due_at]": item.due_at.isoformat(),
            f"{prefix}[unlock_at]": item.unlock_at.isoformat(),
            f"{prefix}[lock_at]": item.lock_at.isoformat(),
        }

    def _client(self) -> CanvasLMS:
        if self.canvas is None:
            raise PublishError("no Canvas client configured")
        return self.canvas

    # -- pass one -------------------------------------------------------

    def create_or_update(self, item: Plan) -> Result:
        result = Result()
        if item.source is None:
            return result

        if item.kind == "file":
            return self._push_file(item)

        title, html = self.render(item.source)
        item.title = title or item.title
        self.rendered[item.key] = html

        if self.dry_run:
            result.skipped = 1
            return result

        canvas = self._client()
        existing = self.manifest.get(item.key)

        if item.kind == "syllabus":
            canvas.update_syllabus(self.course_id, html)
            self.manifest.put(item.key, Entry(kind="syllabus", canvas_id=self.course_id, title=title))
            result.updated = 1
        elif item.kind == "page":
            if existing and canvas.exists(f"/api/v1/courses/{self.course_id}/pages/{existing.page_url}"):
                canvas.update_page(self.course_id, existing.page_url, title, html, self.publish)
                result.updated = 1
                page_url = existing.page_url
            else:
                created = canvas.create_page(self.course_id, title, html, self.publish)
                page_url = str(created.get("url", _slug(title)))
                result.created = 1
            self.manifest.put(item.key, Entry(kind="page", canvas_id=page_url, page_url=page_url, title=title))
        elif item.kind == "assignment":
            fields = {
                "assignment[name]": title,
                "assignment[description]": html,
                "assignment[points_possible]": f"{item.points or 0:g}",
                "assignment[submission_types][]": "online_text_entry",
                "assignment[published]": str(self.publish).lower(),
                **self._date_fields("assignment", item.dates),
            }
            if existing and canvas.exists(f"/api/v1/courses/{self.course_id}/assignments/{existing.canvas_id}"):
                canvas.update_assignment(self.course_id, existing.canvas_id, fields)
                canvas_id, result.updated = existing.canvas_id, 1
            else:
                created = canvas.create_assignment(self.course_id, fields)
                canvas_id, result.created = str(created["id"]), 1
            self.manifest.put(item.key, Entry(kind="assignment", canvas_id=canvas_id, title=title))
        elif item.kind == "discussion":
            fields = {
                "title": title,
                "message": html,
                "published": str(self.publish).lower(),
                "assignment[points_possible]": f"{item.points or 0:g}",
                **self._date_fields("assignment", item.dates),
            }
            if existing and canvas.exists(
                f"/api/v1/courses/{self.course_id}/discussion_topics/{existing.canvas_id}"
            ):
                stored = canvas.update_discussion(self.course_id, existing.canvas_id, fields)
                canvas_id, result.updated = existing.canvas_id, 1
            else:
                stored = canvas.create_discussion(self.course_id, fields)
                canvas_id, result.created = str(stored["id"]), 1
            extra = {"assignment_id": str(stored.get("assignment_id", ""))}
            self.manifest.put(item.key, Entry(kind="discussion", canvas_id=canvas_id, title=title, extra=extra))
        elif item.kind == "quiz":
            graded = (item.points or 0) > 0
            fields = {
                "quiz[title]": title,
                "quiz[description]": html,
                "quiz[quiz_type]": "assignment" if graded else "practice_quiz",
                "quiz[published]": str(self.publish).lower(),
                "quiz[allowed_attempts]": "1",
                "quiz[scoring_policy]": "keep_highest",
                **self._date_fields("quiz", item.dates),
            }
            if existing and canvas.exists(f"/api/v1/courses/{self.course_id}/quizzes/{existing.canvas_id}"):
                canvas.update_quiz(self.course_id, existing.canvas_id, fields)
                canvas_id, result.updated = existing.canvas_id, 1
            else:
                created = canvas.create_quiz(self.course_id, fields)
                canvas_id, result.created = str(created["id"]), 1
            self.manifest.put(item.key, Entry(kind="quiz", canvas_id=canvas_id, title=title))
            self._push_questions(item, canvas_id)
        return result

    def _push_file(self, item: Plan) -> Result:
        result = Result()
        if item.source is None:
            return result
        if self.dry_run:
            result.skipped = 1
            return result
        folder = "course files/" + item.source.parent.name
        stored = self._client().upload_file(self.course_id, item.source, folder=folder)
        self.manifest.put(
            item.key,
            Entry(kind="file", canvas_id=str(stored["id"]), title=item.source.name,
                  extra={"size": str(stored.get("size", ""))}),
        )
        result.created = 1
        return result

    def _push_questions(self, item: Plan, quiz_id: str) -> None:
        """Replace a quiz's questions so a re-push never duplicates them."""
        if item.source is None:
            return
        canvas = self._client()
        for existing in canvas.list_quiz_questions(self.course_id, quiz_id):
            canvas.delete_quiz_question(self.course_id, quiz_id, str(existing["id"]))
        for position, question in enumerate(parse_quiz(item.source), start=1):
            canvas.create_quiz_question(self.course_id, quiz_id, question_fields(question, position))

    # -- pass two -------------------------------------------------------

    def rewrite(self, item: Plan) -> list[str]:
        """Point relative links at Canvas objects and update the body."""
        if item.source is None or item.kind == "file":
            return []
        html = self.rendered.get(item.key)
        entry = self.manifest.get(item.key)
        if html is None or entry is None:
            return []
        rewritten, unresolved = rewrite_links(html, item.source, self.repo, self.manifest, self.course_id)
        self.rendered[item.key] = rewritten
        if self.dry_run or rewritten == html:
            return unresolved

        canvas = self._client()
        if entry.kind == "page":
            canvas.update_page(self.course_id, entry.page_url, body=rewritten)
        elif entry.kind == "assignment":
            canvas.update_assignment(self.course_id, entry.canvas_id, {"assignment[description]": rewritten})
        elif entry.kind == "discussion":
            canvas.update_discussion(self.course_id, entry.canvas_id, {"message": rewritten})
        elif entry.kind == "quiz":
            canvas.update_quiz(self.course_id, entry.canvas_id, {"quiz[description]": rewritten})
        elif entry.kind == "syllabus":
            canvas.update_syllabus(self.course_id, rewritten)
        return unresolved

    # -- modules --------------------------------------------------------

    def push_modules(self) -> Result:
        """Build the weekly modules from the [[module]] tables in canvas.toml."""
        result = Result()
        config_path = self.repo / "canvas.toml"
        with config_path.open("rb") as handle:
            raw = tomllib.load(handle)
        modules = raw.get("module", [])
        if not isinstance(modules, list) or self.dry_run:
            result.skipped = len(modules) if isinstance(modules, list) else 0
            return result

        canvas = self._client()
        existing = {str(m.get("name")): str(m.get("id")) for m in canvas.list_modules(self.course_id)}

        for position, module in enumerate(modules, start=1):
            if not isinstance(module, dict):
                continue
            name = str(module.get("title", f"Module {position}"))
            module_id = existing.get(name)
            if module_id is None:
                created = canvas.create_module(self.course_id, name, position)
                module_id = str(created["id"])
                result.created += 1
            else:
                canvas.update_module(self.course_id, module_id, {"module[position]": str(position)})
                result.updated += 1

            for current in canvas.list_module_items(self.course_id, module_id):
                canvas.delete_module_item(self.course_id, module_id, str(current["id"]))

            keys = [str(module.get("page", ""))] + [str(k) for k in module.get("items", [])]
            for index, key in enumerate([k for k in keys if k], start=1):
                entry = self.manifest.get(key)
                if entry is None:
                    result.errors.append(f"module {name!r}: {key} has not been published")
                    continue
                canvas_type = {
                    "page": "Page", "assignment": "Assignment",
                    "discussion": "Discussion", "quiz": "Quiz",
                }.get(entry.kind)
                if canvas_type is None:
                    continue
                fields = {
                    "module_item[title]": entry.title,
                    "module_item[type]": canvas_type,
                    "module_item[position]": str(index),
                }
                if canvas_type == "Page":
                    fields["module_item[page_url]"] = entry.page_url
                else:
                    fields["module_item[content_id]"] = entry.canvas_id
                canvas.create_module_item(self.course_id, module_id, fields)
        return result

    # -- rubrics --------------------------------------------------------

    def push_rubrics(self) -> Result:
        """Create a Canvas rubric per lab and discussion, bound to its assignment."""
        result = Result()
        if self.dry_run:
            return result
        canvas = self._client()
        for key, entry in sorted(self.manifest.entries.items()):
            if entry.kind not in ("assignment", "discussion"):
                continue
            source = self.repo / key
            if not source.exists():
                continue
            criteria = parse_rubric(source.read_text(encoding="utf-8"))
            if not criteria:
                continue
            association = entry.extra.get("assignment_id") or entry.canvas_id
            if entry.kind == "discussion" and not entry.extra.get("assignment_id"):
                result.errors.append(f"{key}: no assignment_id, cannot attach a rubric")
                continue
            canvas.create_rubric(
                self.course_id, rubric_fields(f"{entry.title} rubric", criteria, association)
            )
            result.created += 1
        return result
