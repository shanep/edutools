import pytest

from edutools.objects import (
    FieldError,
    GradeRow,
    build_fields,
    parse_grades,
    parse_overrides,
    spec_for,
)


class TestSpecs:
    """Each kind names the shared fields the way its own endpoint does."""

    def test_unknown_kind_is_rejected(self):
        with pytest.raises(FieldError, match="unknown kind"):
            spec_for("rubric")

    @pytest.mark.parametrize(
        "kind,expected",
        [
            ("page", {"wiki_page[title]": "Week 1"}),
            ("assignment", {"assignment[name]": "Week 1"}),
            ("discussion", {"title": "Week 1"}),  # discussions take bare params
            ("quiz", {"quiz[title]": "Week 1"}),
            ("module", {"module[name]": "Week 1"}),
        ],
    )
    def test_title_key_per_kind(self, kind, expected):
        assert build_fields(kind, title="Week 1") == expected


class TestBuildFields:
    def test_omits_everything_not_passed(self):
        """An update must not clear fields the caller never mentioned."""
        assert build_fields("assignment", title="Lab 1") == {"assignment[name]": "Lab 1"}

    def test_nothing_passed_builds_nothing(self):
        assert build_fields("assignment") == {}

    def test_body_uses_the_per_kind_name(self):
        assert build_fields("assignment", body="<p>hi</p>") == {"assignment[description]": "<p>hi</p>"}
        assert build_fields("discussion", body="<p>hi</p>") == {"message": "<p>hi</p>"}
        assert build_fields("page", body="<p>hi</p>") == {"wiki_page[body]": "<p>hi</p>"}

    def test_module_has_no_body(self):
        with pytest.raises(FieldError, match="no body"):
            build_fields("module", body="<p>hi</p>")

    def test_graded_discussion_points_hang_off_the_assignment(self):
        assert build_fields("discussion", points=25) == {"assignment[points_possible]": "25"}

    def test_points_format_drops_trailing_zeros(self):
        assert build_fields("assignment", points=12.50) == {"assignment[points_possible]": "12.5"}

    def test_quiz_points_come_from_its_questions(self):
        with pytest.raises(FieldError, match="scores from its questions"):
            build_fields("quiz", points=10)

    def test_page_takes_no_points(self):
        with pytest.raises(FieldError, match="takes no points"):
            build_fields("page", points=10)

    def test_dates_use_the_kinds_prefix(self):
        assert build_fields("quiz", due="2026-09-15T23:59:00-06:00") == {
            "quiz[due_at]": "2026-09-15T23:59:00-06:00"
        }
        assert build_fields("discussion", due="2026-09-15T23:59:00-06:00") == {
            "assignment[due_at]": "2026-09-15T23:59:00-06:00"
        }

    def test_all_three_dates(self):
        fields = build_fields(
            "assignment", due="2026-09-15", unlock="2026-09-08", lock="2026-09-22"
        )
        assert fields == {
            "assignment[due_at]": "2026-09-15",
            "assignment[unlock_at]": "2026-09-08",
            "assignment[lock_at]": "2026-09-22",
        }

    def test_page_has_no_dates(self):
        with pytest.raises(FieldError, match="no due / available dates"):
            build_fields("page", due="2026-09-15")

    def test_published_is_lowercase_for_canvas(self):
        assert build_fields("assignment", published=True) == {"assignment[published]": "true"}
        assert build_fields("assignment", published=False) == {"assignment[published]": "false"}
        assert build_fields("discussion", published=True) == {"published": "true"}

    def test_position_is_modules_only(self):
        assert build_fields("module", position=3) == {"module[position]": "3"}
        with pytest.raises(FieldError, match="only modules are ordered"):
            build_fields("assignment", position=3)

    def test_overrides_reach_fields_the_flags_do_not_model(self):
        fields = build_fields(
            "assignment",
            title="Lab 1",
            overrides={"assignment[submission_types][]": "online_upload"},
        )
        assert fields["assignment[submission_types][]"] == "online_upload"

    def test_overrides_win(self):
        fields = build_fields("assignment", points=10, overrides={"assignment[points_possible]": "99"})
        assert fields["assignment[points_possible]"] == "99"


class TestParseOverrides:
    def test_splits_on_the_first_equals(self):
        assert parse_overrides(["assignment[name]=a=b"]) == {"assignment[name]": "a=b"}

    def test_empty_value_is_allowed(self):
        assert parse_overrides(["assignment[due_at]="]) == {"assignment[due_at]": ""}

    def test_none_is_empty(self):
        assert parse_overrides(None) == {}

    def test_missing_equals_is_rejected(self):
        with pytest.raises(FieldError, match="key=value"):
            parse_overrides(["assignment[name]"])


class TestGradeRow:
    def test_a_row_that_would_send_nothing_is_rejected(self):
        with pytest.raises(FieldError, match="nothing to apply"):
            GradeRow(user_id="789")

    def test_a_comment_alone_is_enough(self):
        """Feedback with no number on it is a real thing to want."""
        assert GradeRow(user_id="789", comment="See notes.").grade is None

    def test_an_excusal_alone_is_enough(self):
        assert GradeRow(user_id="789", excuse=True).excuse is True


class TestParseGrades:
    def test_list_of_objects(self):
        rows = parse_grades('[{"student": 789, "score": 18, "comment": "Clean tests."}]')
        assert rows == [GradeRow(user_id="789", grade="18", comment="Clean tests.")]

    def test_aliases_are_matched_loosely(self):
        for key in ("user_id", "student_id", "student", "id"):
            assert parse_grades(f'[{{"{key}": 7, "grade": 1}}]')[0].user_id == "7"
        for key in ("grade", "score", "posted_grade", "points"):
            assert parse_grades(f'[{{"student": 7, "{key}": 18}}]')[0].grade == "18"
        for key in ("comment", "feedback", "text_comment"):
            assert parse_grades(f'[{{"student": 7, "{key}": "ok"}}]')[0].comment == "ok"

    def test_object_keyed_by_student(self):
        rows = parse_grades('{"789": {"score": 18}, "790": {"score": 20}}')
        assert [(r.user_id, r.grade) for r in rows] == [("789", "18"), ("790", "20")]

    def test_object_keyed_by_student_with_a_bare_grade(self):
        rows = parse_grades('{"789": 18}')
        assert rows == [GradeRow(user_id="789", grade="18")]

    def test_an_inner_user_id_beats_the_key(self):
        rows = parse_grades('{"ignored": {"user_id": 789, "score": 18}}')
        assert rows[0].user_id == "789"

    def test_excuse_accepts_the_spellings_a_spreadsheet_produces(self):
        for value in ("true", "TRUE", "yes", "1"):
            assert parse_grades(f'[{{"student": 7, "excuse": "{value}"}}]')[0].excuse is True
        assert parse_grades('[{"student": 7, "score": 0, "excuse": "no"}]')[0].excuse is False

    def test_rubric_is_carried_through(self):
        rows = parse_grades('[{"student": 7, "rubric": {"crit_1": {"points": 4}}}]')
        assert rows[0].rubric == {"crit_1": {"points": 4}}

    def test_rubric_must_be_an_object(self):
        with pytest.raises(FieldError, match="must be an object"):
            parse_grades('[{"student": 7, "rubric": [1, 2]}]')

    def test_missing_student_id_is_rejected(self):
        with pytest.raises(FieldError, match="missing a student id"):
            parse_grades('[{"score": 18}]')

    def test_row_with_nothing_to_apply_is_rejected(self):
        with pytest.raises(FieldError, match="nothing to apply"):
            parse_grades('[{"student": 7}]')

    def test_bad_json_is_reported_as_such(self):
        with pytest.raises(FieldError, match="not valid JSON"):
            parse_grades("{oops")

    def test_a_bare_list_of_scalars_is_rejected(self):
        with pytest.raises(FieldError, match="expected a list of objects"):
            parse_grades("[1, 2]")

    def test_a_json_scalar_is_rejected(self):
        with pytest.raises(FieldError, match="expected a JSON list"):
            parse_grades('"18"')

    def test_csv_with_a_header(self):
        rows = parse_grades("student_id,score,comment\n789,18,Clean tests.\n790,20,\n", as_csv=True)
        assert rows[0] == GradeRow(user_id="789", grade="18", comment="Clean tests.")
        assert rows[1] == GradeRow(user_id="790", grade="20", comment=None)

    def test_csv_without_rows_is_rejected(self):
        with pytest.raises(FieldError, match="header row"):
            parse_grades("student_id,score\n", as_csv=True)
