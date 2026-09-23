"""The pure rules behind `push --clean`. No Canvas token required."""

import pytest

from edutools.audit import DeclaredModule, Difference, clean_keep, clean_targets, student_work
from edutools.publish import NativeItem


def _untracked(kind: str, ident: str, title: str = "x") -> Difference:
    return Difference("untracked", kind, ident, title)


class TestCleanKeep:
    def test_native_items_and_the_keep_list_are_kept(self):
        declared = [DeclaredModule("M", (NativeItem(kind="quiz", ident="7", title=""),))]
        raw: dict[str, object] = {"clean": {"keep": [{"page": "home-page"}, {"quiz": 9}]}}
        assert clean_keep(raw, declared) == {("quiz", "7"), ("page", "home-page"), ("quiz", "9")}

    def test_no_clean_section_keeps_only_natives(self):
        assert clean_keep({}, []) == set()

    def test_a_malformed_keep_entry_is_an_error(self):
        with pytest.raises(ValueError):
            clean_keep({"clean": {"keep": [{"quiz": 1, "page": "x"}]}}, [])


class TestCleanTargets:
    def test_files_stale_and_kept_objects_are_never_targets(self):
        differences = [
            _untracked("file", "1"),
            _untracked("page", "old"),
            _untracked("quiz", "7"),
            Difference("stale", "page", "gone", "Gone", key="a.md"),
            Difference("pending", "module", "", "New"),
        ]
        targets = clean_targets(differences, {("quiz", "7")})
        assert [(t.kind, t.ident) for t in targets] == [("page", "old")]

    def test_modules_are_deleted_last(self):
        differences = [_untracked("module", "5", "A"), _untracked("page", "p", "Z")]
        assert [t.kind for t in clean_targets(differences, set())] == ["page", "module"]


class TestStudentWork:
    def test_submissions_on_the_backing_assignment(self):
        assert student_work("quiz", {}, {"has_submitted_submissions": True}) == "has submissions"

    def test_posts_in_a_discussion(self):
        assert student_work("discussion", {"discussion_subentry_count": 3}, None) == "has 3 post(s)"

    def test_an_unused_object_is_safe(self):
        assert student_work("assignment", {"has_submitted_submissions": False}, None) == ""
