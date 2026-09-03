# Edu Tools

Small CLI utilities for querying Canvas (courses, assignments, students, submissions) and a helper to create/share Google Docs via a service account.

## Usage

- Console script (after install):

```bash
edutools -h
```

## Development

### Prerequisites

- [uv](https://github.com/astral-sh/uv) — used for dependency management, running tools, and building

### Setup

```bash
make bootstrap   # verify uv is installed and sync dependencies
make install     # install edutools in editable mode
```

### Project layout

```
src/edutools/
├── cli.py          # typer app and all command definitions
├── canvas.py       # Canvas LMS API client (edutools canvas …)
├── iam.py          # AWS IAM provisioning helpers (edutools iam …)
├── ec2.py          # AWS EC2 provisioning helpers (edutools ec2 …)
├── _version.py     # version reporting (edutools --version)
└── google.py       # Google Drive / Docs / Gmail helpers (edutools google …)
tests/
├── test_canvas.py
├── test_iam.py
├── test_version.py
└── test_integration.py   # requires live AWS credentials, skipped by default
```

### Common tasks

```bash
make fmt          # format with ruff
make lint         # lint with ruff
make typecheck    # type-check with pyright
make test         # run unit tests (integration tests skipped)
make clean        # remove build artifacts and caches
```

Run integration tests explicitly (requires valid AWS credentials):

```bash
uv run pytest -m integration
```

### Versioning and releases

`pyproject.toml` holds the released version and git tags follow it, one `vX.Y.Z`
tag per release.

```bash
edutools --version   # 1.0.0 installed, 1.0.0+3.gf77c202.dirty in a source checkout
make version         # the released version and the version of this checkout
```

In a source checkout the reported version gains a PEP 440 local segment — commits
since the tag, the commit hash, and `.dirty` for uncommitted changes — so a dev
build is never mistaken for the release it was built from.

To cut a release (runs the tests, bumps the version, commits, tags, and pushes):

```bash
make release                 # patch bump: 1.0.0 -> 1.0.1
make release BUMP=minor      # 1.0.0 -> 1.1.0
make release VERSION=2.0.0   # exact version
```

`make release` refuses to run on a dirty tree, on a detached HEAD, or when the
tag already exists.

### References

- Canvas Live API: https://boisestatecanvas.instructure.com/doc/api/live