"""Tests for course due-date generation.

These need no Canvas token: dates.py is pure computation.
"""

import datetime as dt
from pathlib import Path

import pytest

from edutools.dates import (
    DEFAULT_LAYOUT,
    DateConfig,
    DateConfigError,
    Group,
    ItemDates,
    Layout,
    Term,
    classify,
    compute,
    cross_check_syllabus,
    load_config,
    load_groups,
    load_layout,
    parse_header,
    resolve,
    validate,
)

CS331 = Path.home() / "repos" / "CS331"
needs_cs331 = pytest.mark.skipif(
    not (CS331 / "canvas.toml").exists(), reason="CS331 repository not present"
)


def _term(**overrides: object) -> Term:
    defaults: dict[str, object] = {
        "timezone": "America/Denver",
        "first_monday": dt.date(2027, 1, 11),
        "weeks": 15,
        "break_after_week": 9,
        "last_day_of_instruction": dt.date(2027, 4, 30),
        "finals_start": dt.date(2027, 5, 3),
        "finals_end": dt.date(2027, 5, 7),
    }
    defaults.update(overrides)
    return Term(**defaults)  # type: ignore[arg-type]


class TestTermArithmetic:
    def test_week_one_starts_on_first_monday(self):
        assert _term().monday_of(1) == dt.date(2027, 1, 11)

    def test_weeks_before_the_break_are_consecutive(self):
        term = _term()
        assert term.monday_of(9) == dt.date(2027, 3, 8)

    def test_break_week_is_skipped(self):
        """Week 10 must start Mar 22, matching the promise on the week 9 page."""
        assert _term().monday_of(10) == dt.date(2027, 3, 22)

    def test_last_week_lands_on_the_final_instructional_week(self):
        assert _term().monday_of(15) == dt.date(2027, 4, 26)

    def test_break_monday(self):
        assert _term().break_monday() == dt.date(2027, 3, 15)

    def test_week_out_of_range_is_rejected(self):
        with pytest.raises(DateConfigError):
            _term().monday_of(16)

    def test_a_term_with_no_break_does_not_skip(self):
        term = _term(break_after_week=None)
        assert term.monday_of(10) == dt.date(2027, 3, 15)


class TestResolve:
    def test_weekday_offset(self):
        monday = dt.date(2027, 1, 11)
        tz = _term().tz
        assert resolve("mon 00:00", monday, tz).day == 11
        assert resolve("fri 23:59", monday, tz).day == 15
        assert resolve("sun 23:59", monday, tz).day == 17

    def test_bad_spec_is_rejected(self):
        with pytest.raises(DateConfigError):
            resolve("someday 23:59", dt.date(2027, 1, 11), _term().tz)


class TestParseHeader:
    def test_weekly_item(self):
        assert parse_header("**Week 7 · 38 points · about 90 minutes**") == (7, 38.0)

    def test_finals_item_has_no_week(self):
        assert parse_header("**Finals week · 150 points · 90 minutes**") == (None, 150.0)

    def test_zero_point_diagnostic(self):
        assert parse_header("**Week 1 · 0 points · ungraded**") == (1, 0.0)

    def test_missing_header_is_an_error(self):
        with pytest.raises(DateConfigError):
            parse_header("# A page with no header line\n\nSome prose.\n")


class TestClassify:
    @pytest.mark.parametrize(
        "path,expected",
        [
            ("assignments/lab-04-symmetric-encryption.md", "lab"),
            ("assignments/midterm-exam-guide.md", "exam"),
            ("assignments/final-exam-guide.md", "exam"),
            ("quizzes/quiz-03-cryptography.md", "quiz"),
            ("discussions/d05-current-security-failure.md", "discussion"),
            ("modules/week-01-what-is-cyber-security.md", None),
            ("data/sqli_demo.py", None),
            # A course whose projects are p0.md, p1.md rather than lab-*.md.
            ("assignments/p0.md", "project"),
            ("assignments/p12.md", "project"),
            # Neither of these is gradable even though it sits under assignments/.
            ("assignments/index.md", None),
            ("assignments/grading-rubric.md", None),
        ],
    )
    def test_classification(self, path: str, expected: str | None):
        assert classify(Path(path)) == expected

    def test_an_exam_guide_wins_over_the_project_glob(self):
        """Both patterns sit under assignments/; the guide must not become a project."""
        assert classify(Path("assignments/midterm-exam-guide.md")) == "exam"

    def test_a_custom_layout_replaces_the_default_globs(self):
        layout = Layout(gradable=(("assignments/hw*.md", "lab"),))
        assert classify(Path("assignments/hw3.md"), layout) == "lab"
        assert classify(Path("assignments/lab-01.md"), layout) is None


class TestLayout:
    def test_an_absent_section_keeps_the_defaults(self):
        assert load_layout({}) is DEFAULT_LAYOUT

    def test_syllabus_can_be_renamed(self):
        layout = load_layout({"layout": {"syllabus": "index.md"}})
        assert layout.syllabus == "index.md"
        # Everything not named falls back to the default.
        assert layout.pages == DEFAULT_LAYOUT.pages

    def test_globs_are_read_as_lists(self):
        layout = load_layout({"layout": {"pages": ["notes/*.md"], "files": []}})
        assert layout.pages == ("notes/*.md",)
        assert layout.files == ()

    def test_gradable_maps_kind_to_glob(self):
        layout = load_layout({"layout": {"gradable": {"project": "assignments/p*.md"}}})
        assert layout.gradable == (("assignments/p*.md", "project"),)

    def test_gradable_dirs_deduplicates(self):
        layout = Layout(
            gradable=(
                ("assignments/lab-*.md", "lab"),
                ("assignments/p*.md", "project"),
                ("quizzes/quiz-*.md", "quiz"),
            )
        )
        assert layout.gradable_dirs == ("assignments", "quizzes")

    def test_an_unknown_kind_is_an_error(self):
        with pytest.raises(DateConfigError, match="not a known item kind"):
            load_layout({"layout": {"gradable": {"homework": "assignments/hw*.md"}}})

    def test_a_glob_list_of_the_wrong_shape_is_an_error(self):
        with pytest.raises(DateConfigError, match="list of glob strings"):
            load_layout({"layout": {"pages": "notes/*.md"}})


@needs_cs331
class TestCS331Schedule:
    """The generated schedule has to agree with the course as written."""

    @pytest.fixture(scope="class")
    def generated(self):
        config = load_config(CS331)
        return config, compute(CS331, config)

    def test_no_problems(self, generated):
        config, items = generated
        assert validate(items, config.term) == []

    def test_agrees_with_the_syllabus_schedule_table(self, generated):
        config, _ = generated
        assert cross_check_syllabus(CS331 / "syllabus.md", config.term) == []

    def test_points_total_one_thousand(self, generated):
        _, items = generated
        assert sum(item.points for item in items) == 1000

    def test_every_item_has_all_three_dates_in_order(self, generated):
        _, items = generated
        for item in items:
            assert item.unlock_at <= item.due_at <= item.lock_at, item.path

    def test_labs_get_two_days_of_grace(self, generated):
        """Except in week 15, where the last day of instruction clamps it."""
        _, items = generated
        labs = [i for i in items if i.kind == "lab" and i.week not in (15,)]
        assert labs, "expected some labs"
        for lab in labs:
            assert (lab.lock_at - lab.due_at) == dt.timedelta(days=2), lab.path

    def test_quizzes_and_discussions_get_no_grace(self, generated):
        _, items = generated
        for item in items:
            if item.kind in ("quiz", "discussion"):
                assert item.lock_at == item.due_at, item.path

    def test_nothing_from_an_instructional_week_locks_after_the_last_day(self, generated):
        config, items = generated
        cutoff = dt.datetime(2027, 4, 30, 23, 59, tzinfo=config.term.tz)
        for item in items:
            if item.week is not None:
                assert item.lock_at <= cutoff, item.path

    def test_finals_week_items_use_the_finals_window(self, generated):
        _, items = generated
        finals = [i for i in items if i.week is None]
        assert len(finals) == 2, "the final exam and D6"
        for item in finals:
            assert item.unlock_at.date() == dt.date(2027, 5, 3)
            assert item.due_at.date() == dt.date(2027, 5, 7)

    def test_nothing_falls_in_the_break_week(self, generated):
        _, items = generated
        for item in items:
            for stamp in (item.unlock_at, item.due_at, item.lock_at):
                assert not (dt.date(2027, 3, 15) <= stamp.date() <= dt.date(2027, 3, 21)), item.path

    def test_daylight_saving_transition_is_handled(self, generated):
        """DST starts Mar 14 2027: weeks 1-9 are MST, weeks 10-15 MDT."""
        _, items = generated
        by_week = {i.week: i for i in items if i.week is not None}
        assert by_week[1].due_at.utcoffset() == dt.timedelta(hours=-7)
        assert by_week[10].due_at.utcoffset() == dt.timedelta(hours=-6)
        assert by_week[15].due_at.utcoffset() == dt.timedelta(hours=-6)

    def test_week_fifteen_ends_on_the_last_day_of_instruction(self, generated):
        _, items = generated
        week15 = [i for i in items if i.week == 15]
        assert week15
        for item in week15:
            assert item.due_at.date() == dt.date(2027, 4, 30)

    def test_shift_moves_everything_together(self, generated):
        _, items = generated
        shifted = [i.shifted(7) for i in items]
        for before, after in zip(items, shifted):
            assert after.due_at - before.due_at == dt.timedelta(days=7)


class TestValidation:
    def test_out_of_order_dates_are_reported(self):
        from edutools.dates import ItemDates

        tz = _term().tz
        bad = ItemDates(
            path="assignments/lab-x.md", title="Lab X", kind="lab", week=1, points=1000,
            unlock_at=dt.datetime(2027, 1, 20, tzinfo=tz),
            due_at=dt.datetime(2027, 1, 15, tzinfo=tz),
            lock_at=dt.datetime(2027, 1, 17, tzinfo=tz),
        )
        problems = validate([bad], _term())
        assert any("out of order" in p for p in problems)

    def test_first_monday_must_be_a_monday(self, tmp_path: Path):
        (tmp_path / "canvas.toml").write_text(
            "[term]\n"
            'timezone = "America/Denver"\n'
            "first_monday = 2027-01-12\n"
            "weeks = 15\n"
            "last_day_of_instruction = 2027-04-30\n"
            "finals_start = 2027-05-03\n"
            "finals_end = 2027-05-07\n"
            'policy.lab = { unlock = "mon 00:00", due = "sun 23:59", grace_days = 2 }\n'
        )
        with pytest.raises(DateConfigError, match="not a Monday"):
            load_config(tmp_path)

    def test_missing_canvas_toml(self, tmp_path: Path):
        with pytest.raises(DateConfigError, match="no canvas.toml"):
            load_config(tmp_path)


class TestTotalPoints:
    """CS331 grades out of a fixed 1000; CS425 grades by weighted groups instead."""

    def _item(self, points: float):
        term = _term()
        tz = term.tz
        due = dt.datetime(2027, 1, 15, 23, 59, tzinfo=tz)
        return ItemDates(
            path="assignments/p0.md", title="P0", kind="project", week=1, points=points,
            unlock_at=due - dt.timedelta(days=4), due_at=due, lock_at=due,
        )

    def test_the_default_total_is_still_checked(self):
        problems = validate([self._item(850)], _term())
        assert any("not 1000" in p for p in problems)

    def test_a_custom_total_is_checked_against(self):
        problems = validate([self._item(850)], _term(total_points=850))
        assert not any("sum to" in p for p in problems)

    def test_zero_disables_the_check(self):
        problems = validate([self._item(37)], _term(total_points=0))
        assert not any("sum to" in p for p in problems)


class TestOptionalUnlock:
    """A policy with no `unlock` leaves Canvas's "Available from" blank."""

    def _config(self, tmp_path, unlock_line: str):
        (tmp_path / "assignments").mkdir(parents=True, exist_ok=True)
        (tmp_path / "assignments" / "p0.md").write_text(
            "# P0\n\n**Week 2 · 50 points · x**\n", encoding="utf-8"
        )
        (tmp_path / "canvas.toml").write_text(
            "[term]\n"
            'timezone = "America/Boise"\n'
            "first_monday = 2026-08-24\n"
            "weeks = 15\n"
            "last_day_of_instruction = 2026-12-11\n"
            "finals_start = 2026-12-14\n"
            "finals_end = 2026-12-18\n"
            "total_points = 0\n\n"
            "[term.policy.project]\n"
            f"{unlock_line}"
            'due = "tue 23:59"\n'
            "grace_days = 2\n\n"
            "[layout]\n"
            'syllabus = "index.md"\n\n'
            "[layout.gradable]\n"
            'project = "assignments/p[0-9]*.md"\n',
            encoding="utf-8",
        )
        return load_config(tmp_path)

    def test_an_absent_unlock_yields_no_unlock_date(self, tmp_path: Path):
        config = self._config(tmp_path, "")
        assert config.policies["project"].unlock is None
        item = compute(tmp_path, config)[0]
        assert item.unlock_at is None
        assert item.due_at is not None

    def test_a_present_unlock_still_works(self, tmp_path: Path):
        config = self._config(tmp_path, 'unlock = "mon 00:00"\n')
        item = compute(tmp_path, config)[0]
        assert item.unlock_at is not None
        assert item.unlock_at.hour == 0

    def test_validate_accepts_an_item_with_no_unlock(self, tmp_path: Path):
        config = self._config(tmp_path, "")
        assert validate(compute(tmp_path, config), config.term) == []

    def test_validate_still_catches_due_after_lock(self, tmp_path: Path):
        config = self._config(tmp_path, "")
        item = compute(tmp_path, config)[0]
        broken = ItemDates(
            item.path, item.title, item.kind, item.week, item.points,
            None, item.due_at, item.due_at - dt.timedelta(days=1),
        )
        assert any("out of order" in p for p in validate([broken], config.term))

    def test_shifting_keeps_the_absent_unlock(self, tmp_path: Path):
        item = compute(tmp_path, self._config(tmp_path, ""))[0]
        assert item.shifted(3).unlock_at is None


class TestAssignmentGroups:
    """[[group]] declares the Canvas assignment groups and their weights."""

    def _raw(self, toml: str) -> dict[str, object]:
        import tomllib

        return tomllib.loads(toml)

    def test_no_group_section_declares_nothing(self):
        assert load_groups(self._raw("[term]\n")) == ()

    def test_a_group_keeps_its_name_weight_and_kinds(self):
        groups = load_groups(
            self._raw('[[group]]\nname = "Projects"\nweight = 10\nkinds = ["project"]\n')
        )
        assert groups == (Group(name="Projects", weight=10.0, kinds=("project",)),)

    def test_declaration_order_is_kept(self):
        groups = load_groups(
            self._raw('[[group]]\nname = "Exams"\n\n[[group]]\nname = "Projects"\n')
        )
        assert [group.name for group in groups] == ["Exams", "Projects"]

    def test_a_group_needs_neither_weight_nor_kinds(self):
        """An exam group whose quizzes are built by hand still has to exist."""
        groups = load_groups(self._raw('[[group]]\nname = "Exams"\n'))
        assert groups[0].weight is None and groups[0].kinds == ()

    def test_group_for_finds_the_group_of_a_kind(self):
        config = DateConfig(
            term=_term(), policies={}, overrides={},
            groups=load_groups(
                self._raw('[[group]]\nname = "In Class"\nkinds = ["lab", "discussion"]\n')
            ),
        )
        found = config.group_for("lab")
        assert found is not None and found.name == "In Class"
        assert config.group_for("project") is None

    def test_total_weight_adds_the_declared_weights(self):
        config = DateConfig(
            term=_term(), policies={}, overrides={},
            groups=load_groups(
                self._raw(
                    '[[group]]\nname = "Exams"\nweight = 50\n\n'
                    '[[group]]\nname = "Projects"\nweight = 10\n\n'
                    '[[group]]\nname = "Ungraded"\n'
                )
            ),
        )
        assert config.total_weight == 60.0

    def test_two_groups_cannot_claim_the_same_kind(self):
        with pytest.raises(DateConfigError, match="claimed by both"):
            load_groups(
                self._raw(
                    '[[group]]\nname = "A"\nkinds = ["lab"]\n\n'
                    '[[group]]\nname = "B"\nkinds = ["lab"]\n'
                )
            )

    def test_an_unknown_kind_is_rejected(self):
        with pytest.raises(DateConfigError, match="not a known item kind"):
            load_groups(self._raw('[[group]]\nname = "A"\nkinds = ["homework"]\n'))

    def test_a_duplicate_group_name_is_rejected(self):
        with pytest.raises(DateConfigError, match="declared twice"):
            load_groups(self._raw('[[group]]\nname = "A"\n\n[[group]]\nname = "A"\n'))

    def test_a_nameless_group_is_rejected(self):
        with pytest.raises(DateConfigError, match="non-empty string"):
            load_groups(self._raw('[[group]]\nweight = 10\n'))

    def test_a_non_numeric_weight_is_rejected(self):
        with pytest.raises(DateConfigError, match="weight must be a number"):
            load_groups(self._raw('[[group]]\nname = "A"\nweight = "lots"\n'))

    def test_groups_load_from_canvas_toml(self, tmp_path: Path):
        (tmp_path / "canvas.toml").write_text(
            "[term]\n"
            'timezone = "America/Boise"\n'
            "first_monday = 2026-08-24\nweeks = 15\n"
            "last_day_of_instruction = 2026-12-11\n"
            "finals_start = 2026-12-14\nfinals_end = 2026-12-18\n\n"
            '[term.policy.lab]\ndue = "wed 23:59"\n\n'
            '[[group]]\nname = "In Class"\nweight = 40\nkinds = ["lab"]\n',
            encoding="utf-8",
        )
        config = load_config(tmp_path)
        found = config.group_for("lab")
        assert found is not None and found.name == "In Class"
        assert found.weight == 40.0


class TestDraftsTakeNoDates:
    """A draft is not a Canvas object, so it never gets a due date."""

    def _repo(self, tmp_path: Path, a1_frontmatter: str) -> Path:
        (tmp_path / "activities").mkdir(parents=True, exist_ok=True)
        (tmp_path / "activities" / "a1-devbox.md").write_text(
            f"{a1_frontmatter}# A1\n\n**Week 1 · 20 points · x**\n", encoding="utf-8"
        )
        (tmp_path / "activities" / "a2-sockets.md").write_text(
            "# A2\n\n**Week 3 · 20 points · x**\n", encoding="utf-8"
        )
        (tmp_path / "canvas.toml").write_text(
            "[term]\n"
            'timezone = "America/Boise"\n'
            "first_monday = 2026-08-24\n"
            "weeks = 15\n"
            "last_day_of_instruction = 2026-12-11\n"
            "finals_start = 2026-12-14\n"
            "finals_end = 2026-12-18\n"
            "total_points = 0\n\n"
            "[term.policy.lab]\n"
            'due = "wed 23:59"\n'
            "grace_days = 0\n\n"
            "[layout]\n"
            'syllabus = "index.md"\n\n'
            "[layout.gradable]\n"
            'lab = "activities/a[0-9]*.md"\n',
            encoding="utf-8",
        )
        return tmp_path

    def test_a_draft_is_left_out(self, tmp_path: Path):
        repo = self._repo(tmp_path, "---\ndraft: true\n---\n\n")
        assert [item.path for item in compute(repo)] == ["activities/a2-sockets.md"]

    def test_the_same_file_counts_once_the_flag_comes_off(self, tmp_path: Path):
        repo = self._repo(tmp_path, "---\nnext: false\n---\n\n")
        assert len(compute(repo)) == 2

    def test_a_draft_needs_no_header_line(self, tmp_path: Path):
        # Half written work has no "**Week N · P points**" line yet, and demanding
        # one would mean a draft could not be committed until it was finished.
        repo = self._repo(tmp_path, "")
        (repo / "activities" / "a1-devbox.md").write_text(
            "---\ndraft: true\n---\n\n# A1\n\nStill thinking about this one.\n",
            encoding="utf-8",
        )
        assert [item.path for item in compute(repo)] == ["activities/a2-sockets.md"]
