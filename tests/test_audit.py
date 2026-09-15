"""Tests for the two-way manifest audit.

Each case builds a small manifest and a small live inventory and checks that
the difference fires in exactly one direction, so a stale entry is never
mistaken for an untracked object or the reverse.
"""

from pathlib import Path

from edutools.audit import (
    DeclaredModule,
    Difference,
    LiveObject,
    audit_modules,
    audit_objects,
    declared_modules,
    live_assignments,
    live_files,
    live_modules,
    summarise,
)
from edutools.publish import Entry, Manifest, NativeItem, parse_native_items


def _manifest(tmp_path: Path, **entries: Entry) -> Manifest:
    manifest = Manifest(tmp_path / "manifest.json")
    for key, entry in entries.items():
        manifest.entries[key.replace("__", "/")] = entry
    return manifest


class TestObjects:
    def test_everything_tracked_and_present_is_quiet(self, tmp_path: Path):
        manifest = _manifest(
            tmp_path,
            notes__w1=Entry("page", "week-1", page_url="week-1", title="Week 1"),
            assignments__p0=Entry("assignment", "10", title="P0"),
        )
        live = [LiveObject("page", "week-1", "Week 1"), LiveObject("assignment", "10", "P0")]
        assert audit_objects(manifest, live, set()) == []

    def test_manifest_entry_gone_from_canvas_is_stale(self, tmp_path: Path):
        manifest = _manifest(tmp_path, notes__w1=Entry("page", "week-1", page_url="week-1", title="Week 1"))
        result = audit_objects(manifest, [], set())
        assert result == [Difference("stale", "page", "week-1", "Week 1", "notes/w1")]

    def test_a_stale_draft_says_so(self, tmp_path: Path):
        manifest = _manifest(tmp_path, notes__w1=Entry("page", "week-1", page_url="week-1", title="Week 1"))
        result = audit_objects(manifest, [], {"notes/w1"})
        assert result[0].side == "stale" and "draft" in result[0].detail

    def test_canvas_object_nobody_pushed_is_untracked(self, tmp_path: Path):
        manifest = _manifest(tmp_path)
        live = [LiveObject("quiz", "77", "Midterm Exam", published=True)]
        result = audit_objects(manifest, live, set())
        assert result == [Difference("untracked", "quiz", "77", "Midterm Exam", "", "published")]

    def test_pages_match_on_url_not_id(self, tmp_path: Path):
        manifest = _manifest(tmp_path, notes__w1=Entry("page", "123", page_url="week-1", title="Week 1"))
        live = [LiveObject("page", "week-1", "Week 1")]
        assert audit_objects(manifest, live, set()) == []

    def test_syllabus_and_module_entries_are_ignored(self, tmp_path: Path):
        manifest = _manifest(tmp_path, index=Entry("syllabus", "48194", title="Syllabus"))
        assert audit_objects(manifest, [], set()) == []

    def test_stale_come_before_untracked_and_are_sorted_by_key(self, tmp_path: Path):
        manifest = _manifest(
            tmp_path,
            b=Entry("page", "b", page_url="b", title="B"),
            a=Entry("page", "a", page_url="a", title="A"),
        )
        live = [LiveObject("file", "1", "extra.pdf")]
        sides = [(d.side, d.key or d.title) for d in audit_objects(manifest, live, set())]
        assert sides == [("stale", "a"), ("stale", "b"), ("untracked", "extra.pdf")]


class TestLiveInventory:
    def test_quiz_and_discussion_assignments_are_not_plain_assignments(self):
        assignments = [
            {"id": 1, "name": "P0", "published": True},
            {"id": 2, "name": "Midterm", "is_quiz_assignment": True, "quiz_id": 9},
            {"id": 3, "name": "Intro", "discussion_topic": {"id": 4}},
        ]
        assert [a.ident for a in live_assignments(assignments)] == ["1"]

    def test_files_report_size_and_visibility(self):
        files = [{"id": 5, "display_name": "a1-worksheet.pdf", "size": 100, "locked": False, "hidden": False}]
        (obj,) = live_files(files)
        assert obj.title == "a1-worksheet.pdf" and obj.published and obj.detail == "100 bytes"

    def test_modules_count_their_items(self):
        modules = [{"id": 7, "name": "Week 1", "published": True}]
        (obj,) = live_modules(modules, {"7": [{"id": 1}, {"id": 2}]})
        assert obj.detail == "2 items"


class TestModules:
    def test_declared_module_missing_in_canvas_is_pending_not_stale(self, tmp_path: Path):
        result = audit_modules([DeclaredModule("Week 1")], [], {}, _manifest(tmp_path))
        assert result == [
            Difference("pending", "module", "", "Week 1", "", "declared in canvas.toml; the next push creates it")
        ]

    def test_module_nobody_declared_is_untracked(self, tmp_path: Path):
        modules = [LiveObject("module", "7", "Old Week", published=False, detail="3 items")]
        result = audit_modules([], modules, {"7": []}, _manifest(tmp_path))
        assert result == [Difference("untracked", "module", "7", "Old Week", "", "unpublished; 3 items")]

    def test_hand_added_item_in_a_tracked_module_is_reported(self, tmp_path: Path):
        manifest = _manifest(tmp_path, notes__w1=Entry("page", "week-1", page_url="week-1", title="Week 1"))
        modules = [LiveObject("module", "7", "Week 1", detail="2 items")]
        items = {
            "7": [
                {"id": 1, "type": "Page", "page_url": "week-1", "title": "Week 1"},
                {"id": 2, "type": "Assignment", "content_id": 999, "title": "Surprise"},
                {"id": 3, "type": "SubHeader", "title": "Reading"},
            ]
        }
        result = audit_modules([DeclaredModule("Week 1")], modules, items, manifest)
        assert [d.title for d in result] == ["Surprise"]
        assert result[0].kind == "module item" and "next push removes it" in result[0].detail
        assert "{ assignment = 999 }" in result[0].detail

    def test_item_named_under_canvas_is_not_reported(self, tmp_path: Path):
        declared = [DeclaredModule("Week 8", (NativeItem("quiz", "393662"),))]
        modules = [LiveObject("module", "7", "Week 8", detail="1 items")]
        items = {"7": [{"id": 1, "type": "Quiz", "content_id": 393662, "title": "Midterm Exam"}]}
        assert audit_modules(declared, modules, items, _manifest(tmp_path)) == []

    def test_declared_modules_read_titles_and_native_items(self):
        raw: dict[str, object] = {
            "module": [
                {"title": "Week 1", "page": "notes/w1.md"},
                {"title": "Week 8", "canvas": [{"quiz": 393662, "title": "Midterm"}]},
                {"title": "Broken", "canvas": [{"quiz": 1, "page": "x"}]},
                "not a table",
            ]
        }
        result = declared_modules(raw)
        assert [d.title for d in result] == ["Week 1", "Week 8", "Broken"]
        assert result[1].native == (NativeItem("quiz", "393662", "Midterm"),)
        assert result[2].native == ()


class TestNativeItems:
    def test_each_kind_parses_with_optional_title(self):
        module: dict[str, object] = {
            "canvas": [
                {"quiz": 1},
                {"assignment": "2", "title": "Extra"},
                {"page": "home-page"},
                {"discussion": 4},
                {"file": 5},
            ]
        }
        assert parse_native_items(module) == [
            NativeItem("quiz", "1"),
            NativeItem("assignment", "2", "Extra"),
            NativeItem("page", "home-page"),
            NativeItem("discussion", "4"),
            NativeItem("file", "5"),
        ]

    def test_no_canvas_list_means_no_items(self):
        assert parse_native_items({"title": "Week 1"}) == []

    def test_two_kinds_in_one_entry_is_an_error(self):
        import pytest

        with pytest.raises(ValueError, match="exactly one of"):
            parse_native_items({"canvas": [{"quiz": 1, "page": "x"}]})

    def test_unknown_key_is_an_error(self):
        import pytest

        with pytest.raises(ValueError, match="exactly one of"):
            parse_native_items({"canvas": [{"quiz": 1, "position": 3}]})

    def test_non_table_entry_is_an_error(self):
        import pytest

        with pytest.raises(ValueError, match="expected a table"):
            parse_native_items({"canvas": [393662]})

    def test_empty_id_is_an_error(self):
        import pytest

        with pytest.raises(ValueError, match="needs an id"):
            parse_native_items({"canvas": [{"page": " "}]})

    def test_summary_counts_by_side_and_kind(self):
        diffs = [
            Difference("stale", "page", "a", "A"),
            Difference("stale", "page", "b", "B"),
            Difference("untracked", "quiz", "1", "Q"),
        ]
        assert summarise(diffs) == {"stale page": 2, "untracked quiz": 1}
