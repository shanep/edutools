"""Tests for the Canvas publishing pipeline. No Canvas token required."""

from pathlib import Path

import pytest
from unittest.mock import MagicMock

from edutools.publish import (
    CANVAS_CSS_PROPERTIES,
    Entry,
    Manifest,
    PublishError,
    assert_no_forbidden_tags,
    canvas_path,
    classify_callouts,
    decorate,
    inline_css,
    internal_links,
    mark_table_rows,
    parse_quiz,
    parse_rubric,
    question_fields,
    render_inline,
    render_markdown,
    rewrite_links,
    rubric_fields,
    strip_instructor_sections,
    strip_title,
    strip_vitepress,
    structure_counts,
    style_declarations,
    visible_text,
    wrap_tables,
)

CS331 = Path.home() / "repos" / "CS331"
needs_cs331 = pytest.mark.skipif(not CS331.exists(), reason="CS331 repository not present")


class TestCanvasAllowlist:
    def test_size(self):
        """122 = the base list plus every prefix expansion, including the nested
        border-{side}-{property} one that is easy to miss when reading the Ruby."""
        assert len(CANVAS_CSS_PROPERTIES) == 122

    @pytest.mark.parametrize(
        "prop", ["background-color", "border-left", "padding-top", "font-family",
                 "font-size", "border-radius", "grid-template-columns", "margin-top",
                 "border-left-color", "border-top-width"],
    )
    def test_allowed(self, prop: str):
        assert prop in CANVAS_CSS_PROPERTIES

    @pytest.mark.parametrize(
        "prop", ["box-shadow", "text-shadow", "opacity", "transition",
                 "transform", "letter-spacing", "text-transform", "font-weight"],
    )
    def test_blocked(self, prop: str):
        """These are the ones Canvas silently strips, so the inliner must catch them."""
        assert prop not in CANVAS_CSS_PROPERTIES


class TestRendering:
    def test_strip_title(self):
        title, body = strip_title("# Lab 4\n\nSome prose.\n")
        assert title == "Lab 4"
        assert "# Lab 4" not in body

    def test_instructor_sections_are_removed(self):
        source = (
            "# Quiz\n\nBody.\n\n"
            "## Canvas import notes\n\n"
            "*Instructor note, not shown to students.* Items 2 and 7 are multiple-answer.\n"
        )
        cleaned = strip_instructor_sections(source)
        assert "Instructor note" not in cleaned
        assert "Body." in cleaned

    def test_forbidden_tags_detected(self):
        assert assert_no_forbidden_tags("<p>ok</p>") == []
        assert "style" in assert_no_forbidden_tags("<style>p{color:red}</style>")


class TestDecorate:
    def test_sections_get_classes(self):
        html = "<h2>Rubric</h2><p>x</p><h2>AI disclosure</h2><p>y</p>"
        out = decorate(html)
        assert 'class="cs-rubric"' in out
        assert 'class="cs-ai"' in out

    def test_unknown_heading_gets_a_neutral_class(self):
        assert 'class="cs-section"' in decorate("<h2>Using ATT&amp;CK</h2><p>x</p>")

    def test_no_headings_is_left_alone(self):
        assert decorate("<p>x</p>") == "<p>x</p>"

    def test_meta_line_is_tagged(self):
        out = decorate("<p><strong>Week 7 · 38 points</strong></p>")
        assert 'class="cs-meta"' in out

    def test_alternate_rows_are_marked(self):
        html = "<table><tr><th>a</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></table>"
        out = mark_table_rows(html)
        assert "cs-row-odd" in out and "cs-row-even" in out

    def test_tables_get_a_scroll_wrapper(self):
        out = wrap_tables("<table><tr><td>1</td></tr></table>")
        assert out.startswith('<div class="cs-scroll">') and out.endswith("</div>")


class TestInlineCss:
    def test_class_rules_become_style_attributes(self):
        html, dropped = inline_css('<p class="cs-meta">x</p>', ".cs-meta{color:#001F60}")
        assert "style=" in html and "color" in html
        assert dropped == []

    def test_blocked_properties_are_reported_not_silently_lost(self):
        html, dropped = inline_css('<p class="a">x</p>', ".a{color:red;box-shadow:0 0 4px #000}")
        assert dropped == ["box-shadow"]
        assert "box-shadow" not in html
        assert "color" in html

    def test_style_tag_does_not_survive(self):
        html, _ = inline_css("<p>x</p>", "p{color:red}")
        assert "<style" not in html


class TestQuizParsing:
    QUIZ = """# Quiz

**Q1.** A single-answer question. *(Objective 1.1)*

- A. wrong
- B. right
- C. wrong
- D. wrong

*Answer:* **B** — because of reasons. (CyBOK §1.1)

---

**Q2.** Select **all** that apply.

- A. yes
- B. no
- C. yes
- D. no

*Answer:* **A and C** — two are correct.

---

**Q3.** True or false: something.

- A. True
- B. False

*Answer:* **B** — false, because.
"""

    def _write(self, tmp_path: Path, text: str) -> Path:
        path = tmp_path / "quiz-99-test.md"
        path.write_text(text)
        return path

    def test_types_come_from_the_stem(self, tmp_path: Path):
        questions = parse_quiz(self._write(tmp_path, self.QUIZ))
        assert [q.kind for q in questions] == [
            "multiple_choice_question", "multiple_answers_question", "true_false_question",
        ]

    def test_correct_answers(self, tmp_path: Path):
        questions = parse_quiz(self._write(tmp_path, self.QUIZ))
        assert questions[0].correct_letters == ["B"]
        assert questions[1].correct_letters == ["A", "C"]

    def test_objective_is_extracted_from_the_stem(self, tmp_path: Path):
        questions = parse_quiz(self._write(tmp_path, self.QUIZ))
        assert questions[0].objective == "1.1"
        assert "Objective" not in questions[0].stem

    def test_rationale_is_captured(self, tmp_path: Path):
        questions = parse_quiz(self._write(tmp_path, self.QUIZ))
        assert questions[0].rationale.startswith("because of reasons")

    def test_a_select_all_with_one_correct_answer_stays_multiple_answers(self, tmp_path: Path):
        """quiz-01 Q2 is exactly this shape; reading the type off the answer would misclassify it."""
        text = "**Q1.** Select **all** that apply.\n\n- A. yes\n- B. no\n\n*Answer:* **A only** — just one.\n"
        questions = parse_quiz(self._write(tmp_path, text))
        assert questions[0].kind == "multiple_answers_question"
        assert questions[0].correct_letters == ["A"]

    def test_disagreement_with_the_instructor_note_is_fatal(self, tmp_path: Path):
        text = self.QUIZ + "\n\n## Canvas import notes\n\nItems 1 are multiple-answer; the rest are not.\n"
        with pytest.raises(PublishError, match="instructor note"):
            parse_quiz(self._write(tmp_path, text))

    def test_question_fields_key_the_right_answers(self, tmp_path: Path):
        question = parse_quiz(self._write(tmp_path, self.QUIZ))[1]
        fields = dict(enumerate(question_fields(question, 1)))
        weights = [v for k, v in fields.values() if k.endswith("[answer_weight]")]
        assert weights == ["100", "0", "100", "0"]


class TestRubricParsing:
    def test_criteria_and_points(self):
        markdown = (
            "## Rubric\n\n"
            "| Row | What is assessed | Points |\n| --- | --- | ---: |\n"
            "| 1 | First thing | 6 |\n| 2 | Second thing | 12 |\n"
            "| | **Total** | **18** |\n"
        )
        criteria = parse_rubric(markdown)
        assert [c.points for c in criteria] == [6.0, 12.0]
        assert criteria[0].description == "First thing"

    def test_no_rubric_section(self):
        assert parse_rubric("## Goal\n\nNothing here.\n") == []

    def test_rubric_fields_total_matches(self):
        criteria = parse_rubric(
            "## Rubric\n\n| Row | What | Points |\n| --- | --- | ---: |\n| 1 | a | 20 |\n| 2 | b | 18 |\n"
        )
        fields = dict(rubric_fields("Lab 1 rubric", criteria, "123"))
        assert fields["rubric[points_possible]"] == "38"
        assert fields["rubric_association[association_id]"] == "123"


class TestManifestAndLinks:
    def test_round_trip(self, tmp_path: Path):
        manifest = Manifest(tmp_path / ".canvas" / "m.json")
        manifest.put("modules/week-01.md", Entry(kind="page", canvas_id="w1", page_url="w1", title="Week 1"))
        reloaded = Manifest(tmp_path / ".canvas" / "m.json")
        entry = reloaded.get("modules/week-01.md")
        assert entry is not None
        assert entry.page_url == "w1"

    def test_canvas_paths(self):
        assert canvas_path(Entry("page", "x", page_url="week-01"), "42") == "/courses/42/pages/week-01"
        assert canvas_path(Entry("assignment", "7"), "42") == "/courses/42/assignments/7"
        assert canvas_path(Entry("file", "9"), "42") == "/courses/42/files/9"

    def test_relative_links_are_rewritten(self, tmp_path: Path):
        repo = tmp_path
        (repo / "modules").mkdir()
        (repo / "assignments").mkdir()
        source = repo / "modules" / "week-01.md"
        source.write_text("x")
        (repo / "assignments" / "lab-00.md").write_text("y")

        manifest = Manifest(repo / ".canvas" / "m.json")
        manifest.put("assignments/lab-00.md", Entry(kind="assignment", canvas_id="55", title="Lab 0"))

        html = '<a href="../assignments/lab-00.md">Lab 0</a>'
        out, unresolved = rewrite_links(html, source, repo, manifest, "42")
        assert 'href="/courses/42/assignments/55"' in out
        assert unresolved == []

    def test_unknown_target_is_reported(self, tmp_path: Path):
        (tmp_path / "modules").mkdir()
        source = tmp_path / "modules" / "week-01.md"
        source.write_text("x")
        manifest = Manifest(tmp_path / ".canvas" / "m.json")
        _, unresolved = rewrite_links('<a href="../nope.md">x</a>', source, tmp_path, manifest, "42")
        assert unresolved == ["../nope.md"]

    def test_absolute_and_anchor_links_are_left_alone(self, tmp_path: Path):
        (tmp_path / "modules").mkdir()
        source = tmp_path / "modules" / "w.md"
        source.write_text("x")
        manifest = Manifest(tmp_path / ".canvas" / "m.json")
        html = '<a href="https://example.com">a</a><a href="#frag">b</a>'
        out, unresolved = rewrite_links(html, source, tmp_path, manifest, "42")
        assert out == html and unresolved == []


class TestComparisonHelpers:
    def test_visible_text_ignores_markup(self):
        assert visible_text("<p>Hello   <strong>world</strong></p>") == "Hello world"

    def test_structure_counts(self):
        counts = structure_counts("<h2>a</h2><table><tr><td>1</td></tr></table>")
        assert counts["h2"] == 1 and counts["table"] == 1 and counts["td"] == 1

    def test_style_declarations_are_normalised(self):
        assert style_declarations('<p style="color: RED; padding: 2px">x</p>') == [
            "color:red", "padding:2px",
        ]

    def test_internal_links(self):
        html = '<a href="/courses/42/pages/w1">a</a><a href="https://x.test">b</a>'
        assert internal_links(html, "42") == ["/courses/42/pages/w1"]


@needs_cs331
class TestAgainstCS331:
    def test_all_quizzes_parse(self):
        total = 0
        for path in sorted((CS331 / "quizzes").glob("*.md")):
            questions = parse_quiz(path)
            assert questions, path.name
            total += len(questions)
        assert total == 85

    def test_every_question_has_a_correct_answer_and_a_rationale(self):
        for path in sorted((CS331 / "quizzes").glob("*.md")):
            for question in parse_quiz(path):
                assert question.correct_letters, f"{path.name} Q{question.number}"
                assert question.rationale, f"{path.name} Q{question.number}"

    def test_multiple_choice_questions_have_exactly_one_answer(self):
        for path in sorted((CS331 / "quizzes").glob("*.md")):
            for question in parse_quiz(path):
                if question.kind == "multiple_choice_question":
                    assert len(question.correct_letters) == 1, f"{path.name} Q{question.number}"

    def test_every_lab_and_discussion_rubric_sums_to_its_points(self):
        import re

        for folder, pattern in (("assignments", "lab-*.md"), ("discussions", "*.md")):
            for path in sorted((CS331 / folder).glob(pattern)):
                text = path.read_text()
                criteria = parse_rubric(text)
                assert criteria, path.name
                header = re.search(r"·\s*([\d.]+)\s+points", text)
                assert header, path.name
                assert sum(c.points for c in criteria) == float(header.group(1)), path.name

    def test_the_stylesheet_is_entirely_canvas_compatible(self):
        """The check most likely to fail while authoring canvas.css."""
        css = (CS331 / "canvas.css").read_text()
        for name in ("modules/week-07-symmetric-cryptography.md",
                     "assignments/lab-04-symmetric-encryption.md",
                     "discussions/d03-authentication-policy-critique.md"):
            _, html = render_markdown(CS331 / name)
            html = wrap_tables(mark_table_rows(decorate(html)))
            styled, dropped = inline_css(html, css)
            assert dropped == [], f"{name}: Canvas would strip {dropped}"
            assert assert_no_forbidden_tags(styled) == []

    def test_no_published_page_leaks_the_instructor_note(self):
        for path in sorted((CS331 / "quizzes").glob("*.md")):
            _, html = render_markdown(path)
            assert "Instructor note" not in html, path.name


class TestStripVitepress:
    """The same file is a VitePress page and a Canvas object, so the VitePress-only
    syntax has to be resolved rather than passed through to pandoc as literal text."""

    def _write(self, tmp_path: Path, name: str, text: str) -> Path:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_frontmatter_is_removed(self, tmp_path: Path):
        source = self._write(tmp_path, "a.md", "---\nnext: false\nprev: false\n---\n\n# Title\n")
        assert strip_vitepress(source.read_text(), source, tmp_path).strip() == "# Title"

    def test_a_horizontal_rule_is_not_mistaken_for_frontmatter(self, tmp_path: Path):
        source = self._write(tmp_path, "a.md", "# Title\n\n---\n\nBody\n")
        assert "Body" in strip_vitepress(source.read_text(), source, tmp_path)
        assert "---" in strip_vitepress(source.read_text(), source, tmp_path)

    def test_include_is_inlined(self, tmp_path: Path):
        self._write(tmp_path, "parts/boiler.md", "## Boilerplate\n\nShared text.\n")
        source = self._write(tmp_path, "a.md", "# Title\n\n<!--@include: parts/boiler.md-->\n")
        out = strip_vitepress(source.read_text(), source, tmp_path)
        assert "## Boilerplate" in out
        assert "@include" not in out

    def test_include_resolves_relative_to_the_including_file(self, tmp_path: Path):
        self._write(tmp_path, "parts/boiler.md", "Shared.\n")
        source = self._write(tmp_path, "deep/a.md", "<!--@include: ../parts/boiler.md-->\n")
        assert "Shared." in strip_vitepress(source.read_text(), source, tmp_path)

    def test_a_missing_include_is_an_error(self, tmp_path: Path):
        source = self._write(tmp_path, "a.md", "<!--@include: nope.md-->\n")
        with pytest.raises(PublishError, match="does not exist"):
            strip_vitepress(source.read_text(), source, tmp_path)

    def test_an_include_cycle_is_an_error(self, tmp_path: Path):
        self._write(tmp_path, "b.md", "<!--@include: a.md-->\n")
        source = self._write(tmp_path, "a.md", "<!--@include: b.md-->\n")
        with pytest.raises(PublishError, match="nested more than"):
            strip_vitepress(source.read_text(), source, tmp_path)

    def test_a_container_becomes_a_quoted_callout(self, tmp_path: Path):
        source = self._write(
            tmp_path, "a.md", "::: danger\n\nDo not do this.\n\nEver.\n\n:::\n"
        )
        out = strip_vitepress(source.read_text(), source, tmp_path)
        assert ":::" not in out
        # Every body line stays inside the blockquote, blank lines included, or the
        # quote would end at the first of them and the warning would escape it.
        assert "**Warning**" in out
        assert "<!--cs-callout:danger-->" in out
        assert "> Do not do this." in out
        assert "> Ever." in out

    def test_a_container_title_overrides_the_default(self, tmp_path: Path):
        source = self._write(tmp_path, "a.md", "::: tip Read this first\n\nBody.\n\n:::\n")
        out = strip_vitepress(source.read_text(), source, tmp_path)
        assert "**Read this first**" in out
        assert "<!--cs-callout:tip-->" in out

    def test_vue_components_are_dropped(self, tmp_path: Path):
        source = self._write(
            tmp_path,
            "a.md",
            '<script setup>\nimport x from "./x.json"\n</script>\n\n'
            "# Title\n\n<OfficeHoursLink />\n\n<CourseSchedule :weeks=\"x.weeks\" />\n",
        )
        out = strip_vitepress(source.read_text(), source, tmp_path)
        assert "OfficeHoursLink" not in out
        assert "CourseSchedule" not in out
        assert "import x" not in out
        assert "# Title" in out

    def test_ordinary_html_is_left_alone(self, tmp_path: Path):
        """Only capitalised tags are Vue components; real HTML has to survive."""
        source = self._write(tmp_path, "a.md", "<img src='x.png' alt='x'>\n\n<br>\n")
        out = strip_vitepress(source.read_text(), source, tmp_path)
        assert "<img" in out
        assert "<br>" in out


class TestQuestionRendering:
    """Question text reaches Canvas as HTML; unrendered markdown is what a student
    would otherwise read, including the '**all**' that marks a multi-answer item."""

    QUIZ = (
        "# Q\n\n**Week 1 · 20 points · x**\n\n---\n\n"
        "**Q1.** Select **all** that apply to `La/R`. *(Objective 1.2)*\n\n"
        "- A. Uses `L/R` arithmetic\n- B. Plain option\n\n"
        "*Answer:* **A** -- Because `L/R` is the formula.\n"
    )

    def _question(self, tmp_path: Path):
        path = tmp_path / "quiz-01.md"
        path.write_text(self.QUIZ, encoding="utf-8")
        return parse_quiz(path)[0]

    def test_render_inline_is_empty_for_empty_input(self):
        assert render_inline("   ") == ""

    def test_render_inline_renders_emphasis_and_code(self):
        out = render_inline("Select **all** for `x`")
        assert "<strong>all</strong>" in out
        assert "<code>x</code>" in out

    def test_the_stem_is_rendered(self, tmp_path: Path):
        fields = dict(question_fields(self._question(tmp_path), 1))
        assert "<strong>all</strong>" in fields["question[question_text]"]
        assert "**" not in fields["question[question_text]"]

    def test_the_rationale_goes_to_the_html_field_rendered(self, tmp_path: Path):
        fields = dict(question_fields(self._question(tmp_path), 1))
        assert "<code>L/R</code>" in fields["question[neutral_comments_html]"]

    def test_an_answer_with_markdown_is_sent_as_html(self, tmp_path: Path):
        pairs = question_fields(self._question(tmp_path), 1)
        html = [v for k, v in pairs if k.endswith("[answer_html]")]
        assert len(html) == 1
        assert "<code>L/R</code>" in html[0]

    def test_a_plain_answer_stays_plain_text(self, tmp_path: Path):
        """Canvas empties answer_text whenever answer_html is set, so an answer that
        needs no rendering should keep its plain form."""
        pairs = question_fields(self._question(tmp_path), 1)
        text = [v for k, v in pairs if k.endswith("[answer_text]")]
        assert text == ["Plain option"]


class TestPublishedContentGuard:
    """A push must not rewrite what a class is part-way through reading."""

    def _publisher(self, tmp_path: Path, canvas, **kwargs):
        from edutools.publisher import Publisher

        (tmp_path / "assignments").mkdir(parents=True, exist_ok=True)
        (tmp_path / "index.md").write_text("# S\n", encoding="utf-8")
        (tmp_path / "canvas.toml").write_text(
            "[term]\n"
            'timezone = "America/Boise"\n'
            "first_monday = 2026-08-24\nweeks = 15\n"
            "last_day_of_instruction = 2026-12-11\n"
            "finals_start = 2026-12-14\nfinals_end = 2026-12-18\ntotal_points = 0\n\n"
            '[term.policy.project]\ndue = "tue 23:59"\n\n'
            '[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n'
            '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\n',
            encoding="utf-8",
        )
        return Publisher(tmp_path, "42", canvas, **kwargs)

    def _entry(self):
        return Entry(kind="assignment", canvas_id="7", title="P0")

    def test_a_published_object_is_reported_live(self, tmp_path: Path):
        canvas = MagicMock()
        canvas.get_json.return_value = {"published": True}
        publisher = self._publisher(tmp_path, canvas)
        assert publisher._is_live(self._entry()) is True

    def test_an_unpublished_object_is_not_live(self, tmp_path: Path):
        canvas = MagicMock()
        canvas.get_json.return_value = {"published": False}
        publisher = self._publisher(tmp_path, canvas)
        assert publisher._is_live(self._entry()) is False

    def test_update_published_opts_back_in(self, tmp_path: Path):
        canvas = MagicMock()
        canvas.get_json.return_value = {"published": True}
        publisher = self._publisher(tmp_path, canvas, update_published=True)
        assert publisher._is_live(self._entry()) is False
        canvas.get_json.assert_not_called()

    def test_an_object_that_does_not_exist_yet_is_not_live(self, tmp_path: Path):
        publisher = self._publisher(tmp_path, MagicMock())
        assert publisher._is_live(None) is False

    def test_the_syllabus_is_live_when_the_course_is_available(self, tmp_path: Path):
        canvas = MagicMock()
        canvas.get_json.return_value = {"workflow_state": "available"}
        publisher = self._publisher(tmp_path, canvas)
        assert publisher._is_live(Entry(kind="syllabus", canvas_id="42", title="S")) is True

    def test_the_syllabus_is_not_live_in_an_unpublished_course(self, tmp_path: Path):
        canvas = MagicMock()
        canvas.get_json.return_value = {"workflow_state": "unpublished"}
        publisher = self._publisher(tmp_path, canvas)
        assert publisher._is_live(Entry(kind="syllabus", canvas_id="42", title="S")) is False


class TestUnlockField:
    """An omitted unlock has to be sent empty; leaving the key out makes Canvas
    keep whatever date is already on the object."""

    def _dates(self, unlock):
        import datetime as dt

        from edutools.dates import ItemDates

        tz = dt.timezone.utc
        due = dt.datetime(2026, 9, 1, 23, 59, tzinfo=tz)
        return ItemDates("assignments/p0.md", "P0", "project", 2, 50.0,
                         unlock, due, due + dt.timedelta(days=2))

    def _fields(self, tmp_path: Path, unlock):
        from edutools.publisher import Publisher

        (tmp_path / "canvas.toml").write_text(
            "[term]\n"
            'timezone = "America/Boise"\n'
            "first_monday = 2026-08-24\nweeks = 15\n"
            "last_day_of_instruction = 2026-12-11\n"
            "finals_start = 2026-12-14\nfinals_end = 2026-12-18\n\n"
            '[term.policy.project]\ndue = "tue 23:59"\n',
            encoding="utf-8",
        )
        return Publisher(tmp_path, "42", None)._date_fields("assignment", self._dates(unlock))

    def test_no_unlock_sends_an_empty_string(self, tmp_path: Path):
        assert self._fields(tmp_path, None)["assignment[unlock_at]"] == ""

    def test_an_unlock_is_sent_as_an_iso_timestamp(self, tmp_path: Path):
        import datetime as dt

        when = dt.datetime(2026, 8, 31, tzinfo=dt.timezone.utc)
        assert self._fields(tmp_path, when)["assignment[unlock_at]"].startswith("2026-08-31")


class TestCalloutClasses:
    """Every ::: container renders as a blockquote, so the severity has to survive
    as a class or a "this fails your project" warning looks like an aside."""

    def _html(self, tmp_path: Path, markdown: str) -> str:
        source = tmp_path / "a.md"
        source.write_text(markdown, encoding="utf-8")
        return decorate(render_markdown(source, tmp_path)[1])

    def test_danger_and_tip_get_different_classes(self, tmp_path: Path):
        html = self._html(
            tmp_path,
            "# T\n\n::: danger\n\nLoud.\n\n:::\n\n::: tip\n\nQuiet.\n\n:::\n",
        )
        assert 'class="cs-callout cs-danger"' in html
        assert 'class="cs-callout cs-tip"' in html

    def test_the_marker_is_removed(self, tmp_path: Path):
        html = self._html(tmp_path, "# T\n\n::: warning\n\nBody.\n\n:::\n")
        assert "cs-callout:" not in html
        assert "&lt;!--" not in html

    def test_the_body_survives_the_rewrite(self, tmp_path: Path):
        html = self._html(tmp_path, "# T\n\n::: danger\n\nDo not.\n\nEver.\n\n:::\n")
        assert "Do not." in html
        assert "Ever." in html

    def test_the_title_renders_as_bold_not_literal_markdown(self, tmp_path: Path):
        """The marker has to trail the title. A comment leading a line opens a
        CommonMark HTML block, which emits the rest of the line as literal text,
        so the reader sees '**Warning**' with the asterisks."""
        html = self._html(tmp_path, "# T\n\n::: danger\n\nBody.\n\n:::\n")
        assert "<strong>Warning</strong>" in html
        assert "**" not in html

    def test_a_plain_blockquote_is_left_alone(self):
        html = "<blockquote><p>Just a quote.</p></blockquote>"
        assert classify_callouts(html) == html
