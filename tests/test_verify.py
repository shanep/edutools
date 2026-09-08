"""Tests for the post-publish verification pass.

Each check is fed a known-good Canvas payload and a known-mangled one, so we
know the check actually fires rather than merely existing.
"""

from edutools.publish import Entry
from edutools.verify import (
    check_body,
    check_file,
    check_gradebook_total,
    check_identity,
    check_links,
    check_metadata,
    check_module,
    check_quiz_questions,
    summarise,
    Intent,
)

GOOD = '<h2>Read</h2><table><tr><td>CyBOK §10.4</td></tr></table><p style="color: red">x</p>'


class TestIdentity:
    def test_missing_object_is_reported(self):
        failures = check_identity("k", Entry("page", "1", title="Week 1"), None)
        assert failures and failures[0].check == "missing"

    def test_title_mismatch_is_reported(self):
        failures = check_identity("k", Entry("page", "1", title="Week 1"), {"title": "Week Two"})
        assert failures and failures[0].check == "title"

    def test_matching_title_passes(self):
        assert check_identity("k", Entry("page", "1", title="Week 1"), {"title": "Week 1"}) == []


class TestBody:
    def test_identical_body_passes(self):
        assert check_body("k", GOOD, GOOD) == []

    def test_canvas_added_attributes_do_not_trip_it(self):
        stored = GOOD.replace("<td>", '<td data-api-endpoint="https://x" data-api-returntype="Page">')
        assert check_body("k", GOOD, stored) == []

    def test_whitespace_differences_do_not_trip_it(self):
        assert check_body("k", GOOD, GOOD.replace("<h2>", "\n  <h2>\n  ")) == []

    def test_dropped_text_is_caught(self):
        stored = GOOD.replace("CyBOK §10.4", "")
        checks = {f.check for f in check_body("k", GOOD, stored)}
        assert "content" in checks

    def test_dropped_table_is_caught(self):
        stored = GOOD.replace("<table><tr><td>CyBOK §10.4</td></tr></table>", "<p>CyBOK §10.4</p>")
        checks = {f.check for f in check_body("k", GOOD, stored)}
        assert "structure" in checks

    def test_stripped_style_is_caught(self):
        """The silent failure the styling phase is most exposed to."""
        stored = GOOD.replace(' style="color: red"', "")
        failures = check_body("k", GOOD, stored)
        assert any(f.check == "styles" for f in failures)
        assert any("color:red" in f.detail for f in failures if f.check == "styles")


class TestLinks:
    def test_known_target_passes(self):
        html = '<a href="/courses/42/pages/week-01">x</a>'
        assert check_links("k", html, "42", {"/courses/42/pages/week-01"}, lambda _: False) == []

    def test_unknown_but_resolvable_passes(self):
        html = '<a href="/courses/42/assignments/9">x</a>'
        assert check_links("k", html, "42", set(), lambda _: True) == []

    def test_dangling_link_is_caught(self):
        html = '<a href="/courses/42/assignments/9">x</a>'
        failures = check_links("k", html, "42", set(), lambda _: False)
        assert failures and failures[0].check == "link"

    def test_external_links_are_ignored(self):
        html = '<a href="https://cybok.org">x</a>'
        assert check_links("k", html, "42", set(), lambda _: False) == []


class TestMetadata:
    def _intent(self, **kw: object) -> Intent:
        base: dict[str, object] = {"key": "k", "kind": "assignment", "title": "Lab 4"}
        base.update(kw)
        return Intent(**base)  # type: ignore[arg-type]

    def test_matching_metadata_passes(self):
        intent = self._intent(points=38.0, published=False, due_at="2027-02-28T23:59:00-07:00")
        stored = {"points_possible": 38, "published": False, "due_at": "2027-03-01T06:59:00Z"}
        # The date differs in representation but not instant; the check compares strings,
        # so the publisher must send what Canvas will echo. Here they differ, so it fires.
        failures = check_metadata("k", intent, stored)
        assert {f.check for f in failures} == {"due_at"}

    def test_wrong_points_is_caught(self):
        failures = check_metadata("k", self._intent(points=38.0), {"points_possible": 30})
        assert failures and failures[0].check == "points"

    def test_accidentally_published_is_caught(self):
        failures = check_metadata("k", self._intent(published=False), {"published": True})
        assert any(f.check == "published" for f in failures)

    def test_exact_date_match_passes(self):
        intent = self._intent(due_at="2027-02-28T23:59:00Z")
        assert check_metadata("k", intent, {"due_at": "2027-02-28T23:59:00Z"}) == []


class TestQuizQuestions:
    def _q(self, **kw: object) -> dict[str, object]:
        base: dict[str, object] = {
            "question_name": "Q1",
            "question_type": "multiple_choice_question",
            "neutral_comments": "because",
            "answers": [{"weight": 100}, {"weight": 0}],
        }
        base.update(kw)
        return base

    def test_complete_quiz_passes(self):
        assert check_quiz_questions("k", 2, [self._q(), self._q()]) == []

    def test_partial_write_is_caught(self):
        """A quiz that got 12 of its 15 questions is the classic partial failure."""
        failures = check_quiz_questions("k", 15, [self._q()] * 12)
        assert any(f.check == "questions" for f in failures)

    def test_unkeyed_answer_is_caught(self):
        failures = check_quiz_questions("k", 1, [self._q(answers=[{"weight": 0}, {"weight": 0}])])
        assert any("no correct answer" in f.detail for f in failures)

    def test_multiple_choice_with_two_correct_is_caught(self):
        failures = check_quiz_questions("k", 1, [self._q(answers=[{"weight": 100}, {"weight": 100}])])
        assert any("2 correct" in f.detail for f in failures)

    def test_missing_rationale_is_caught(self):
        failures = check_quiz_questions("k", 1, [self._q(neutral_comments="")])
        assert any(f.check == "rationale" for f in failures)


class TestFiles:
    def test_complete_upload_passes(self):
        assert check_file("k", 21703405, {"size": 21703405, "upload_status": "success"}) == []

    def test_truncated_upload_is_caught(self):
        """The 21 MB CyBOK PDF arriving short."""
        failures = check_file("k", 21703405, {"size": 1048576, "upload_status": "success"})
        assert failures and "21703405" in failures[0].detail

    def test_pending_upload_is_caught(self):
        failures = check_file("k", 100, {"size": 100, "upload_status": "pending"})
        assert any("not available" in f.detail for f in failures)


class TestModulesAndGradebook:
    def test_module_with_the_right_items_passes(self):
        items: list[dict[str, object]] = [{"position": 1}, {"position": 2}, {"position": 3}]
        assert check_module("k", 3, items) == []

    def test_missing_module_item_is_caught(self):
        failures = check_module("k", 3, [{"position": 1}])  # type: ignore[list-item]
        assert failures and "expected 3 items" in failures[0].detail

    def test_out_of_order_items_are_caught(self):
        failures = check_module("k", 2, [{"position": 2}, {"position": 1}])  # type: ignore[list-item]
        assert any("out of order" in f.detail for f in failures)

    def test_gradebook_total(self):
        assignments: list[dict[str, object]] = [{"points_possible": 400}, {"points_possible": 600}]
        assert check_gradebook_total(assignments, 1000.0) == []

    def test_gradebook_shortfall_is_caught(self):
        shortfall: list[dict[str, object]] = [{"points_possible": 962}]
        failures = check_gradebook_total(shortfall, 1000.0)
        assert failures and "962" in failures[0].detail


def test_summarise_groups_by_check():
    failures = (
        check_identity("a", Entry("page", "1", title="X"), None)
        + check_identity("b", Entry("page", "2", title="Y"), None)
        + check_gradebook_total([{"points_possible": 1}], 1000.0)  # type: ignore[list-item]
    )
    assert summarise(failures) == {"missing": 2, "gradebook": 1}


class TestRationaleField:
    """Canvas fills neutral_comments or neutral_comments_html, never both."""

    def _stored(self, **comments: str):
        base = {
            "question_name": "Q1", "question_type": "multiple_choice_question",
            "question_text": "<p>s</p>",
            "answers": [{"text": "a", "weight": 100.0}],
            "neutral_comments": "", "neutral_comments_html": "",
        }
        base.update(comments)
        return [base]

    def test_a_plain_rationale_passes(self):
        failures = check_quiz_questions("q.md", 1, self._stored(neutral_comments="because"))
        assert not [f for f in failures if f.check == "rationale"]

    def test_a_rendered_rationale_passes(self):
        failures = check_quiz_questions(
            "q.md", 1, self._stored(neutral_comments_html="<p>because</p>")
        )
        assert not [f for f in failures if f.check == "rationale"]

    def test_no_rationale_at_all_still_fails(self):
        failures = check_quiz_questions("q.md", 1, self._stored())
        assert [f for f in failures if f.check == "rationale"]
