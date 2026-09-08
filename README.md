# Edu Tools

A command line tool for Canvas LMS. It reads course data out of Canvas (courses,
assignments, students, submissions, ungraded work) and publishes a course repo of
markdown into Canvas pages, assignments, and modules.

Every read command can emit raw JSON with `--json`, so the output is easy to parse
from a script or an agent instead of scraping table borders.

## Install

```bash
make install     # uv tool install . -e
edutools --help
```

`push` renders markdown by shelling out to [pandoc](https://pandoc.org/), so pandoc
must be on your `PATH` for that command. Everything else works without it.

## Configuration

Configuration lives in `~/.config/edutools/config.toml` and has a single section:

```toml
[canvas]
token = ""        # required
# endpoint = "https://boisestatecanvas.instructure.com"   # optional
```

Create it with:

```bash
edutools init
```

`init` writes the file if it is missing and prints the current setup status. Get a
token from Canvas: **Account -> Settings -> Approved Integrations -> + New Access
Token**. Paste it into `token` and confirm it works:

```bash
edutools check
```

Under the hood the tool reads the environment variables `CANVAS_TOKEN` and
`CANVAS_ENDPOINT`. Values from `config.toml` are loaded into the environment at
startup, so exporting either variable directly also works and takes the same code
path.

## Commands

```
edutools init                                    create ~/.config/edutools/config.toml, show setup status
edutools check                                   verify the Canvas token works
edutools courses [--all/-a] [--json]             list courses where you are a teacher
edutools assignments <course_id> [--json]        list assignments in a course
edutools students <course_id> [--json]           list students in a course
edutools submissions <course_id> <assignment_id> [--json]
                                                 list submissions for one assignment
edutools ungraded <course_id> [--json]           list submissions still needing a grade
edutools push <course_repo> --course <id>        publish a course repo into Canvas
edutools verify <course_repo> --course <id>      read published content back and prove it landed
edutools dates <course_repo> [--show] [--shift]  compute due dates from canvas.toml
edutools --version                               print the version
```

`push` takes several flags worth knowing:

```
--course <id>          Canvas course ID (required)
--dry-run              render everything, write nothing to Canvas
--publish              make the objects student-visible (default: unpublished)
--only <group>         limit to pages, assignments, discussions, quizzes, files,
                       modules, syllabus, or rubrics (repeatable)
--no-verify            skip the verification pass that normally follows a push
--preview <dir>        write the rendered HTML to a directory for inspection
```

### Reading course data

```bash
edutools courses                 # active courses you teach
edutools courses --all           # include concluded and unpublished courses
edutools courses --json          # raw JSON instead of a table

edutools assignments 12345
edutools students 12345
edutools submissions 12345 67890
edutools ungraded 12345
```

Without `--json` these print a Rich table meant for humans. With `--json` they print
the API payload verbatim, which is the mode to use when another program is consuming
the output.

### Publishing a course repo

```bash
edutools dates ./cs121 --show                     # due dates computed from canvas.toml
edutools push ./cs121 --course 12345 --dry-run    # render everything, write nothing
edutools push ./cs121 --course 12345              # create and update the Canvas objects
edutools verify ./cs121 --course 12345            # read the content back and compare
```

Objects are created **unpublished** unless `--publish` is given, so a push is safe to
run against a live course before students should see the content. `push` runs
`verify` automatically when it finishes; pass `--no-verify` to skip that.

`push` runs in two passes: the first pass creates or updates every Canvas object so
each one has an id, and the second pass rewrites cross-references between them into
real Canvas links. `verify` then fetches the published content and compares it
semantically against what the repo says it should be, so a partial or stale publish
is visible instead of silent.

`dates` computes assignment due dates from the term skeleton in the repo's
`canvas.toml`. `--show` prints the computed schedule without publishing anything.

## Development

### Prerequisites

- [uv](https://github.com/astral-sh/uv), used for dependency management, running tools, and building
- [pandoc](https://pandoc.org/), required by `edutools push`

### Setup

```bash
make bootstrap   # verify uv is installed and sync dependencies
make install     # install edutools in editable mode
```

### Project layout

```
src/edutools/
├── cli.py          # typer app, all command definitions
├── canvas.py       # Canvas LMS REST API client
├── publish.py      # pure functions: markdown -> Canvas HTML, sanitizer allowlist, manifest
├── publisher.py    # two-pass course-repo publisher (create objects, then rewrite links)
├── verify.py       # reads content back out of Canvas and compares semantically
├── dates.py        # due-date computation from a canvas.toml term skeleton
└── _version.py     # version reporting
tests/
├── test_canvas.py
├── test_dates.py
├── test_publish.py
├── test_verify.py
└── test_version.py
```

### Common tasks

```bash
make fmt          # format with ruff
make lint         # lint with ruff
make typecheck    # type-check with pyright
make test         # run the test suite
make clean        # remove build artifacts and caches
```

### Versioning and releases

`pyproject.toml` holds the released version and git tags follow it, one `vX.Y.Z`
tag per release.

```bash
edutools --version   # 1.0.0 installed, 1.0.0+3.gf77c202.dirty in a source checkout
make version         # the released version and the version of this checkout
```

In a source checkout the reported version gains a PEP 440 local segment (commits
since the tag, the commit hash, and `.dirty` for uncommitted changes), so a dev
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
