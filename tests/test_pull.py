"""The course snapshot: where each object lands, and what a second pull removes.

The client is a MagicMock, so these cover the path rules and the prune logic,
which is where a pull can lose data, without a token.
"""

import json
import os
from pathlib import Path, PurePosixPath
from typing import Any
from unittest.mock import MagicMock

import pytest

from edutools.pull import (
    INDEX_NAME,
    Pulled,
    PullError,
    Puller,
    file_path,
    is_current,
    safe_component,
    stale_paths,
    stem,
)


def _canvas() -> MagicMock:
    """A course with one of everything, and a download that writes bytes."""
    canvas = MagicMock()
    canvas.get_course_with_syllabus.return_value = {
        "id": 42, "name": "CS 121", "syllabus_body": "<p>syllabus</p>",
    }
    canvas.list_pages.return_value = [{"url": "week-1", "title": "Week 1"}]
    canvas.get_page.return_value = {"url": "week-1", "title": "Week 1", "body": "<p>page</p>"}
    canvas.list_assignments.return_value = [
        {"id": 7, "name": "Lab 1: Setup", "description": "<p>lab</p>"},
    ]
    canvas.list_discussions.return_value = [{"id": 8, "title": "Intro", "message": ""}]
    canvas.list_announcements.return_value = []
    canvas.list_quizzes.return_value = [{"id": 9, "title": "Quiz 1", "description": "<p>q</p>"}]
    canvas.list_quiz_questions.return_value = [{"id": 1, "question_text": "?"}]
    canvas.list_modules.return_value = [{"id": 5, "name": "Week 1"}]
    canvas.list_module_items.return_value = [{"id": 50, "type": "Page"}]
    canvas.list_assignment_groups.return_value = [{"id": 3, "name": "Labs"}]
    canvas.list_rubrics.return_value = []
    canvas.list_folders.return_value = [
        {"id": 100, "full_name": "course files"},
        {"id": 101, "full_name": "course files/docs"},
    ]
    canvas.list_files.return_value = [
        {"id": 200, "folder_id": 101, "display_name": "notes.pdf", "size": 3,
         "url": "https://x/200", "modified_at": "2026-09-01T12:00:00Z"},
    ]

    def download(url: str, dest: Path) -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"pdf")
        return 3

    canvas.download_attachment.side_effect = download
    return canvas


def _index(out: Path) -> dict[str, Any]:
    return json.loads((out / INDEX_NAME).read_text(encoding="utf-8"))


class TestPathRules:
    def test_stem_keeps_the_id_and_a_readable_slug(self):
        assert stem("7", "Lab 1: Setup") == "7-lab-1-setup"
        assert stem("7", "!!!") == "7"

    @pytest.mark.parametrize("name", ["..", ".", "", "  "])
    def test_a_component_cannot_climb_out(self, name):
        assert safe_component(name) == "_"

    def test_a_slash_in_a_name_does_not_make_a_directory(self):
        assert safe_component("a/b\\c") == "a_b_c"

    def test_files_mirror_the_folder_without_the_course_files_root(self):
        assert file_path("course files/docs/week 1", "a.pdf") == PurePosixPath("files/docs/week 1/a.pdf")
        assert file_path("course files", "a.pdf") == PurePosixPath("files/a.pdf")
        assert file_path("course files/../..", "a.pdf") == PurePosixPath("files/_/_/a.pdf")

    def test_stale_paths_only_counts_kinds_that_were_listed(self):
        previous = [Pulled("pages", "a", "A", ["pages/a.json"]), Pulled("quizzes", "1", "Q", ["quizzes/1.json"])]
        assert stale_paths(previous, [], {"pages"}) == ["pages/a.json"]

    def test_a_file_is_current_only_at_the_same_size_and_time(self, tmp_path):
        dest = tmp_path / "f"
        dest.write_bytes(b"abc")
        os.utime(dest, (1000, 1000))
        assert is_current(dest, 3, 1000.0)
        assert not is_current(dest, 4, 1000.0)
        assert not is_current(dest, 3, 2000.0)
        assert not is_current(dest, 3, None)


class TestPull:
    def test_writes_every_kind_where_the_layout_says(self, tmp_path):
        canvas = _canvas()
        Puller(canvas, "42", tmp_path).run()

        for rel in [
            "course.json", "syllabus.html",
            "pages/week-1.json", "pages/week-1.html",
            "assignments/7-lab-1-setup.json", "assignments/7-lab-1-setup.html",
            "discussions/8-intro.json",
            "quizzes/9-quiz-1.json", "quizzes/9-quiz-1.html", "quizzes/9-quiz-1.questions.json",
            "modules.json", "assignment_groups.json", "rubrics.json",
            "folders.json", "files.json", "files/docs/notes.pdf",
        ]:
            assert (tmp_path / rel).is_file(), rel
        # An empty body is not worth a file.
        assert not (tmp_path / "discussions/8-intro.html").exists()
        assert (tmp_path / "assignments/7-lab-1-setup.html").read_text() == "<p>lab</p>"

    def test_modules_carry_their_items(self, tmp_path):
        Puller(_canvas(), "42", tmp_path).run()
        modules = json.loads((tmp_path / "modules.json").read_text())
        assert modules[0]["items"] == [{"id": 50, "type": "Page"}]

    def test_a_downloaded_file_takes_the_canvas_time_and_is_not_fetched_again(self, tmp_path):
        canvas = _canvas()
        first = Puller(canvas, "42", tmp_path)
        first.run()
        assert first.result.downloaded == 1

        second = Puller(canvas, "42", tmp_path)
        second.run()
        assert (second.result.downloaded, second.result.unchanged) == (0, 1)
        assert canvas.download_attachment.call_count == 1

    def test_a_second_pull_removes_what_canvas_no_longer_has(self, tmp_path):
        canvas = _canvas()
        Puller(canvas, "42", tmp_path).run()
        (tmp_path / "mine.txt").write_text("not the pull's")

        canvas.list_assignments.return_value = [{"id": 7, "name": "Lab 1: Renamed", "description": "x"}]
        canvas.list_pages.return_value = []
        puller = Puller(canvas, "42", tmp_path)
        puller.run()

        assert not (tmp_path / "assignments/7-lab-1-setup.json").exists()
        assert (tmp_path / "assignments/7-lab-1-renamed.json").exists()
        assert not (tmp_path / "pages/week-1.json").exists()
        assert (tmp_path / "mine.txt").exists()
        assert "pages/week-1.html" in puller.result.removed

    def test_a_failed_listing_keeps_the_last_snapshot_of_that_kind(self, tmp_path):
        canvas = _canvas()
        Puller(canvas, "42", tmp_path).run()

        canvas.list_quizzes.side_effect = RuntimeError("Canvas API error 404")
        puller = Puller(canvas, "42", tmp_path)
        puller.run()

        assert (tmp_path / "quizzes/9-quiz-1.json").exists()
        assert puller.result.errors == ["quizzes: Canvas API error 404"]
        kinds = [e["kind"] for e in _index(tmp_path)["entries"]]
        assert kinds.count("quizzes") == 1

    def test_a_failed_object_keeps_its_previous_copy(self, tmp_path):
        canvas = _canvas()
        Puller(canvas, "42", tmp_path).run()

        canvas.get_page.side_effect = RuntimeError("403")
        puller = Puller(canvas, "42", tmp_path)
        puller.run()

        assert (tmp_path / "pages/week-1.html").exists()
        assert puller.result.errors == ["pages Week 1: 403"]

    def test_a_dropped_connection_is_reported_not_raised(self, tmp_path):
        canvas = _canvas()
        canvas.download_attachment.side_effect = ConnectionError("reset")
        puller = Puller(canvas, "42", tmp_path)
        puller.run()
        assert puller.result.errors == ["files notes.pdf: reset"]

    def test_only_limits_the_pull_and_keeps_the_rest_of_the_index(self, tmp_path):
        canvas = _canvas()
        Puller(canvas, "42", tmp_path).run()
        canvas.reset_mock()

        Puller(canvas, "42", tmp_path, kinds=["pages"]).run()

        canvas.list_assignments.assert_not_called()
        canvas.list_files.assert_not_called()
        assert (tmp_path / "files/docs/notes.pdf").exists()
        kinds = [e["kind"] for e in _index(tmp_path)["entries"]]
        assert kinds.count("course") == 1
        assert kinds.count("syllabus") == 1
        assert "assignments" in kinds

    def test_an_unknown_kind_is_refused(self, tmp_path):
        with pytest.raises(PullError, match="unknown kind"):
            Puller(_canvas(), "42", tmp_path, kinds=["widgets"])

    def test_two_files_differing_only_in_case_do_not_collide(self, tmp_path):
        canvas = _canvas()
        canvas.list_files.return_value = [
            {"id": 1, "folder_id": 100, "display_name": "A.pdf", "size": 3, "url": "u1"},
            {"id": 2, "folder_id": 100, "display_name": "a.pdf", "size": 3, "url": "u2"},
        ]
        Puller(canvas, "42", tmp_path, kinds=["files"]).run()
        dests = [c.args[1] for c in canvas.download_attachment.call_args_list]
        assert dests == [tmp_path / "files/A.pdf", tmp_path / "files/2-a.pdf"]

    def test_a_tampered_index_cannot_delete_outside_the_snapshot(self, tmp_path):
        out = tmp_path / "snap"
        victim = tmp_path / "victim.txt"
        victim.write_text("keep")
        out.mkdir()
        (out / INDEX_NAME).write_text(json.dumps({
            "entries": [{"kind": "pages", "ident": "x", "title": "x", "paths": ["../victim.txt"]}],
        }))
        Puller(_canvas(), "42", out, kinds=["pages"]).run()
        assert victim.exists()
