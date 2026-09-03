"""Version discovery for edutools.

``pyproject.toml`` declares the released version and git tags follow it: ``make
release`` bumps the version, commits, and creates the matching ``vX.Y.Z`` tag.

When edutools runs from a source checkout that has moved past the last tag, the
reported version gains a PEP 440 local segment describing the checkout (for
example ``1.0.0+3.gf77c202.dirty``), so a dev build is never mistaken for the
release it was built from.
"""

import re
import subprocess
from importlib.metadata import PackageNotFoundError, version as _metadata_version
from pathlib import Path
from typing import NamedTuple

__all__ = ["GitDescription", "describe_repo", "full_version", "release_version"]

# git describe output: "<tag>-<distance>-g<commit>", optionally "-dirty".
_DESCRIBE_RE = re.compile(r"^(?P<tag>.+)-(?P<distance>\d+)-g(?P<commit>[0-9a-f]+)$")

_GIT_TIMEOUT_SECONDS = 5.0


class GitDescription(NamedTuple):
    """A parsed ``git describe`` result for the checkout edutools runs from."""

    tag: str | None
    """Nearest tag, or ``None`` when the repository has no tags yet."""
    distance: int
    """Commits between ``tag`` and HEAD; ``0`` means HEAD is the tagged commit."""
    commit: str
    """Abbreviated commit hash of HEAD."""
    dirty: bool
    """Whether the working tree has uncommitted changes."""


def release_version() -> str:
    """Return the released version recorded in the package metadata."""
    try:
        return _metadata_version("edutools")
    except PackageNotFoundError:  # pragma: no cover - running from a bare source tree
        return "0.0.0+unknown"


def _source_checkout() -> Path | None:
    """Return the git work tree this package is imported from, if there is one."""
    # src/edutools/_version.py -> src/edutools -> src -> repository root
    root = Path(__file__).resolve().parents[2]
    return root if (root / ".git").exists() else None


def describe_repo() -> GitDescription | None:
    """Describe the source checkout, or ``None`` if git cannot answer.

    Returns ``None`` for an installed (non-editable) package, when git is not on
    PATH, or when the command fails for any other reason -- reporting a version
    must never be able to fail.
    """
    root = _source_checkout()
    if root is None:
        return None

    try:
        result = subprocess.run(
            ["git", "-C", str(root), "describe", "--tags", "--long", "--dirty", "--always"],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if result.returncode != 0:
        return None

    described = result.stdout.strip()
    if not described:
        return None

    dirty = described.endswith("-dirty")
    if dirty:
        described = described[: -len("-dirty")]

    match = _DESCRIBE_RE.match(described)
    if match is None:
        # --always fallback: no tags reachable, so git printed the bare hash.
        return GitDescription(tag=None, distance=0, commit=described, dirty=dirty)

    return GitDescription(
        tag=match["tag"],
        distance=int(match["distance"]),
        commit=match["commit"],
        dirty=dirty,
    )


def _local_segment(description: GitDescription) -> str | None:
    """Build the PEP 440 local segment for a checkout, or ``None`` if it is a release."""
    if description.tag is not None and description.distance == 0 and not description.dirty:
        return None

    parts = [f"g{description.commit}"]
    if description.tag is not None:
        parts.insert(0, str(description.distance))
    if description.dirty:
        parts.append("dirty")
    return ".".join(parts)


def full_version() -> str:
    """Return the version to report to users, annotated for dev checkouts."""
    version = release_version()
    description = describe_repo()
    if description is None:
        return version

    local = _local_segment(description)
    return version if local is None else f"{version}+{local}"
