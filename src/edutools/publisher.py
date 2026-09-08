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

from edutools.canvas import CanvasLMS, as_number
from edutools.dates import Group, ItemDates, compute, load_config
from edutools.publish import (
    Entry,
    canvas_path,
    Manifest,
    PublishError,
    assert_no_forbidden_tags,
    decorate,
    inline_css,
    mark_table_rows,
    parse_quiz,
    parse_rubric,
    path_is_draft,
    question_fields,
    render_markdown,
    rewrite_links,
    rubric_fields,
    wrap_tables,
)

Reporter = Callable[[str], None]

# Which Canvas object each gradable kind becomes.  An exam guide is a study guide,
# published as a page; the exam itself is a Canvas quiz built by hand.
KIND_TO_CANVAS: dict[str, str] = {
    "lab": "assignment",
    "project": "assignment",
    "quiz": "quiz",
    "discussion": "discussion",
    "exam": "page",
}


@dataclass
class Plan:
    """One object to publish."""

    key: str
    kind: str
    title: str
    source: Path | None = None
    points: float | None = None
    dates: ItemDates | None = None
    # The repo kind this came from ("lab", "project", ...), which is what an
    # assignment group is declared against. `kind` above has already been
    # flattened to what Canvas calls the object.
    item_kind: str | None = None
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


def _group_differs(stored: dict[str, object], group: Group, position: int) -> bool:
    """True if Canvas's copy of this group does not match what the repo declares."""
    if group.weight is not None and as_number(stored.get("group_weight")) != group.weight:
        return True
    return int(as_number(stored.get("position"))) != position


class Publisher:
    def __init__(
        self,
        repo: Path,
        course_id: str,
        canvas: CanvasLMS | None = None,
        *,
        publish: bool = False,
        dry_run: bool = False,
        update_published: bool = False,
        report: Reporter = print,
    ) -> None:
        self.repo = repo.resolve()
        self.course_id = course_id
        self.canvas = canvas
        self.publish = publish
        self.dry_run = dry_run
        self.update_published = update_published
        self.report = report
        self.manifest = Manifest.for_course(self.repo, course_id)
        self.config = load_config(self.repo)
        self.dates = {item.path: item for item in compute(self.repo, self.config)}
        css_path = self.repo / "canvas.css"
        self.css = css_path.read_text(encoding="utf-8") if css_path.exists() else ""
        self.rendered: dict[str, str] = {}
        self.protected: set[str] = set()
        # Repo paths marked `draft: true`, filled in by plan().
        self.drafts: set[str] = set()
        # Canvas assignment group name -> id, filled in by sync_groups().
        self.groups: dict[str, str] = {}
        self._groups_synced = False
        self.dropped_css: set[str] = set()

    # -- rendering ------------------------------------------------------

    def render(self, source: Path) -> tuple[str, str]:
        """Markdown -> decorated, styled, Canvas-safe HTML."""
        title, html = render_markdown(source, self.repo)
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
        layout = self.config.layout
        plans: list[Plan] = []
        claimed: set[str] = set()

        def key_of(path: Path) -> str:
            return path.relative_to(self.repo).as_posix()

        def skip(path: Path) -> bool:
            """A draft is not a Canvas object, so it never enters the plan.

            Claiming the key as well keeps a later, looser glob from picking the
            same file back up as a page.
            """
            if not path_is_draft(path):
                return False
            key = key_of(path)
            self.drafts.add(key)
            claimed.add(key)
            return True

        for pattern in layout.files:
            for path in sorted(self.repo.glob(pattern)):
                if path.is_file() and not skip(path) and key_of(path) not in claimed:
                    claimed.add(key_of(path))
                    plans.append(Plan(key=key_of(path), kind="file", title=path.name, source=path))

        # Pages before gradable items: a file matched by both, such as an exam guide
        # sitting under assignments/, stays a page.
        for pattern in layout.pages:
            for path in sorted(self.repo.glob(pattern)):
                if path.is_file() and not skip(path) and key_of(path) not in claimed:
                    claimed.add(key_of(path))
                    plans.append(Plan(key=key_of(path), kind="page", title="", source=path))

        for pattern, kind in layout.gradable:
            canvas_kind = KIND_TO_CANVAS.get(kind)
            if canvas_kind is None:
                continue
            for path in sorted(self.repo.glob(pattern)):
                key = key_of(path)
                if not path.is_file() or skip(path) or key in claimed:
                    continue
                claimed.add(key)
                item = self.dates.get(key)
                plans.append(
                    Plan(
                        key=key,
                        kind=canvas_kind,
                        title="",
                        source=path,
                        points=item.points if item else None,
                        dates=item,
                        item_kind=kind,
                    )
                )

        syllabus = self.repo / layout.syllabus
        plans.append(
            Plan(key=layout.syllabus, kind="syllabus", title="Syllabus", source=syllabus)
        )
        return plans

    # -- helpers --------------------------------------------------------

    def _visibility(self, exists: bool) -> bool | None:
        """What to say about visibility, or None to say nothing at all.

        On create there is no prior state, so the flag decides it. On update,
        --publish still publishes, but its absence must leave the object alone:
        pushing a correction to a live assignment should not pull it out from
        under the class currently reading it.
        """
        return self.publish if (not exists or self.publish) else None

    def _date_fields(self, prefix: str, item: ItemDates | None) -> dict[str, str]:
        if item is None:
            return {}
        # A course that wants no "Available from" date omits unlock from its policy.
        # That has to be sent as an empty value rather than left out: omitting the
        # field on an update makes Canvas keep whatever date is already there.
        return {
            f"{prefix}[due_at]": item.due_at.isoformat(),
            f"{prefix}[unlock_at]": item.unlock_at.isoformat() if item.unlock_at else "",
            f"{prefix}[lock_at]": item.lock_at.isoformat(),
        }

    def _client(self) -> CanvasLMS:
        if self.canvas is None:
            raise PublishError("no Canvas client configured")
        return self.canvas

    def is_draft_key(self, key: str) -> bool:
        """Whether a repo path is a draft.

        Reads the file rather than trusting ``self.drafts`` so that it is right
        even when nothing has called ``plan()`` yet.
        """
        if key in self.drafts:
            return True
        path = self.repo / key
        if path.is_file() and path_is_draft(path):
            self.drafts.add(key)
            return True
        return False

    def prune_drafts(self) -> list[str]:
        """Forget the Canvas objects of files that have since become drafts.

        A file that was pushed and is now a draft leaves an object behind in
        Canvas. Dropping the manifest entry is what makes the draft invisible to
        ``verify``, but it also orphans that object, so the keys are returned for
        the caller to report. Deleting it is left to a human: an assignment may
        already have submissions against it.
        """
        orphaned: list[str] = []
        for key in sorted(self.manifest.entries):
            if self.is_draft_key(key):
                orphaned.append(key)
                self.manifest.drop(key)
        return orphaned

    def _is_live(self, entry: Entry | None) -> bool:
        """True if this object is already published, so students can see it.

        Rewriting something a class is part-way through reading is worse than
        leaving it stale, so a push skips it unless asked to do otherwise. The
        syllabus has no published flag of its own: it is visible whenever the
        course is, so treat it as live in a published course.
        """
        if entry is None or self.update_published:
            return False
        canvas = self._client()
        if entry.kind == "syllabus":
            course = canvas.get_json(f"/api/v1/courses/{self.course_id}")
            return str(course.get("workflow_state", "")) == "available"
        if entry.kind == "file":
            return False
        stored = canvas.get_json(f"/api/v1{canvas_path(entry, self.course_id)}")
        return bool(stored.get("published"))

    # -- assignment groups ----------------------------------------------

    def sync_groups(self) -> Result:
        """Create or update the course's assignment groups from [[group]].

        Memoised, because the CLI calls it up front so the counts are reported
        and a single-item push reaches it lazily through _group_fields.
        """
        result = Result()
        if self._groups_synced or not self.config.groups:
            return result
        self._groups_synced = True

        if self.dry_run:
            for group in self.config.groups:
                weight = f" ({group.weight:g}%)" if group.weight is not None else ""
                kinds = f" <- {', '.join(group.kinds)}" if group.kinds else ""
                self.report(f"[dim]group {group.name}{weight}{kinds}[/dim]")
                result.skipped += 1
            return result

        canvas = self._client()
        existing = {
            str(stored.get("name", "")): stored
            for stored in canvas.list_assignment_groups(self.course_id)
        }
        for position, group in enumerate(self.config.groups, start=1):
            fields = {"name": group.name, "position": str(position)}
            if group.weight is not None:
                fields["group_weight"] = f"{group.weight:g}"
            stored = existing.get(group.name)
            if stored is None:
                created = canvas.create_assignment_group(self.course_id, fields)
                self.groups[group.name] = str(created["id"])
                result.created += 1
                continue
            self.groups[group.name] = str(stored.get("id", ""))
            if _group_differs(stored, group, position):
                canvas.update_assignment_group(self.course_id, self.groups[group.name], fields)
                result.updated += 1
            else:
                result.skipped += 1

        # Weights are inert until the course itself is set to weight by group.
        if any(group.weight is not None for group in self.config.groups):
            canvas.set_group_weighting(self.course_id, True)
        return result

    def _group_fields(self, prefix: str, item: Plan) -> dict[str, str]:
        """The assignment group field for this item, or nothing if none applies."""
        group = self.config.group_for(item.item_kind) if item.item_kind else None
        if group is None:
            return {}
        self.sync_groups()
        group_id = self.groups.get(group.name)
        return {f"{prefix}[assignment_group_id]": group_id} if group_id else {}

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

        if self._is_live(existing):
            self.protected.add(item.key)
            result.skipped = 1
            return result

        if item.kind == "syllabus":
            canvas.update_syllabus(self.course_id, html)
            self.manifest.put(item.key, Entry(kind="syllabus", canvas_id=self.course_id, title=title))
            result.updated = 1
        elif item.kind == "page":
            if existing and canvas.exists(f"/api/v1/courses/{self.course_id}/pages/{existing.page_url}"):
                canvas.update_page(
                    self.course_id, existing.page_url, title, html, self._visibility(True)
                )
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
                **self._group_fields("assignment", item),
                **self._date_fields("assignment", item.dates),
            }
            if existing and canvas.exists(
                f"/api/v1/courses/{self.course_id}/assignments/{existing.canvas_id}"
            ):
                visible = self._visibility(True)
                if visible is not None:
                    fields["assignment[published]"] = str(visible).lower()
                canvas.update_assignment(self.course_id, existing.canvas_id, fields)
                canvas_id, result.updated = existing.canvas_id, 1
            else:
                fields["assignment[published]"] = str(self.publish).lower()
                created = canvas.create_assignment(self.course_id, fields)
                canvas_id, result.created = str(created["id"]), 1
            self.manifest.put(item.key, Entry(kind="assignment", canvas_id=canvas_id, title=title))
        elif item.kind == "discussion":
            fields = {
                "title": title,
                "message": html,
                "assignment[points_possible]": f"{item.points or 0:g}",
                **self._group_fields("assignment", item),
                **self._date_fields("assignment", item.dates),
            }
            if existing and canvas.exists(
                f"/api/v1/courses/{self.course_id}/discussion_topics/{existing.canvas_id}"
            ):
                visible = self._visibility(True)
                if visible is not None:
                    fields["published"] = str(visible).lower()
                stored = canvas.update_discussion(self.course_id, existing.canvas_id, fields)
                canvas_id, result.updated = existing.canvas_id, 1
            else:
                fields["published"] = str(self.publish).lower()
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
                # Always written unpublished, then published again below once the
                # questions exist. Canvas freezes a quiz's question set when it is
                # published, so questions added to an already-published quiz are
                # never counted: the quiz reads 0 questions and 0 points to
                # students until someone unpublishes and republishes it by hand.
                "quiz[published]": "false",
                "quiz[allowed_attempts]": "1",
                "quiz[scoring_policy]": "keep_highest",
                **self._group_fields("quiz", item),
                **self._date_fields("quiz", item.dates),
            }
            was_live = False
            if existing and canvas.exists(f"/api/v1/courses/{self.course_id}/quizzes/{existing.canvas_id}"):
                stored_quiz = canvas.get_json(
                    f"/api/v1/courses/{self.course_id}/quizzes/{existing.canvas_id}"
                )
                was_live = bool(stored_quiz.get("published"))
                canvas.update_quiz(self.course_id, existing.canvas_id, fields)
                canvas_id, result.updated = existing.canvas_id, 1
            else:
                created = canvas.create_quiz(self.course_id, fields)
                canvas_id, result.created = str(created["id"]), 1
            self.manifest.put(item.key, Entry(kind="quiz", canvas_id=canvas_id, title=title))
            self._push_questions(item, canvas_id)
            # was_live: the write above forced published=false to let the question
            # set be rebuilt, so a quiz that arrived published has to go back.
            if self.publish or was_live:
                canvas.update_quiz(self.course_id, canvas_id, {"quiz[published]": "true"})
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
        if item.source is None or item.kind == "file" or item.key in self.protected:
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
        stored_modules = canvas.list_modules(self.course_id)
        existing = {str(m.get("name")): str(m.get("id")) for m in stored_modules}
        live = {
            str(m.get("name")) for m in stored_modules if m.get("published")
        } if not self.update_published else set()

        for position, module in enumerate(modules, start=1):
            if not isinstance(module, dict):
                continue
            name = str(module.get("title", f"Module {position}"))
            if name in live:
                result.skipped += 1
                continue
            module_id = existing.get(name)
            if module_id is None:
                created = canvas.create_module(self.course_id, name, position, self.publish)
                module_id = str(created["id"])
                result.created += 1
            else:
                canvas.update_module(self.course_id, module_id, {"module[position]": str(position)})
                result.updated += 1

            for current in canvas.list_module_items(self.course_id, module_id):
                canvas.delete_module_item(self.course_id, module_id, str(current["id"]))

            keys = [str(module.get("page", ""))] + [str(k) for k in module.get("items", [])]
            listed = [k for k in keys if k and not self.is_draft_key(k)]
            for index, key in enumerate(listed, start=1):
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

            if self.publish:
                canvas.update_module(self.course_id, module_id, {"module[published]": "true"})
        return result

    # -- rubrics --------------------------------------------------------

    def push_rubrics(self, keys: set[str] | None = None) -> Result:
        """Create a Canvas rubric per lab and discussion, bound to its assignment.

        `keys` limits the sweep to particular repo files, so a scoped push carries
        the corrected rubric without touching every other assignment's.
        """
        result = Result()
        if self.dry_run:
            return result
        canvas = self._client()
        for key, entry in sorted(self.manifest.entries.items()):
            if entry.kind not in ("assignment", "discussion") or key in self.protected:
                continue
            if keys is not None and key not in keys:
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
