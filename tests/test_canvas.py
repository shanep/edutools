import os
import pytest
from unittest.mock import patch, MagicMock
from edutools.canvas import CanvasLMS


def _mock_response(ok=True, status_code=200, text="[]", json_data=None):
    """Build a mock requests.Response with a real headers dict."""
    mock = MagicMock()
    mock.ok = ok
    mock.status_code = status_code
    mock.text = text
    mock.headers = {}  # real dict so response.headers.get("Link", "") works
    mock.json.return_value = json_data if json_data is not None else []
    return mock


class TestCanvasLMSInitialization:
    """Test CanvasLMS initialization"""

    def test_init_with_valid_env_vars(self):
        """Test successful initialization with valid environment variables"""
        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token_123"}, clear=True):
            canvas = CanvasLMS()
            assert canvas.headers["Authorization"] == "Bearer test_token_123"

    def test_init_missing_token(self):
        """Test initialization fails without CANVAS_TOKEN"""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="CANVAS_TOKEN not set"):
                CanvasLMS()

    def test_init_empty_token(self):
        """Test initialization fails with empty CANVAS_TOKEN"""
        with patch.dict(os.environ, {"CANVAS_TOKEN": ""}, clear=True):
            with pytest.raises(ValueError, match="CANVAS_TOKEN not set"):
                CanvasLMS()

    def test_init_custom_endpoint(self):
        """Test that CANVAS_ENDPOINT overrides the default"""
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok", "CANVAS_ENDPOINT": "https://custom.example.com"}):
            canvas = CanvasLMS()
            assert canvas.endpoint == "https://custom.example.com"

    def test_init_default_endpoint(self):
        """Test that a default endpoint is used when CANVAS_ENDPOINT is not set"""
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok"}, clear=True):
            canvas = CanvasLMS()
            assert canvas.endpoint  # default is set


class TestCanvasLMSGetCourses:
    """Test get_courses method"""

    @patch("edutools.canvas.requests.get")
    def test_get_courses_success(self, mock_get):
        """Test successful retrieval of courses"""
        mock_get.return_value = _mock_response(
            json_data=[{"id": 1, "name": "Course 1"}, {"id": 2, "name": "Course 2"}]
        )

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            courses = canvas.get_courses(include_all=True)

            assert len(courses) == 2
            assert courses[0]["id"] == 1
            assert courses[1]["name"] == "Course 2"

    @patch("edutools.canvas.requests.get")
    def test_get_courses_empty(self, mock_get):
        """Test get_courses when no courses available"""
        mock_get.return_value = _mock_response(json_data=[])

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            courses = canvas.get_courses(include_all=True)
            assert courses == []

    @patch("edutools.canvas.requests.get")
    def test_get_courses_api_failure(self, mock_get):
        """Test get_courses when API returns error"""
        mock_get.return_value = _mock_response(ok=False, status_code=401, text="Unauthorized")

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            with pytest.raises(RuntimeError, match="Canvas API error 401"):
                canvas.get_courses()


class TestCanvasLMSGetAssignments:
    """Test get_assignments method"""

    @patch("edutools.canvas.requests.get")
    def test_get_assignments_success(self, mock_get):
        """Test successful retrieval of assignments"""
        mock_get.return_value = _mock_response(
            json_data=[{"id": 1, "name": "Assignment 1"}, {"id": 2, "name": "Assignment 2"}]
        )

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            assignments = canvas.get_assignments("123")

            assert len(assignments) == 2
            assert assignments[0]["id"] == 1
            assert assignments[1]["name"] == "Assignment 2"

    @patch("edutools.canvas.requests.get")
    def test_get_assignments_empty(self, mock_get):
        """Test get_assignments when no assignments exist"""
        mock_get.return_value = _mock_response(json_data=[])

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            assignments = canvas.get_assignments("123")
            assert assignments == []

    @patch("edutools.canvas.requests.get")
    def test_get_assignments_api_failure(self, mock_get):
        """Test get_assignments when API returns error"""
        mock_get.return_value = _mock_response(ok=False, status_code=404, text="Not Found")

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            with pytest.raises(RuntimeError, match="Canvas API error 404"):
                canvas.get_assignments("123")


class TestCanvasLMSGetStudents:
    """Test get_students method"""

    @patch("edutools.canvas.requests.get")
    def test_get_students_success(self, mock_get):
        """Test successful retrieval of students"""
        mock_get.return_value = _mock_response(
            json_data=[{"id": 1, "name": "Student 1"}, {"id": 2, "name": "Student 2"}]
        )

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            students = canvas.get_students("123")

            assert len(students) == 2
            assert students[0]["id"] == 1
            assert students[1]["name"] == "Student 2"

    @patch("edutools.canvas.requests.get")
    def test_get_students_empty(self, mock_get):
        """Test get_students when no students enrolled"""
        mock_get.return_value = _mock_response(json_data=[])

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            students = canvas.get_students("123")
            assert students == []

    @patch("edutools.canvas.requests.get")
    def test_get_students_api_failure(self, mock_get):
        """Test get_students when API returns error"""
        mock_get.return_value = _mock_response(ok=False, status_code=403, text="Forbidden")

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            with pytest.raises(RuntimeError, match="Canvas API error 403"):
                canvas.get_students("123")


class TestCanvasLMSGetSubmissions:
    """Test get_submissions method"""

    @patch("edutools.canvas.requests.get")
    def test_get_submissions_success(self, mock_get):
        """Test successful retrieval of submissions"""
        mock_get.return_value = _mock_response(
            json_data=[{"id": 1, "user_id": 101}, {"id": 2, "user_id": 102}]
        )

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            submissions = canvas.get_submissions("123", "456")

            assert len(submissions) == 2
            assert submissions[0]["id"] == 1
            assert submissions[1]["user_id"] == 102

    @patch("edutools.canvas.requests.get")
    def test_get_submissions_empty(self, mock_get):
        """Test get_submissions when no submissions exist"""
        mock_get.return_value = _mock_response(json_data=[])

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            submissions = canvas.get_submissions("123", "456")
            assert submissions == []

    @patch("edutools.canvas.requests.get")
    def test_get_submissions_api_failure(self, mock_get):
        """Test get_submissions when API returns error"""
        mock_get.return_value = _mock_response(ok=False, status_code=500, text="Internal Server Error")

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            with pytest.raises(RuntimeError, match="Canvas API error 500"):
                canvas.get_submissions("123", "456")


class TestCanvasLMSGetAssignment:
    """Test get_assignment method"""

    @patch("edutools.canvas.requests.get")
    def test_get_assignment_success(self, mock_get):
        """Test successful retrieval of single assignment"""
        mock_get.return_value = _mock_response(
            json_data={"id": 456, "name": "Final Project", "due_at": "2024-12-15"}
        )
        mock_get.return_value.json.return_value = {"id": 456, "name": "Final Project", "due_at": "2024-12-15"}

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            assignment = canvas.get_assignment("123", "456")

            assert assignment["id"] == 456
            assert assignment["name"] == "Final Project"
            assert assignment["due_at"] == "2024-12-15"

    @patch("edutools.canvas.requests.get")
    def test_get_assignment_not_found(self, mock_get):
        """Test get_assignment when assignment doesn't exist"""
        mock_get.return_value = _mock_response(ok=False, status_code=404, text="Not Found")

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            with pytest.raises(RuntimeError, match="Canvas API error 404"):
                canvas.get_assignment("123", "999")

    @patch("edutools.canvas.requests.get")
    def test_get_assignment_api_failure(self, mock_get):
        """Test get_assignment when API returns error"""
        mock_get.return_value = _mock_response(ok=False, status_code=500, text="Internal Server Error")

        with patch.dict(os.environ, {"CANVAS_TOKEN": "test_token"}):
            canvas = CanvasLMS()
            with pytest.raises(RuntimeError, match="Canvas API error 500"):
                canvas.get_assignment("123", "456")


class TestCanvasLMSHeaders:
    """Test that authorization headers are properly set"""

    @patch("edutools.canvas.requests.get")
    def test_headers_sent_with_requests(self, mock_get):
        """Test that authorization headers are sent with API requests"""
        mock_get.return_value = _mock_response(json_data=[])

        with patch.dict(os.environ, {"CANVAS_TOKEN": "secret_token_xyz"}):
            canvas = CanvasLMS()
            canvas.get_courses(include_all=True)

            call_args = mock_get.call_args
            assert "headers" in call_args[1]
            assert call_args[1]["headers"]["Authorization"] == "Bearer secret_token_xyz"


class TestKindPaths:
    """Kind -> path segment, the only per-kind difference in the generic CRUD."""

    def test_every_kind_maps_to_its_collection(self):
        from edutools.canvas import kind_path

        assert kind_path("page") == "pages"
        assert kind_path("assignment") == "assignments"
        assert kind_path("discussion") == "discussion_topics"
        assert kind_path("quiz") == "quizzes"
        assert kind_path("module") == "modules"

    def test_unknown_kind_names_the_valid_ones(self):
        from edutools.canvas import kind_path

        with pytest.raises(ValueError, match="unknown Canvas kind 'rubric'"):
            kind_path("rubric")


class TestObjectCrud:
    """create/get/update/delete over any kind."""

    @patch("edutools.canvas.requests.request")
    def test_create_posts_to_the_kinds_collection(self, mock_request):
        mock_request.return_value = _mock_response(json_data={"id": 42})
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok", "CANVAS_ENDPOINT": "https://c.test"}):
            result = CanvasLMS().create_object("assignment", "123", {"assignment[name]": "Lab 1"})

        assert result == {"id": 42}
        method, url = mock_request.call_args[0]
        assert method == "POST"
        assert url == "https://c.test/api/v1/courses/123/assignments"
        assert mock_request.call_args.kwargs["data"] == {"assignment[name]": "Lab 1"}

    @patch("edutools.canvas.requests.request")
    def test_update_puts_to_the_object(self, mock_request):
        mock_request.return_value = _mock_response(json_data={"id": 42})
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok", "CANVAS_ENDPOINT": "https://c.test"}):
            CanvasLMS().update_object("quiz", "123", "42", {"quiz[published]": "true"})

        method, url = mock_request.call_args[0]
        assert method == "PUT"
        assert url == "https://c.test/api/v1/courses/123/quizzes/42"

    @patch("edutools.canvas.requests.request")
    def test_delete_addresses_a_page_by_its_slug(self, mock_request):
        mock_request.return_value = _mock_response(json_data={"url": "week-1"})
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok", "CANVAS_ENDPOINT": "https://c.test"}):
            result = CanvasLMS().delete_object("page", "123", "week-1")

        method, url = mock_request.call_args[0]
        assert method == "DELETE"
        assert url == "https://c.test/api/v1/courses/123/pages/week-1"
        # Canvas answers a delete with the object, which is the only record of it.
        assert result == {"url": "week-1"}

    @patch("edutools.canvas.requests.request")
    def test_a_failed_delete_raises(self, mock_request):
        mock_request.return_value = _mock_response(ok=False, status_code=404, text="not found")
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok"}):
            with pytest.raises(RuntimeError, match="404"):
                CanvasLMS().delete_object("assignment", "123", "999")

    @patch("edutools.canvas.requests.request")
    def test_file_delete_leaves_the_course_namespace(self, mock_request):
        mock_request.return_value = _mock_response(json_data={"id": 7})
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok", "CANVAS_ENDPOINT": "https://c.test"}):
            CanvasLMS().delete_file("7")

        assert mock_request.call_args[0][1] == "https://c.test/api/v1/files/7"


class TestGradeSubmission:
    """Score and feedback ride the same endpoint, under different parameters."""

    def _canvas(self):
        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok", "CANVAS_ENDPOINT": "https://c.test"}):
            return CanvasLMS()

    @patch("edutools.canvas.requests.request")
    def test_grade_and_comment_together(self, mock_request):
        mock_request.return_value = _mock_response(json_data={"grade": "18"})
        self._canvas().grade_submission("123", "456", "789", grade="18", comment="Clean tests.")

        method, url = mock_request.call_args[0]
        assert method == "PUT"
        assert url == "https://c.test/api/v1/courses/123/assignments/456/submissions/789"
        assert mock_request.call_args.kwargs["data"] == {
            "submission[posted_grade]": "18",
            "comment[text_comment]": "Clean tests.",
        }

    @patch("edutools.canvas.requests.request")
    def test_a_comment_alone_leaves_the_submission_ungraded(self, mock_request):
        mock_request.return_value = _mock_response(json_data={})
        self._canvas().grade_submission("123", "456", "789", comment="See notes.")

        data = mock_request.call_args.kwargs["data"]
        assert data == {"comment[text_comment]": "See notes."}
        assert "submission[posted_grade]" not in data

    @patch("edutools.canvas.requests.request")
    def test_group_comment_is_opt_in(self, mock_request):
        mock_request.return_value = _mock_response(json_data={})
        self._canvas().grade_submission("123", "456", "789", comment="hi", group_comment=True)

        assert mock_request.call_args.kwargs["data"]["comment[group_comment]"] == "true"

    @patch("edutools.canvas.requests.request")
    def test_excuse_and_late_policy(self, mock_request):
        mock_request.return_value = _mock_response(json_data={})
        self._canvas().grade_submission(
            "123", "456", "789", excuse=True, late_policy_status="late", seconds_late_override=3600
        )

        assert mock_request.call_args.kwargs["data"] == {
            "submission[excuse]": "true",
            "submission[late_policy_status]": "late",
            "submission[seconds_late_override]": "3600",
        }

    @patch("edutools.canvas.requests.request")
    def test_rubric_assessment_is_flattened_per_criterion(self, mock_request):
        mock_request.return_value = _mock_response(json_data={})
        self._canvas().grade_submission(
            "123", "456", "789",
            rubric_assessment={"crit_1": {"points": 4, "comments": "Good design."}},
        )

        assert mock_request.call_args.kwargs["data"] == {
            "rubric_assessment[crit_1][points]": "4",
            "rubric_assessment[crit_1][comments]": "Good design.",
        }

    def test_an_empty_call_is_refused_before_it_reaches_canvas(self):
        with pytest.raises(ValueError, match="at least a grade"):
            self._canvas().grade_submission("123", "456", "789")

    @patch("edutools.canvas.requests.request")
    def test_get_submission_repeats_the_include_parameter(self, mock_request):
        mock_request.return_value = _mock_response(json_data={"user_id": 789})
        self._canvas().get_submission("123", "456", "789", include=("submission_comments",))

        assert mock_request.call_args.kwargs["params"] == [("include[]", "submission_comments")]

    @patch("edutools.canvas.requests.request")
    def test_get_submission_reports_a_failure(self, mock_request):
        mock_request.return_value = _mock_response(ok=False, status_code=401, text="nope")
        with pytest.raises(RuntimeError, match="401"):
            self._canvas().get_submission("123", "456", "789")


class TestDownloadAttachment:
    @patch("edutools.canvas.requests.get")
    def test_streams_to_disk_and_reports_the_size(self, mock_get, tmp_path):
        from pathlib import Path

        response = MagicMock()
        response.ok = True
        response.iter_content.return_value = [b"abc", b"de"]
        response.__enter__ = lambda self: self
        response.__exit__ = lambda self, *args: False
        mock_get.return_value = response

        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok"}):
            dest = Path(tmp_path) / "nested" / "main.py"
            written = CanvasLMS().download_attachment("https://files.test/x", dest)

        assert written == 5
        assert dest.read_bytes() == b"abcde"

    @patch("edutools.canvas.requests.get")
    def test_a_failed_download_raises(self, mock_get, tmp_path):
        from pathlib import Path

        response = MagicMock()
        response.ok = False
        response.status_code = 403
        response.__enter__ = lambda self: self
        response.__exit__ = lambda self, *args: False
        mock_get.return_value = response

        with patch.dict(os.environ, {"CANVAS_TOKEN": "tok"}):
            with pytest.raises(RuntimeError, match="403"):
                CanvasLMS().download_attachment("https://files.test/x", Path(tmp_path) / "x.py")
