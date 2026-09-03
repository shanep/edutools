"""Edutools package.

``pyproject.toml`` is the single place the version is declared; git tags follow
it. See :mod:`edutools._version` for how a source checkout is annotated.
"""

from edutools._version import full_version, release_version

__all__ = ["__version__", "full_version", "release_version"]

__version__ = release_version()
