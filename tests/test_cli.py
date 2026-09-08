"""End-to-end checks on the single-object and grading commands.

These drive the real typer app and stop at the Canvas client, so they cover the
wiring between a flag and the form body Canvas would receive.
"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from edutools.cli import app

runner = CliRunner()


@pytest.fixture(autouse=True)
def _token(monkeypatch, tmp_path):
    """A token, and a config dir that is not the developer's own."""
    monkeypatch.setenv("CANVAS_TOKEN", "tok")
    monkeypatch.setattr("edutools.cli.CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setattr("edutools.cli.CONFIG_FILE", str(tmp_path / "config" / "config.toml"))


@pytest.fixture
def canvas():
    """Patch the client class so nothing reaches the network."""
    client = MagicMock()
    with patch("edutools.canvas.CanvasLMS", return_value=client):
        yield client


class TestCreate:
    def test_create_assignment_sends_the_assignment_field_names(self, canvas):
        canvas.create_object.return_value = {"id": 42, "name": "Lab 7"}
        result = runner.invoke(app, [
            "create", "assignment", "-c", "123", "--title", "Lab 7",
            "--points", "50", "--due", "2026-10-14T23:59:00-06:00",
            "--body", "<p>do it</p>",
        ])

        assert result.exit_code == 0, result.output
        kind, course_id, fields = canvas.create_object.call_args[0]
        assert (kind, course_id) == ("assignment", "123")
        assert fields == {
            "assignment[name]": "Lab 7",
            "assignment[description]": "<p>do it</p>",
            "assignment[points_possible]": "50",
            "assignment[due_at]": "2026-10-14T23:59:00-06:00",
            "assignment[published]": "false",
        }

    def test_create_defaults_to_unpublished(self, canvas):
        canvas.create_object.return_value = {"id": 42}
        result = runner.invoke(app, ["create", "page", "-c", "123", "--title", "Week 1"])

        assert canvas.create_object.call_args[0][2]["wiki_page[published]"] == "false"
        assert "Unpublished" in result.output

    def test_publish_flag_makes_it_visible(self, canvas):
        canvas.create_object.return_value = {"id": 42}
        runner.invoke(app, ["create", "page", "-c", "123", "--title", "Week 1", "--publish"])

        assert canvas.create_object.call_args[0][2]["wiki_page[published]"] == "true"

    def test_set_reaches_a_field_with_no_flag(self, canvas):
        canvas.create_object.return_value = {"id": 42}
        runner.invoke(app, [
            "create", "assignment", "-c", "123", "--title", "Lab 7",
            "--set", "assignment[submission_types][]=online_upload",
        ])

        fields = canvas.create_object.call_args[0][2]
        assert fields["assignment[submission_types][]"] == "online_upload"

    def test_a_title_is_required(self, canvas):
        result = runner.invoke(app, ["create", "assignment", "-c", "123"])

        assert result.exit_code == 1
        assert "needs --title" in result.output
        canvas.create_object.assert_not_called()

    def test_body_and_body_file_are_mutually_exclusive(self, canvas, tmp_path):
        path = tmp_path / "b.html"
        path.write_text("<p>x</p>", encoding="utf-8")
        result = runner.invoke(app, [
            "create", "page", "-c", "123", "-t", "T", "--body", "x", "--body-file", str(path),
        ])

        assert result.exit_code == 1
        assert "not both" in result.output

    def test_a_non_markdown_body_file_is_sent_verbatim(self, canvas, tmp_path):
        canvas.create_object.return_value = {"id": 42}
        path = tmp_path / "b.html"
        path.write_text("<p>raw</p>", encoding="utf-8")
        runner.invoke(app, ["create", "page", "-c", "123", "-t", "T", "-f", str(path)])

        assert canvas.create_object.call_args[0][2]["wiki_page[body]"] == "<p>raw</p>"

    def test_a_missing_body_file_is_reported(self, canvas, tmp_path):
        result = runner.invoke(app, [
            "create", "page", "-c", "123", "-t", "T", "-f", str(tmp_path / "gone.md"),
        ])

        assert result.exit_code == 1
        assert "No such file" in result.output


class TestUpdate:
    def test_only_the_named_fields_are_sent(self, canvas):
        canvas.update_object.return_value = {"id": 42, "name": "Lab 7"}
        result = runner.invoke(app, ["update", "assignment", "42", "-c", "123", "--points", "40"])

        assert result.exit_code == 0, result.output
        kind, course_id, object_id, fields = canvas.update_object.call_args[0]
        assert (kind, course_id, object_id) == ("assignment", "123", "42")
        assert fields == {"assignment[points_possible]": "40"}

    def test_an_empty_update_is_refused(self, canvas):
        result = runner.invoke(app, ["update", "assignment", "42", "-c", "123"])

        assert result.exit_code == 1
        assert "Nothing to update" in result.output
        canvas.update_object.assert_not_called()


class TestPublishUnpublish:
    def test_publish_sets_only_the_published_field(self, canvas):
        canvas.update_object.return_value = {"id": 42, "name": "Lab 7"}
        result = runner.invoke(app, ["publish", "assignment", "42", "-c", "123"])

        assert result.exit_code == 0, result.output
        assert canvas.update_object.call_args[0][3] == {"assignment[published]": "true"}

    def test_unpublish_addresses_a_page_by_slug(self, canvas):
        canvas.update_object.return_value = {"url": "week-1", "title": "Week 1"}
        runner.invoke(app, ["unpublish", "page", "week-1", "-c", "123"])

        _, _, object_id, fields = canvas.update_object.call_args[0]
        assert object_id == "week-1"
        assert fields == {"wiki_page[published]": "false"}


class TestDelete:
    def test_it_reads_the_object_and_asks_first(self, canvas):
        canvas.get_object.return_value = {"id": 42, "name": "Lab 7"}
        result = runner.invoke(app, ["delete", "assignment", "42", "-c", "123"], input="n\n")

        assert "Lab 7" in result.output
        assert "submissions and grades" in result.output
        canvas.delete_object.assert_not_called()

    def test_confirming_deletes(self, canvas):
        canvas.get_object.return_value = {"id": 42, "name": "Lab 7"}
        canvas.delete_object.return_value = {"id": 42}
        result = runner.invoke(app, ["delete", "assignment", "42", "-c", "123"], input="y\n")

        assert result.exit_code == 0, result.output
        assert canvas.delete_object.call_args[0] == ("assignment", "123", "42")

    def test_yes_skips_the_prompt(self, canvas):
        canvas.get_object.return_value = {"id": 42, "name": "Lab 7"}
        canvas.delete_object.return_value = {"id": 42}
        runner.invoke(app, ["delete", "assignment", "42", "-c", "123", "--yes"])

        canvas.delete_object.assert_called_once()

    def test_an_unreadable_object_is_never_deleted(self, canvas):
        canvas.get_object.side_effect = RuntimeError("Canvas API error 404")
        result = runner.invoke(app, ["delete", "assignment", "42", "-c", "123", "--yes"])

        assert result.exit_code == 1
        canvas.delete_object.assert_not_called()


class TestGrade:
    def test_one_student_with_a_score_and_a_comment(self, canvas):
        canvas.grade_submission.return_value = {"grade": "18"}
        result = runner.invoke(app, [
            "grade", "-c", "123", "-a", "456", "-s", "789",
            "--score", "18", "--comment", "Clean tests.",
        ])

        assert result.exit_code == 0, result.output
        args, kwargs = canvas.grade_submission.call_args
        assert args == ("123", "456", "789")
        assert kwargs["grade"] == "18"
        assert kwargs["comment"] == "Clean tests."

    def test_a_comment_file_becomes_the_comment(self, canvas, tmp_path):
        canvas.grade_submission.return_value = {}
        path = tmp_path / "feedback.md"
        path.write_text("Long feedback.\n", encoding="utf-8")
        runner.invoke(app, [
            "grade", "-c", "123", "-a", "456", "-s", "789", "--comment-file", str(path),
        ])

        assert canvas.grade_submission.call_args.kwargs["comment"] == "Long feedback."

    def test_a_batch_grades_every_row(self, canvas, tmp_path):
        canvas.grade_submission.return_value = {"grade": "18"}
        path = tmp_path / "grades.json"
        path.write_text(json.dumps([
            {"student": 555, "score": 18, "comment": "Good."},
            {"student": 556, "excuse": True},
        ]), encoding="utf-8")
        result = runner.invoke(app, ["grade", "-c", "123", "-a", "456", "--from-file", str(path)])

        assert result.exit_code == 0, result.output
        assert canvas.grade_submission.call_count == 2
        assert canvas.grade_submission.call_args_list[1].kwargs["excuse"] is True

    def test_dry_run_writes_nothing(self, canvas, tmp_path):
        path = tmp_path / "grades.json"
        path.write_text('[{"student": 555, "score": 18}]', encoding="utf-8")
        result = runner.invoke(app, [
            "grade", "-c", "123", "-a", "456", "--from-file", str(path), "--dry-run",
        ])

        assert result.exit_code == 0
        assert "nothing written" in result.output
        canvas.grade_submission.assert_not_called()

    def test_a_failed_row_is_reported_and_exits_non_zero(self, canvas, tmp_path):
        canvas.grade_submission.side_effect = [
            {"grade": "18"},
            RuntimeError("Canvas API error 404: no such user"),
        ]
        path = tmp_path / "grades.json"
        path.write_text(json.dumps([
            {"student": 555, "score": 18},
            {"student": 999, "score": 18},
        ]), encoding="utf-8")
        result = runner.invoke(app, ["grade", "-c", "123", "-a", "456", "--from-file", str(path)])

        assert result.exit_code == 1
        assert "user 999" in result.output
        # The first row still went through; a batch is not all-or-nothing.
        assert canvas.grade_submission.call_count == 2

    def test_student_and_from_file_are_mutually_exclusive(self, canvas, tmp_path):
        path = tmp_path / "grades.json"
        path.write_text('[{"student": 555, "score": 1}]', encoding="utf-8")
        result = runner.invoke(app, [
            "grade", "-c", "123", "-a", "456", "-s", "789", "--from-file", str(path),
        ])

        assert result.exit_code == 1
        assert "not both" in result.output

    def test_a_csv_batch_is_inferred_from_the_filename(self, canvas, tmp_path):
        canvas.grade_submission.return_value = {"grade": "18"}
        path = tmp_path / "grades.csv"
        path.write_text("student_id,score,comment\n555,18,Good.\n", encoding="utf-8")
        result = runner.invoke(app, ["grade", "-c", "123", "-a", "456", "--from-file", str(path)])

        assert result.exit_code == 0, result.output
        assert canvas.grade_submission.call_args.kwargs["grade"] == "18"


class TestDownload:
    def test_it_writes_text_and_attachments_per_student(self, canvas, tmp_path):
        canvas.get_submissions.return_value = [
            {
                "user_id": 555,
                "body": "my answer",
                "attachments": [
                    {"id": 1, "display_name": "main.py", "size": 5, "url": "https://f.test/1"}
                ],
            },
            {"user_id": 556, "body": None, "attachments": []},
        ]
        canvas.download_attachment.return_value = 5
        out = tmp_path / "subs"
        result = runner.invoke(app, [
            "download", "-c", "123", "-a", "456", "--out", str(out),
        ])

        assert result.exit_code == 0, result.output
        assert (out / "555" / "submission.txt").read_text(encoding="utf-8") == "my answer"
        assert canvas.download_attachment.call_args[0][0] == "https://f.test/1"

    def test_an_already_downloaded_file_is_left_alone(self, canvas, tmp_path):
        out = tmp_path / "subs"
        (out / "555").mkdir(parents=True)
        (out / "555" / "main.py").write_bytes(b"abcde")
        canvas.get_submissions.return_value = [{
            "user_id": 555,
            "attachments": [
                {"id": 1, "display_name": "main.py", "size": 5, "url": "https://f.test/1"}
            ],
        }]
        result = runner.invoke(app, ["download", "-c", "123", "-a", "456", "--out", str(out)])

        assert "already present" in result.output
        canvas.download_attachment.assert_not_called()

    def test_only_one_student_when_asked(self, canvas, tmp_path):
        canvas.get_submissions.return_value = [
            {"user_id": 555, "body": "a", "attachments": []},
            {"user_id": 556, "body": "b", "attachments": []},
        ]
        out = tmp_path / "subs"
        runner.invoke(app, ["download", "-c", "123", "-a", "456", "-s", "556", "--out", str(out)])

        assert (out / "556").exists()
        assert not (out / "555").exists()


class TestShowSubmission:
    def test_json_emits_the_raw_payload(self, canvas):
        canvas.get_submission.return_value = {"user_id": 789, "grade": "18"}
        result = runner.invoke(app, [
            "submission", "-c", "123", "-a", "456", "-s", "789", "--json",
        ])

        assert result.exit_code == 0, result.output
        assert json.loads(result.output) == {"user_id": 789, "grade": "18"}

    def test_the_table_shows_comments_and_attachments(self, canvas):
        canvas.get_submission.return_value = {
            "user_id": 789,
            "user": {"name": "Pat Doe"},
            "grade": "18",
            "score": 18,
            "workflow_state": "graded",
            "attachments": [{"id": 1, "display_name": "main.py", "size": 12}],
            "submission_comments": [
                {"created_at": "2026-09-01", "author_name": "Shane", "comment": "Nice."}
            ],
        }
        result = runner.invoke(app, ["submission", "-c", "123", "-a", "456", "-s", "789"])

        assert result.exit_code == 0, result.output
        assert "Pat Doe" in result.output
        assert "main.py" in result.output
        assert "Nice." in result.output


def test_no_token_still_reaches_the_command(monkeypatch, canvas):
    """A missing token prints setup help; it must not crash before that."""
    monkeypatch.delenv("CANVAS_TOKEN", raising=False)
    canvas.update_object.return_value = {"id": 42}
    result = runner.invoke(app, ["publish", "assignment", "42", "-c", "123"])

    assert "not configured" in result.output
    assert os.environ.get("CANVAS_TOKEN") is None
