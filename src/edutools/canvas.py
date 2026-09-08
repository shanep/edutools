import os
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# What `requests` accepts for a form body: a flat mapping, or repeated keys as
# tuples (Canvas uses those for question[answers][][answer_text]).
RequestData = dict[str, str] | list[tuple[str, str]] | None
# Query parameters, as a mapping or as repeated keys (include[]=a&include[]=b).
RequestParams = dict[str, str | int] | list[tuple[str, str]] | None

# A rubric assessment: criterion id -> {"points": 4, "comments": "...", "rating_id": "..."}
RubricAssessment = dict[str, dict[str, str | float]]


# Pattern to extract the "next" URL from the Link header.
# Canvas returns: <https://...?page=2&per_page=100>; rel="next", ...
_LINK_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="next"')

# Canvas object kind -> the collection segment of its course-scoped path.
KIND_PATHS: dict[str, str] = {
    "page": "pages",
    "assignment": "assignments",
    "discussion": "discussion_topics",
    "quiz": "quizzes",
    "module": "modules",
}


def kind_path(kind: str) -> str:
    """Path segment for a Canvas object kind."""
    try:
        return KIND_PATHS[kind]
    except KeyError:
        raise ValueError(
            f"unknown Canvas kind {kind!r}; expected one of {', '.join(KIND_PATHS)}"
        ) from None


def as_number(value: object) -> float:
    """Coerce a value out of a Canvas payload to a number, 0 if it is not one.

    Canvas JSON is typed `object` on the way in, and it is not consistent about
    whether a weight or a position comes back as a number or as a string.
    """
    if value is None or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


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

    # ------------------------------------------------------------------
    # Write half: retrying request layer + typed resource methods.
    #
    # Canvas throttles with 429 and reports quota in X-Rate-Limit-Remaining.
    # Sequential requests rarely trip it; parallel ones take a pre-flight
    # penalty, so everything here is deliberately sequential.
    # ------------------------------------------------------------------

    _RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})
    _MAX_ATTEMPTS = 5
    _UPLOAD_TIMEOUT = 300  # seconds; the CyBOK PDF is 21 MB

    def _sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def _request(
        self,
        method: str,
        url: str,
        *,
        data: RequestData = None,
        params: RequestParams = None,
        absolute: bool = False,
        timeout: int | None = None,
        allow_redirects: bool = True,
    ) -> requests.Response:
        """Issue one Canvas request, retrying transient failures."""
        target = url if absolute else self.endpoint + url
        last_error: str = ""
        for attempt in range(1, self._MAX_ATTEMPTS + 1):
            try:
                response = requests.request(
                    method,
                    target,
                    data=data,
                    params=params,
                    headers=self.headers,
                    timeout=timeout or self._TIMEOUT,
                    allow_redirects=allow_redirects,
                )
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt == self._MAX_ATTEMPTS:
                    break
                self._sleep(min(2 ** attempt, 30) + random.uniform(0, 0.5))
                continue

            if response.ok or response.status_code not in self._RETRY_STATUS:
                return response

            last_error = f"HTTP {response.status_code}: {response.text[:200]}"
            if attempt == self._MAX_ATTEMPTS:
                break
            # Honour the throttle rather than hammering it.
            backoff = min(2 ** attempt, 30) + random.uniform(0, 0.5)
            if response.status_code == 429:
                backoff = max(backoff, 5.0)
            self._sleep(backoff)

        raise RuntimeError(
            f"Canvas API error after {self._MAX_ATTEMPTS} attempts "
            f"({method} {target}): {last_error}"
        )

    def _json(
        self,
        method: str,
        url_path: str,
        data: RequestData = None,
        params: dict[str, str | int] | None = None,
    ) -> dict[str, object]:
        response = self._request(method, url_path, data=data, params=params)
        if not response.ok:
            raise RuntimeError(f"Canvas API error {response.status_code}: {response.text}")
        result: dict[str, object] = response.json()
        return result

    def get_json(self, url_path: str, params: dict[str, str | int] | None = None) -> dict[str, object]:
        """GET a single resource, with retries. Used by the verify pass."""
        return self._json("GET", url_path, params=params)

    def list_json(self, url_path: str, params: dict[str, str | int] | None = None) -> list[dict[str, object]]:
        """GET a paginated collection, with retries."""
        url: str | None = self.endpoint + url_path
        merged: dict[str, str | int] = {**(params or {}), "per_page": 100}
        results: list[dict[str, object]] = []
        first = True
        while url is not None:
            response = self._request("GET", url, params=merged if first else None, absolute=True)
            if not response.ok:
                raise RuntimeError(f"Canvas API error {response.status_code}: {response.text}")
            results.extend(response.json())
            first = False
            match = _LINK_NEXT_RE.search(response.headers.get("Link", ""))
            url = match.group(1) if match else None
        return results

    def exists(self, url_path: str) -> bool:
        """True if the resource is present (a 404 is an answer, not an error)."""
        response = self._request("GET", url_path)
        return response.ok

    # -- course ---------------------------------------------------------

    def update_syllabus(self, course_id: str, body: str) -> dict[str, object]:
        return self._json("PUT", f"/api/v1/courses/{course_id}", data={"course[syllabus_body]": body})

    # -- assignment groups ----------------------------------------------

    def list_assignment_groups(
        self, course_id: str, *, with_assignments: bool = False
    ) -> list[dict[str, object]]:
        # Canvas leaves the assignments out of this payload unless asked, so a
        # caller counting what is in a group has to opt in or it counts zero.
        params: dict[str, str | int] | None = {"include[]": "assignments"} if with_assignments else None
        return self.list_json(f"/api/v1/courses/{course_id}/assignment_groups", params)

    def create_assignment_group(self, course_id: str, fields: dict[str, str]) -> dict[str, object]:
        # This endpoint takes bare parameters (name, position, group_weight),
        # not the assignment_group[...] bracket namespace the docs suggest.
        return self._json("POST", f"/api/v1/courses/{course_id}/assignment_groups", data=fields)

    def update_assignment_group(
        self, course_id: str, group_id: str, fields: dict[str, str]
    ) -> dict[str, object]:
        return self._json(
            "PUT", f"/api/v1/courses/{course_id}/assignment_groups/{group_id}", data=fields
        )

    def set_group_weighting(self, course_id: str, enabled: bool) -> dict[str, object]:
        """Weight the final grade by assignment group, or stop doing so.

        Canvas stores a group_weight on every group either way and ignores all of
        them until this course-level flag is on, so a course that sets weights and
        not this reads as if the weights never took.
        """
        return self._json(
            "PUT",
            f"/api/v1/courses/{course_id}",
            data={"course[apply_assignment_group_weights]": str(enabled).lower()},
        )

    # -- pages ----------------------------------------------------------

    def list_pages(self, course_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/pages")

    def get_page(self, course_id: str, page_url: str) -> dict[str, object]:
        return self.get_json(f"/api/v1/courses/{course_id}/pages/{page_url}")

    def create_page(self, course_id: str, title: str, body: str, published: bool = False) -> dict[str, object]:
        return self._json(
            "POST",
            f"/api/v1/courses/{course_id}/pages",
            data={
                "wiki_page[title]": title,
                "wiki_page[body]": body,
                "wiki_page[published]": str(published).lower(),
            },
        )

    def update_page(
        self, course_id: str, page_url: str, title: str | None = None,
        body: str | None = None, published: bool | None = None,
    ) -> dict[str, object]:
        data: dict[str, str] = {}
        if title is not None:
            data["wiki_page[title]"] = title
        if body is not None:
            data["wiki_page[body]"] = body
        if published is not None:
            data["wiki_page[published]"] = str(published).lower()
        return self._json("PUT", f"/api/v1/courses/{course_id}/pages/{page_url}", data=data)

    # -- assignments ----------------------------------------------------

    def get_assignment_full(self, course_id: str, assignment_id: str) -> dict[str, object]:
        return self.get_json(f"/api/v1/courses/{course_id}/assignments/{assignment_id}")

    def create_assignment(self, course_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/assignments", data=fields)

    def update_assignment(self, course_id: str, assignment_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("PUT", f"/api/v1/courses/{course_id}/assignments/{assignment_id}", data=fields)

    # -- discussions ----------------------------------------------------

    def get_discussion(self, course_id: str, topic_id: str) -> dict[str, object]:
        return self.get_json(f"/api/v1/courses/{course_id}/discussion_topics/{topic_id}")

    def create_discussion(self, course_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/discussion_topics", data=fields)

    def update_discussion(self, course_id: str, topic_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("PUT", f"/api/v1/courses/{course_id}/discussion_topics/{topic_id}", data=fields)

    # -- quizzes --------------------------------------------------------

    def get_quiz(self, course_id: str, quiz_id: str) -> dict[str, object]:
        return self.get_json(f"/api/v1/courses/{course_id}/quizzes/{quiz_id}")

    def create_quiz(self, course_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/quizzes", data=fields)

    def update_quiz(self, course_id: str, quiz_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("PUT", f"/api/v1/courses/{course_id}/quizzes/{quiz_id}", data=fields)

    def list_quiz_questions(self, course_id: str, quiz_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/quizzes/{quiz_id}/questions")

    def create_quiz_question(
        self, course_id: str, quiz_id: str, fields: list[tuple[str, str]]
    ) -> dict[str, object]:
        """Create one question. `fields` is a list of tuples because Canvas uses
        repeated bracketed keys for answers: question[answers][][answer_text]."""
        return self._json("POST", f"/api/v1/courses/{course_id}/quizzes/{quiz_id}/questions", data=fields)

    def delete_quiz_question(self, course_id: str, quiz_id: str, question_id: str) -> None:
        self._request("DELETE", f"/api/v1/courses/{course_id}/quizzes/{quiz_id}/questions/{question_id}")

    # -- modules --------------------------------------------------------

    def list_modules(self, course_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/modules")

    def create_module(
        self, course_id: str, name: str, position: int, published: bool = False
    ) -> dict[str, object]:
        return self._json(
            "POST",
            f"/api/v1/courses/{course_id}/modules",
            data={
                "module[name]": name,
                "module[position]": str(position),
                "module[published]": str(published).lower(),
            },
        )

    def update_module(self, course_id: str, module_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("PUT", f"/api/v1/courses/{course_id}/modules/{module_id}", data=fields)

    def list_module_items(self, course_id: str, module_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/modules/{module_id}/items")

    def create_module_item(self, course_id: str, module_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/modules/{module_id}/items", data=fields)

    def delete_module_item(self, course_id: str, module_id: str, item_id: str) -> None:
        self._request("DELETE", f"/api/v1/courses/{course_id}/modules/{module_id}/items/{item_id}")

    # -- files ----------------------------------------------------------

    def list_files(self, course_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/files")

    def get_file(self, file_id: str) -> dict[str, object]:
        return self.get_json(f"/api/v1/files/{file_id}")

    def upload_file(
        self, course_id: str, path: Path, folder: str = "course files", overwrite: bool = True
    ) -> dict[str, object]:
        """Upload a file using Canvas's three-step flow, and confirm it landed.

        Step 1 announces the file and returns an upload target; step 2 POSTs the
        bytes with `file` last; step 3 follows the redirect to finalise. Skipping
        step 3 leaves the file stuck in a 'pending' state.
        """
        size = path.stat().st_size
        announce = self._json(
            "POST",
            f"/api/v1/courses/{course_id}/files",
            data={
                "name": path.name,
                "size": str(size),
                "parent_folder_path": folder,
                "on_duplicate": "overwrite" if overwrite else "rename",
            },
        )
        upload_url = str(announce["upload_url"])
        upload_params = announce.get("upload_params", {})
        if not isinstance(upload_params, dict):
            raise RuntimeError(f"unexpected upload_params for {path.name}: {upload_params!r}")

        # Step 2. The file field must come after every other parameter.
        with path.open("rb") as handle:
            response = requests.post(
                upload_url,
                data={str(k): str(v) for k, v in upload_params.items()},
                files={"file": (path.name, handle)},
                timeout=self._UPLOAD_TIMEOUT,
                allow_redirects=False,
            )
        if response.status_code not in (200, 201, 301, 302, 303):
            raise RuntimeError(
                f"Canvas file upload failed for {path.name}: "
                f"HTTP {response.status_code}: {response.text[:200]}"
            )

        # Step 3. Confirm, otherwise the file never becomes available.
        location = response.headers.get("Location")
        if location:
            confirmed = self._request("GET", location, absolute=True)
            if not confirmed.ok:
                raise RuntimeError(f"Canvas file confirmation failed for {path.name}: {confirmed.text[:200]}")
            result: dict[str, object] = confirmed.json()
        else:
            result = response.json()

        reported = result.get("size")
        uploaded = int(reported) if isinstance(reported, (int, str)) else -1
        if uploaded != size:
            raise RuntimeError(
                f"{path.name} uploaded as {uploaded} bytes but the local file is {size}"
            )
        return result

    # -- one object at a time -------------------------------------------
    #
    # The publisher above drives a whole repository through the typed methods.
    # These four cover the other half: create, read, change, or remove a single
    # object of any kind. The only per-kind difference is the path segment, and
    # a page is addressed by its url slug where everything else uses a numeric
    # id. Canvas answers a DELETE with the deleted object rather than an empty
    # body, so delete_object hands it back: it is the only record of what went.

    def create_object(self, kind: str, course_id: str, fields: dict[str, str]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/{kind_path(kind)}", data=fields)

    def get_object(self, kind: str, course_id: str, object_id: str) -> dict[str, object]:
        return self.get_json(f"/api/v1/courses/{course_id}/{kind_path(kind)}/{object_id}")

    def update_object(
        self, kind: str, course_id: str, object_id: str, fields: dict[str, str]
    ) -> dict[str, object]:
        return self._json(
            "PUT", f"/api/v1/courses/{course_id}/{kind_path(kind)}/{object_id}", data=fields
        )

    def delete_object(self, kind: str, course_id: str, object_id: str) -> dict[str, object]:
        return self._json("DELETE", f"/api/v1/courses/{course_id}/{kind_path(kind)}/{object_id}")

    def delete_file(self, file_id: str) -> dict[str, object]:
        """Files live outside the course namespace, so they get their own method."""
        return self._json("DELETE", f"/api/v1/files/{file_id}")

    # -- submissions and grading -----------------------------------------
    #
    # One endpoint carries both halves of "grade with feedback": submission[]
    # fields set the score, comment[] fields attach the feedback. Sending only
    # comment[text_comment] leaves the submission ungraded but commented, which
    # is how you return work without putting a number on it.

    def get_submission(
        self,
        course_id: str,
        assignment_id: str,
        user_id: str,
        *,
        include: tuple[str, ...] = ("submission_comments", "rubric_assessment", "user"),
    ) -> dict[str, object]:
        """Fetch one submission, with its comments and rubric by default."""
        response = self._request(
            "GET",
            f"/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}",
            params=[("include[]", name) for name in include],
        )
        if not response.ok:
            raise RuntimeError(f"Canvas API error {response.status_code}: {response.text}")
        result: dict[str, object] = response.json()
        return result

    def grade_submission(
        self,
        course_id: str,
        assignment_id: str,
        user_id: str,
        *,
        grade: str | None = None,
        comment: str | None = None,
        group_comment: bool = False,
        excuse: bool | None = None,
        late_policy_status: str | None = None,
        seconds_late_override: int | None = None,
        rubric_assessment: RubricAssessment | None = None,
    ) -> dict[str, object]:
        """Set a score and/or attach a comment on one submission.

        `grade` is whatever the assignment's grading type accepts: points
        ("18"), a percentage ("92%"), a letter ("B+"), or "pass"/"fail".
        """
        data: dict[str, str] = {}
        if grade is not None:
            data["submission[posted_grade]"] = grade
        if excuse is not None:
            data["submission[excuse]"] = str(excuse).lower()
        if late_policy_status is not None:
            data["submission[late_policy_status]"] = late_policy_status
        if seconds_late_override is not None:
            data["submission[seconds_late_override]"] = str(seconds_late_override)
        if comment:
            data["comment[text_comment]"] = comment
            if group_comment:
                data["comment[group_comment]"] = "true"
        if rubric_assessment:
            for criterion_id, entry in rubric_assessment.items():
                for field, value in entry.items():
                    data[f"rubric_assessment[{criterion_id}][{field}]"] = str(value)

        if not data:
            raise ValueError("grade_submission needs at least a grade, a comment, or a rubric")

        return self._json(
            "PUT",
            f"/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/{user_id}",
            data=data,
        )

    def download_attachment(self, url: str, dest: Path) -> int:
        """Stream a submission attachment to disk and return its size in bytes.

        Canvas attachment URLs redirect to blob storage; `requests` drops the
        Authorization header on a cross-host redirect, so the token stays put.
        """
        dest.parent.mkdir(parents=True, exist_ok=True)
        with requests.get(
            url, headers=self.headers, timeout=self._UPLOAD_TIMEOUT, stream=True
        ) as response:
            if not response.ok:
                raise RuntimeError(
                    f"Canvas download failed for {dest.name}: HTTP {response.status_code}"
                )
            written = 0
            with dest.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1 << 16):
                    handle.write(chunk)
                    written += len(chunk)
        return written

    # -- rubrics --------------------------------------------------------

    def list_rubrics(self, course_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/rubrics")

    def create_rubric(self, course_id: str, fields: list[tuple[str, str]]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/rubrics", data=fields)
