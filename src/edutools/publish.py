"""Turn a course repository into Canvas objects.

Markdown is rendered with pandoc, decorated with stable CSS hooks, styled by
inlining a single stylesheet (Canvas strips <style> tags but permits style
attributes), and cross-linked using a manifest of what has already been created.

Everything here is a pure function except `Manifest`, so the whole pipeline can
be exercised without a Canvas token.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass, field

from pathlib import Path
from typing import Final, Literal

# ---------------------------------------------------------------------------
# Canvas's HTML sanitizer allowlist.
#
# Transcribed from canvas-lms, gems/canvas_sanitize/lib/canvas_sanitize/
# canvas_sanitize.rb. Anything outside this set is stripped from a page body
# silently, so we filter locally and report instead of letting it vanish.
# ---------------------------------------------------------------------------

_CSS_BASE: Final[frozenset[str]] = frozenset("""
align-content align-items align-self background border border-radius clear clip color
column-gap cursor direction display flex flex-basis flex-direction flex-flow flex-grow
flex-shrink flex-wrap float font gap grid height justify-content justify-items justify-self
left line-height list-style margin max-height max-width min-height min-width order overflow
overflow-x overflow-y padding place-content place-items place-self position right row-gap
text-align table-layout text-decoration text-indent top user-select vertical-align
visibility white-space width z-index zoom
""".split())

_CSS_EXPANSIONS: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    ("grid-{}", ("area", "auto-columns", "auto-flow", "auto-rows", "column", "gap", "row", "template")),
    ("grid-template-{}", ("areas", "columns", "rows")),
    ("grid-column-{}", ("end", "gap", "start")),
    ("grid-row-{}", ("end", "gap", "start")),
    ("background-{}", ("attachment", "color", "image", "position", "repeat")),
    ("background-position-{}", ("x", "y")),
    ("border-{}", ("bottom", "collapse", "color", "left", "right", "spacing", "style", "top", "width")),
    ("font-{}", ("family", "size", "stretch", "style", "variant", "width")),
    ("list-style-{}", ("image", "position", "type")),
    ("margin-{}", ("bottom", "left", "right", "top", "offset")),
    ("padding-{}", ("bottom", "left", "right", "top")),
)

def _build_allowlist() -> frozenset[str]:
    allowed = set(_CSS_BASE)
    for pattern, parts in _CSS_EXPANSIONS:
        allowed.update(pattern.format(part) for part in parts)
    for side in ("bottom", "left", "right", "top"):
        for prop in ("color", "style", "width"):
            allowed.add(f"border-{side}-{prop}")
    return frozenset(allowed)


CANVAS_CSS_PROPERTIES: Final[frozenset[str]] = _build_allowlist()

# Canvas keeps class/id/style on every element but drops these entirely.
CANVAS_FORBIDDEN_TAGS: Final[frozenset[str]] = frozenset({"style", "link", "script"})

INSTRUCTOR_MARKER: Final[str] = "Instructor note, not shown to students"

# ## heading text -> the class decorate() attaches to that section.
SECTION_CLASSES: Final[dict[str, str]] = {
    "overview": "cs-overview",
    "objectives this week": "cs-objectives",
    "objectives assessed": "cs-objectives",
    "read": "cs-read",
    "worked example": "cs-worked",
    "do this week": "cs-dothis",
    "key terms": "cs-terms",
    "time estimate": "cs-time",
    "looking ahead": "cs-ahead",
    "goal": "cs-goal",
    "before you start": "cs-before",
    "steps": "cs-steps",
    "what to submit": "cs-submit",
    "rubric": "cs-rubric",
    "ai disclosure": "cs-ai",
    "initial post": "cs-steps",
    "post": "cs-steps",
    "replies": "cs-steps",
    "reply": "cs-steps",
    "ground rules": "cs-ai",
    "the case": "cs-worked",
}


class PublishError(RuntimeError):
    """Raised when a repository cannot be turned into Canvas content."""


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def require_pandoc() -> None:
    if shutil.which("pandoc") is None:
        raise PublishError(
            "pandoc is not on PATH. Install it with 'brew install pandoc' "
            "or 'apt-get install pandoc'."
        )


def strip_instructor_sections(markdown: str) -> str:
    """Drop any '## ...' section whose body carries the instructor-only marker."""
    blocks = re.split(r"(?m)^(?=## )", markdown)
    return "".join(b for b in blocks if INSTRUCTOR_MARKER not in b)


def strip_title(markdown: str) -> tuple[str, str]:
    """Split the leading '# Title' off; Canvas shows the title separately."""
    lines = markdown.splitlines()
    title = ""
    for index, line in enumerate(lines):
        if line.startswith("# "):
            title = line[2:].strip()
            del lines[index]
            break
    return title, "\n".join(lines).lstrip("\n")


# ---------------------------------------------------------------------------
# VitePress: the same markdown is a website and a Canvas object
# ---------------------------------------------------------------------------

# "---\nnext: false\n---\n" at the very top of the file.
_FRONTMATTER_RE: Final[re.Pattern[str]] = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.S)

# "<!--@include: ../../parts/syllabus-boiler.md-->"
_INCLUDE_RE: Final[re.Pattern[str]] = re.compile(r"^[ \t]*<!--\s*@include:\s*(\S+?)\s*-->[ \t]*$", re.M)

# "::: danger", "::: warning Custom Title", "::: tip", closed by a bare ":::".
_CONTAINER_RE: Final[re.Pattern[str]] = re.compile(
    r"^:::+[ \t]*(?P<kind>[a-z-]+)[ \t]*(?P<title>[^\n]*)\n(?P<body>.*?)^:::+[ \t]*$",
    re.M | re.S,
)

# "<OfficeHoursLink />" or "<CourseSchedule :weeks="x" />": a capitalised tag is a
# Vue component, which means nothing outside the website.
_COMPONENT_RE: Final[re.Pattern[str]] = re.compile(r"<(?P<tag>[A-Z]\w*)\b[^>]*?/?>(?:</(?P=tag)>)?")

# "<script setup> ... </script>" blocks that feed those components.
_SCRIPT_RE: Final[re.Pattern[str]] = re.compile(r"^<script\b[^>]*>.*?</script>[ \t]*$", re.M | re.S)

# The title Canvas should show for each container kind when the author gave none.
_CONTAINER_TITLES: Final[dict[str, str]] = {
    "danger": "Warning",
    "warning": "Caution",
    "info": "Note",
    "tip": "Tip",
    "details": "Details",
}

_MAX_INCLUDE_DEPTH: Final[int] = 5


def strip_vitepress(markdown: str, source: Path, repo: Path | None = None, depth: int = 0) -> str:
    """Resolve the VitePress-only syntax that pandoc would otherwise pass through.

    A course directory is served as a website *and* pushed to Canvas, so the same
    file carries VitePress constructs that mean nothing to pandoc.  Left alone they
    reach Canvas as literal text: a reader sees ``::: danger`` and an unrendered
    ``<!--@include:-->`` comment.  Each one is resolved into plain markdown here.
    """
    markdown = _FRONTMATTER_RE.sub("", markdown)
    markdown = _SCRIPT_RE.sub("", markdown)

    # Includes are resolved relative to the file that names them, and recursively,
    # since a boilerplate part may include another.
    def _include(match: re.Match[str]) -> str:
        if depth >= _MAX_INCLUDE_DEPTH:
            raise PublishError(
                f"{source.name}: @include nested more than {_MAX_INCLUDE_DEPTH} deep"
            )
        target = (source.parent / match.group(1)).resolve()
        if not target.exists():
            raise PublishError(f"{source.name}: @include target {match.group(1)} does not exist")
        return strip_vitepress(target.read_text(encoding="utf-8"), target, repo, depth + 1)

    markdown = _INCLUDE_RE.sub(_include, markdown)

    # A container becomes a blockquote with a bold lead line.  Canvas keeps both, so
    # the callout still reads as a callout without needing any custom CSS, and the
    # body has to be quoted line by line or the quote ends at the first blank line.
    def _container(match: re.Match[str]) -> str:
        kind = match.group("kind")
        title = match.group("title").strip() or _CONTAINER_TITLES.get(kind, kind.title())
        body = match.group("body").strip("\n")
        quoted = "\n".join(f"> {line}".rstrip() for line in body.splitlines())
        return f"> **{title}**\n>\n{quoted}\n"

    # Innermost first, so a container nested inside another is resolved before the
    # outer one quotes it.
    while True:
        markdown, count = _CONTAINER_RE.subn(_container, markdown)
        if not count:
            break

    markdown = _COMPONENT_RE.sub("", markdown)
    return markdown


def render_markdown(path: Path, repo: Path | None = None) -> tuple[str, str]:
    """Render one course file to (title, html)."""
    require_pandoc()
    source = strip_vitepress(path.read_text(encoding="utf-8"), path, repo)
    source = strip_instructor_sections(source)
    title, body = strip_title(source)
    result = subprocess.run(
        ["pandoc", "--from", "gfm", "--to", "html", "--wrap=none"],
        input=body, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise PublishError(f"pandoc failed on {path}: {result.stderr.strip()}")
    return title or path.stem, result.stdout


# ---------------------------------------------------------------------------
# Decoration: give the stylesheet stable hooks
# ---------------------------------------------------------------------------

_H2_RE: Final[re.Pattern[str]] = re.compile(r"<h2\b[^>]*>(?P<text>.*?)</h2>", re.S)
_TAG_RE: Final[re.Pattern[str]] = re.compile(r"<[^>]+>")


def _plain(html: str) -> str:
    return re.sub(r"\s+", " ", _TAG_RE.sub("", html)).strip()


def decorate(html: str) -> str:
    """Wrap each h2 section in a classed <div> and mark the header line.

    Canvas allows class attributes, and inlining resolves them into style
    attributes at publish time, so these hooks work either way.
    """
    # The bold meta line: "**Week 7 · 38 points · ...**" renders as a lone <p><strong>.
    html = re.sub(
        r"\A(\s*)<p><strong>((?:Week|Finals week|January|February|March|April|May)[^<]*)</strong></p>",
        r'\1<p class="cs-meta"><strong>\2</strong></p>',
        html,
        count=1,
    )

    matches = list(_H2_RE.finditer(html))
    if not matches:
        return html

    pieces: list[str] = [html[: matches[0].start()]]
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(html)
        heading = _plain(match.group("text")).lower()
        css_class = SECTION_CLASSES.get(heading, "cs-section")
        pieces.append(f'<div class="{css_class}">{html[match.start():end]}</div>')
    return "".join(pieces)


def mark_table_rows(html: str) -> str:
    """Tag alternate body rows, since Canvas cannot express :nth-child."""
    def per_table(match: re.Match[str]) -> str:
        table = match.group(0)
        count = 0

        def per_row(row: re.Match[str]) -> str:
            nonlocal count
            opening = row.group(0)
            if "<th" in row.group(1):
                return opening
            count += 1
            css = "cs-row-odd" if count % 2 else "cs-row-even"
            return opening.replace("<tr>", f'<tr class="{css}">', 1)

        return re.sub(r"<tr>(.*?)</tr>", per_row, table, flags=re.S)

    return re.sub(r"<table>.*?</table>", per_table, html, flags=re.S)


def wrap_tables(html: str) -> str:
    """Let wide tables scroll rather than pushing the page sideways."""
    return re.sub(
        r"(<table\b)", r'<div class="cs-scroll">\1', html
    ).replace("</table>", "</table></div>")


# ---------------------------------------------------------------------------
# Styling: one authored stylesheet, inlined into style attributes
# ---------------------------------------------------------------------------

_STYLE_ATTR_RE: Final[re.Pattern[str]] = re.compile(r'style="([^"]*)"')
_BODY_RE: Final[re.Pattern[str]] = re.compile(r"<body[^>]*>(.*)</body>", re.S)


def _filter_declarations(style: str) -> tuple[str, list[str]]:
    """Keep only declarations Canvas will store; return what was dropped."""
    kept: list[str] = []
    dropped: list[str] = []
    for declaration in style.split(";"):
        if not declaration.strip():
            continue
        name, _, value = declaration.partition(":")
        prop = name.strip().lower()
        if not value.strip():
            continue
        if prop in CANVAS_CSS_PROPERTIES:
            kept.append(f"{prop}: {value.strip()}")
        else:
            dropped.append(prop)
    return "; ".join(kept), dropped


def inline_css(html: str, css: str) -> tuple[str, list[str]]:
    """Inline `css` into style attributes and drop anything Canvas would strip.

    Canvas removes <style> elements from page bodies but keeps style attributes,
    so this is the only way a stylesheet can survive. Returns the styled HTML
    and a sorted list of CSS properties that had to be discarded.
    """
    import css_inline

    document = f"<style>{css}</style>{html}"
    inlined = css_inline.inline(document, keep_style_tags=False)

    body = _BODY_RE.search(inlined)
    if body:
        inlined = body.group(1)

    dropped: set[str] = set()

    def clean(match: re.Match[str]) -> str:
        kept, lost = _filter_declarations(match.group(1))
        dropped.update(lost)
        return f'style="{kept}"' if kept else ""

    inlined = _STYLE_ATTR_RE.sub(clean, inlined)
    return inlined, sorted(dropped)


def assert_no_forbidden_tags(html: str) -> list[str]:
    """Report tags Canvas would strip outright."""
    found = {
        tag for tag in CANVAS_FORBIDDEN_TAGS
        if re.search(rf"<{tag}\b", html, re.I)
    }
    return sorted(found)


# ---------------------------------------------------------------------------
# Quiz parsing
# ---------------------------------------------------------------------------

QuestionType = Literal["multiple_choice_question", "multiple_answers_question", "true_false_question"]

_QUESTION_RE: Final[re.Pattern[str]] = re.compile(r"^\*\*Q(\d+)\.\*\*\s*(.*)", re.M | re.S)
_OPTION_RE: Final[re.Pattern[str]] = re.compile(r"^- ([A-E])\.\s+(.*)$", re.M)
_ANSWER_RE: Final[re.Pattern[str]] = re.compile(r"^\*Answer:\*\s*\*\*([^*]+)\*\*\s*(?:—|--)?\s*(.*)", re.M | re.S)
_OBJECTIVE_RE: Final[re.Pattern[str]] = re.compile(r"\s*\*\(Objective\s+([\d.]+)\)\*")
_NOTE_RE: Final[re.Pattern[str]] = re.compile(r"Items ([\d,\s and]+) are multiple-answer")


@dataclass(frozen=True)
class Answer:
    text: str
    correct: bool


@dataclass(frozen=True)
class Question:
    number: int
    stem: str
    objective: str | None
    kind: QuestionType
    answers: list[Answer]
    rationale: str

    @property
    def correct_letters(self) -> list[str]:
        letters = "ABCDE"
        return [letters[i] for i, a in enumerate(self.answers) if a.correct]


def parse_quiz(path: Path) -> list[Question]:
    """Parse a quiz bank into Canvas questions.

    The question *type* is taken from the stem, never from the number of correct
    answers: a "Select all that apply" item whose answer happens to be a single
    option is still a multiple-answers question.
    """
    text = path.read_text(encoding="utf-8")
    note = _NOTE_RE.search(text)
    declared_multi = {int(n) for n in re.findall(r"\d+", note.group(1))} if note else set()

    questions: list[Question] = []
    for block in re.split(r"(?m)^---$", text):
        match = _QUESTION_RE.search(block)
        if not match:
            continue
        # A block may carry a preamble (a title, a table) before the question.
        block = block[match.start():].strip()
        match = _QUESTION_RE.match(block)
        if not match:
            continue
        number = int(match.group(1))

        options = _OPTION_RE.findall(block)
        if not options:
            raise PublishError(f"{path.name} Q{number}: no lettered options found")

        answer = _ANSWER_RE.search(block)
        if not answer:
            raise PublishError(f"{path.name} Q{number}: no '*Answer:*' line found")
        correct = set(re.findall(r"\b([A-E])\b", answer.group(1)))
        if not correct:
            raise PublishError(f"{path.name} Q{number}: cannot read answer {answer.group(1)!r}")

        stem_raw = block[: block.index("\n- ")] if "\n- " in block else match.group(2)
        stem_raw = stem_raw.replace(f"**Q{number}.**", "", 1).strip()
        objective_match = _OBJECTIVE_RE.search(stem_raw)
        objective = objective_match.group(1) if objective_match else None
        stem = _OBJECTIVE_RE.sub("", stem_raw).strip()

        letters = [letter for letter, _ in options]
        if letters == ["A", "B"] and [t.strip().lower() for _, t in options] == ["true", "false"]:
            kind: QuestionType = "true_false_question"
        elif re.search(r"Select \*\*all\*\*", stem, re.I):
            kind = "multiple_answers_question"
        else:
            kind = "multiple_choice_question"

        # Cross-check the stem-derived type against the instructor note.
        if declared_multi:
            declared = number in declared_multi
            derived = kind == "multiple_answers_question"
            if declared != derived:
                raise PublishError(
                    f"{path.name} Q{number}: instructor note says "
                    f"{'multiple-answer' if declared else 'single-answer'} but the stem reads "
                    f"{'multiple-answer' if derived else 'single-answer'}"
                )

        questions.append(
            Question(
                number=number,
                stem=stem,
                objective=objective,
                kind=kind,
                answers=[Answer(text.strip(), letter in correct) for letter, text in options],
                rationale=re.sub(r"\s+", " ", answer.group(2)).strip(),
            )
        )

    questions.sort(key=lambda q: q.number)
    return questions


# Emphasis, code spans and links: the markdown a quiz answer can actually carry.
_MARKDOWN_RE: Final[re.Pattern[str]] = re.compile(r"\*\*|`|\[[^\]]*\]\(")


def render_inline(markdown: str) -> str:
    """Render one markdown fragment to HTML.

    Quiz stems and rationales reach Canvas as HTML, so a stem written "Select
    **all** that apply" has to be rendered or the reader sees the asterisks, and
    the emphasis that marks a multiple-answer question is lost.
    """
    if not markdown.strip():
        return ""
    require_pandoc()
    result = subprocess.run(
        ["pandoc", "--from", "gfm", "--to", "html", "--wrap=none"],
        input=markdown, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise PublishError(f"pandoc failed on a quiz fragment: {result.stderr.strip()}")
    return result.stdout.strip()


def question_fields(question: Question, position: int) -> list[tuple[str, str]]:
    """Canvas form fields for one quiz question."""
    name = f"Q{question.number}"
    if question.objective:
        name += f" (Objective {question.objective})"
    fields: list[tuple[str, str]] = [
        ("question[question_name]", name),
        ("question[question_text]", render_inline(question.stem)),
        ("question[question_type]", question.kind),
        ("question[points_possible]", "2"),
        ("question[position]", str(position)),
        ("question[neutral_comments_html]", render_inline(question.rationale)),
    ]
    for answer in question.answers:
        if _MARKDOWN_RE.search(answer.text):
            fields.append(("question[answers][][answer_html]", render_inline(answer.text)))
        else:
            fields.append(("question[answers][][answer_text]", answer.text))
        fields.append(("question[answers][][answer_weight]", "100" if answer.correct else "0"))
    return fields


# ---------------------------------------------------------------------------
# Rubric parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Criterion:
    description: str
    points: float


def parse_rubric(markdown: str) -> list[Criterion]:
    """Read the '## Rubric' table. Rows are '| n | description | points |'."""
    section = re.search(r"(?m)^## Rubric\s*\n(.*?)(?=\n## |\Z)", markdown, re.S)
    if not section:
        return []
    criteria: list[Criterion] = []
    for line in section.group(1).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or not cells[0].isdigit():
            continue
        try:
            points = float(cells[-1].strip("*"))
        except ValueError:
            continue
        criteria.append(Criterion(description=cells[1], points=points))
    return criteria


def rubric_fields(title: str, criteria: list[Criterion], association_id: str) -> list[tuple[str, str]]:
    """Canvas form fields for a rubric bound to an assignment."""
    total = sum(c.points for c in criteria)
    fields: list[tuple[str, str]] = [
        ("rubric[title]", title),
        ("rubric[points_possible]", f"{total:g}"),
        ("rubric[free_form_criterion_comments]", "true"),
        ("rubric_association[association_id]", association_id),
        ("rubric_association[association_type]", "Assignment"),
        ("rubric_association[use_for_grading]", "true"),
        ("rubric_association[purpose]", "grading"),
    ]
    for index, criterion in enumerate(criteria):
        key = f"rubric[criteria][{index}]"
        fields.append((f"{key}[description]", criterion.description[:255]))
        fields.append((f"{key}[points]", f"{criterion.points:g}"))
        fields.append((f"{key}[ratings][0][description]", "Full marks"))
        fields.append((f"{key}[ratings][0][points]", f"{criterion.points:g}"))
        fields.append((f"{key}[ratings][1][description]", "No marks"))
        fields.append((f"{key}[ratings][1][points]", "0"))
    return fields


# ---------------------------------------------------------------------------
# Manifest: what has been created in which course
# ---------------------------------------------------------------------------

ObjectKind = Literal["page", "assignment", "discussion", "quiz", "file", "module", "syllabus"]


@dataclass
class Entry:
    kind: ObjectKind
    canvas_id: str
    page_url: str = ""
    title: str = ""
    extra: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        return {
            "kind": self.kind, "canvas_id": self.canvas_id,
            "page_url": self.page_url, "title": self.title, "extra": self.extra,
        }


class Manifest:
    """Maps repo paths to Canvas objects, checkpointed after every write.

    Committed to the course repository: it holds ids, not secrets, and it is
    what makes a second push an update rather than a duplicate.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.entries: dict[str, Entry] = {}
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            for key, value in raw.get("entries", {}).items():
                self.entries[key] = Entry(
                    kind=value["kind"], canvas_id=str(value["canvas_id"]),
                    page_url=value.get("page_url", ""), title=value.get("title", ""),
                    extra={str(k): str(v) for k, v in value.get("extra", {}).items()},
                )

    @classmethod
    def for_course(cls, repo: Path, course_id: str) -> Manifest:
        return cls(repo / ".canvas" / f"manifest-{course_id}.json")

    def get(self, key: str) -> Entry | None:
        return self.entries.get(key)

    def put(self, key: str, entry: Entry) -> None:
        self.entries[key] = entry
        self.save()

    def drop(self, key: str) -> None:
        self.entries.pop(key, None)
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"entries": {k: v.to_json() for k, v in sorted(self.entries.items())}}
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Link rewriting
# ---------------------------------------------------------------------------

_HREF_RE: Final[re.Pattern[str]] = re.compile(r'(href|src)="([^"]+)"')


def canvas_path(entry: Entry, course_id: str) -> str:
    if entry.kind == "page":
        return f"/courses/{course_id}/pages/{entry.page_url}"
    if entry.kind == "assignment":
        return f"/courses/{course_id}/assignments/{entry.canvas_id}"
    if entry.kind == "discussion":
        return f"/courses/{course_id}/discussion_topics/{entry.canvas_id}"
    if entry.kind == "quiz":
        return f"/courses/{course_id}/quizzes/{entry.canvas_id}"
    if entry.kind == "file":
        return f"/courses/{course_id}/files/{entry.canvas_id}"
    return f"/courses/{course_id}"


def rewrite_links(
    html: str, source: Path, repo: Path, manifest: Manifest, course_id: str
) -> tuple[str, list[str]]:
    """Point every repo-relative link at its Canvas object.

    Returns the rewritten HTML and a list of links that could not be resolved.
    An unresolved link is a bug: the repository's own link check already proves
    every relative target exists on disk.
    """
    unresolved: list[str] = []

    def replace(match: re.Match[str]) -> str:
        attribute, target = match.group(1), match.group(2)
        if target.startswith(("http://", "https://", "mailto:", "#", "/")):
            return match.group(0)
        path_part, _, fragment = target.partition("#")
        if not path_part:
            return match.group(0)
        try:
            key = (source.parent / path_part).resolve().relative_to(repo.resolve()).as_posix()
        except ValueError:
            unresolved.append(target)
            return match.group(0)
        entry = manifest.get(key)
        if entry is None:
            unresolved.append(target)
            return match.group(0)
        url = canvas_path(entry, course_id)
        if fragment and entry.kind == "page":
            url = f"{url}#{fragment}"
        return f'{attribute}="{url}"'

    return _HREF_RE.sub(replace, html), unresolved


# ---------------------------------------------------------------------------
# Comparison, for the verify pass
# ---------------------------------------------------------------------------

_CANVAS_ADDED_ATTRS: Final[tuple[str, ...]] = (
    "data-api-endpoint", "data-api-returntype", "data-course-type",
    "data-published", "data-id", "loading",
)


def visible_text(html: str) -> str:
    """Collapse HTML to its visible text, for comparing what Canvas stored."""
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S | re.I)
    text = _TAG_RE.sub(" ", text)
    for entity, char in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                         ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        text = text.replace(entity, char)
    return re.sub(r"\s+", " ", text).strip()


def structure_counts(html: str) -> dict[str, int]:
    """Count the structural elements that must survive a round trip."""
    return {
        tag: len(re.findall(rf"<{tag}\b", html, re.I))
        for tag in ("h2", "h3", "table", "tr", "td", "th", "li", "pre", "a", "img", "div")
    }


def style_declarations(html: str) -> list[str]:
    """Every CSS declaration present, sorted, for before/after comparison."""
    declarations: list[str] = []
    for style in _STYLE_ATTR_RE.findall(html):
        for declaration in style.split(";"):
            if declaration.strip():
                declarations.append(re.sub(r"\s+", "", declaration).lower())
    return sorted(declarations)


def internal_links(html: str, course_id: str) -> list[str]:
    """Course-relative links, so verify can prove each one resolves."""
    prefix = f"/courses/{course_id}/"
    return sorted({
        target.split("#")[0]
        for _, target in _HREF_RE.findall(html)
        if target.startswith(prefix)
    })
