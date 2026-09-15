"""Tests for the module outline a site renders from the repo."""

import datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

from edutools.dates import ItemDates
from edutools.outline import OutlineItem, outline, to_json

TZ = ZoneInfo("America/Boise")


def _dates(path: str, title: str, points: float) -> ItemDates:
    due = dt.datetime(2026, 9, 9, 23, 59, tzinfo=TZ)
    return ItemDates(path, title, "lab", 3, points, None, due, due)


def _repo(tmp_path: Path) -> Path:
    (tmp_path / "notes").mkdir()
    (tmp_path / "activities").mkdir()
    (tmp_path / "notes" / "ch01.md").write_text("# Chapter 1\n", encoding="utf-8")
    (tmp_path / "activities" / "a1.md").write_text("# A1 - Dig\n\n**Week 3 · 20 points**\n", encoding="utf-8")
    (tmp_path / "activities" / "a9.md").write_text("---\ndraft: true\n---\n\n# A9\n", encoding="utf-8")
    return tmp_path


class TestOutline:
    def test_page_then_items_then_native_in_order(self, tmp_path: Path):
        repo = _repo(tmp_path)
        modules = [{
            "title": "Week 1",
            "page": "notes/ch01.md",
            "items": ["activities/a1.md"],
            "canvas": [{"quiz": 393657, "title": "Chapter 1 - Knowledge Check"}],
        }]
        dates = {"activities/a1.md": _dates("activities/a1.md", "A1 - Dig", 20)}
        result = outline(repo, modules, {"notes/ch01.md": "page", "activities/a1.md": "assignment"}, dates)
        assert len(result) == 1 and result[0].title == "Week 1"
        assert result[0].items == (
            OutlineItem("page", "Chapter 1", "notes/ch01"),
            OutlineItem("assignment", "A1 - Dig", "activities/a1", "2026-09-09T23:59:00-06:00", 20.0),
            OutlineItem("quiz", "Chapter 1 - Knowledge Check", canvas_id="393657"),
        )

    def test_a_draft_is_left_out_like_the_push_leaves_it_out(self, tmp_path: Path):
        repo = _repo(tmp_path)
        modules = [{"title": "Week 9", "items": ["activities/a9.md", "activities/a1.md"]}]
        result = outline(repo, modules, {"activities/a1.md": "assignment"}, {})
        assert [i.title for i in result[0].items] == ["A1 - Dig"]

    def test_a_missing_file_is_skipped_not_fatal(self, tmp_path: Path):
        repo = _repo(tmp_path)
        result = outline(repo, [{"title": "W", "page": "notes/nope.md"}], {}, {})
        assert result[0].items == ()

    def test_native_item_without_a_title_gets_a_placeholder(self, tmp_path: Path):
        result = outline(_repo(tmp_path), [{"title": "W", "canvas": [{"quiz": 7}]}], {}, {})
        assert result[0].items[0].title == "quiz 7"

    def test_json_is_plain_dicts(self, tmp_path: Path):
        result = outline(_repo(tmp_path), [{"title": "W", "page": "notes/ch01.md"}], {}, {})
        assert to_json(result) == [{
            "title": "W",
            "items": [{"kind": "page", "title": "Chapter 1", "path": "notes/ch01",
                       "due_at": None, "points": None, "canvas_id": ""}],
        }]
