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
        params: dict[str, str | int] | None = None,
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

    def create_module(self, course_id: str, name: str, position: int) -> dict[str, object]:
        return self._json(
            "POST",
            f"/api/v1/courses/{course_id}/modules",
            data={"module[name]": name, "module[position]": str(position)},
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

    # -- rubrics --------------------------------------------------------

    def list_rubrics(self, course_id: str) -> list[dict[str, object]]:
        return self.list_json(f"/api/v1/courses/{course_id}/rubrics")

    def create_rubric(self, course_id: str, fields: list[tuple[str, str]]) -> dict[str, object]:
        return self._json("POST", f"/api/v1/courses/{course_id}/rubrics", data=fields)
