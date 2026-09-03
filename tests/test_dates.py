"""Tests for course due-date generation.

These need no Canvas token: dates.py is pure computation.
"""

import datetime as dt
from pathlib import Path

import pytest

from edutools.dates import (
    DateConfigError,
    Term,
    classify,
    compute,
    cross_check_syllabus,
    load_config,
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
        ],
    )
    def test_classification(self, path: str, expected: str | None):
        assert classify(Path(path)) == expected


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
