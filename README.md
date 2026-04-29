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
└── google.py       # Google Drive / Docs / Gmail helpers (edutools google …)
tests/
├── test_canvas.py
├── test_iam.py
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

### References

- Canvas Live API: https://boisestatecanvas.instructure.com/doc/api/live