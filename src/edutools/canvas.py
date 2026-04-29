import os
import re
import requests
from datetime import datetime, timezone


# Pattern to extract the "next" URL from the Link header.
# Canvas returns: <https://...?page=2&per_page=100>; rel="next", ...
_LINK_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="next"')


class CanvasLMS():
    def __init__(self):
        token = os.getenv("CANVAS_TOKEN")
        if not token:
            raise ValueError(
                "CANVAS_TOKEN not set. Add your token to ~/.config/edutools/config.toml [canvas] section."
            )
        self.endpoint = os.getenv("CANVAS_ENDPOINT", "https://boisestatecanvas.instructure.com")
        self.headers = {"Authorization": f"Bearer {token}"}

    _TIMEOUT = 30  # seconds

    def _get_paginated(self, url_path: str, params: dict[str, str | int]) -> list[dict[str, object]]:
        """Fetch all pages of a paginated Canvas API endpoint."""
        url: str | None = self.endpoint + url_path
        params = {**params, "per_page": 100}
        all_results: list[dict[str, object]] = []

        while url is not None:
            response = requests.get(url, params=params, headers=self.headers, timeout=self._TIMEOUT)
            if not response.ok:
                raise RuntimeError(f"Canvas API error {response.status_code}: {response.text}")
            all_results.extend(response.json())

            # After the first request, params are baked into the next URL.
            params = {}

            link_header = response.headers.get("Link", "")
            match = _LINK_NEXT_RE.search(link_header)
            url = match.group(1) if match else None

        return all_results

    def _get_single(self, url_path: str, params: dict[str, str | int]) -> dict[str, object]:
        """Fetch a single Canvas API resource (no pagination)."""
        response = requests.get(self.endpoint + url_path, params=params, headers=self.headers, timeout=self._TIMEOUT)
        if not response.ok:
            raise RuntimeError(f"Canvas API error {response.status_code}: {response.text}")
        result: dict[str, object] = response.json()
        return result

    def get_courses(self, *, include_all: bool = False) -> list[dict[str, object]]:
        params: dict[str, str | int] = {
            "enrollment_type": "teacher",
            "include[]": "term",
        }
        if not include_all:
            params["state[]"] = "available"
        courses = self._get_paginated("/api/v1/courses", params)
        if include_all:
            return courses
        now = datetime.now(timezone.utc)
        active: list[dict[str, object]] = []
        for c in courses:
            if c.get("workflow_state") != "available":
                continue
            term = c.get("term")
            end = term.get("end_at") if isinstance(term, dict) else None
            if end and datetime.fromisoformat(end) < now:
                continue
            active.append(c)
        return active

    def get_course(self, course_id: str) -> dict[str, object]:
        """Fetch a single course by ID."""
        return self._get_single(f"/api/v1/courses/{course_id}", {})

    def get_assignments(self, course_id: str) -> list[dict[str, object]]:
        return self._get_paginated(f"/api/v1/courses/{course_id}/assignments", {})

    def get_students(self, course_id: str) -> list[dict[str, object]]:
        return self._get_paginated(f"/api/v1/courses/{course_id}/users", {"enrollment_type[]": "student"})

    def get_submissions(self, course_id: str, assignment_id: str) -> list[dict[str, object]]:
        return self._get_paginated(
            f"/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions", {}
        )

    def get_assignment(self, course_id: str, assignment_id: str) -> dict[str, object]:
        return self._get_single(f"/api/v1/courses/{course_id}/assignments/{assignment_id}/", {})

    def get_ungraded_submissions(self, course_id: str) -> list[dict[str, object]]:
        """Return all submissions whose grade is unset (the '-' in the Canvas gradebook)."""
        submissions = self._get_paginated(
            f"/api/v1/courses/{course_id}/students/submissions",
            {"student_ids[]": "all"},
        )
        return [s for s in submissions if s.get("grade") is None]
