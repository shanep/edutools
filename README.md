# Edu Tools

A command line tool for Canvas LMS. It reads course data out of Canvas (courses,
assignments, students, submissions, ungraded work), publishes a course repo of
markdown into Canvas pages, assignments, and modules, edits individual Canvas
objects, and grades submissions with written feedback.

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

edutools create <kind> --course <id> ...         create one page/assignment/discussion/quiz/module
edutools update <kind> <id> --course <id> ...    change one object
edutools delete <kind> <id> --course <id>        delete one object (asks first)
edutools publish <kind> <id> --course <id>       make one object student-visible
edutools unpublish <kind> <id> --course <id>     hide one object from students

edutools submission -c <id> -a <id> -s <id>      show one submission with its comments
edutools download -c <id> -a <id> --out <dir>    download submission attachments
edutools grade -c <id> -a <id> -s <id> ...       grade one submission, with feedback
edutools grade -c <id> -a <id> --from-file <f>   grade a batch from JSON or CSV

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
--update-published     also rewrite content students can already see
--path <glob>          limit to specific repo files, repeatable
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

### Pushing one correction

`--path` limits a push to particular files, so a fix to one assignment does not
re-render the course:

```bash
edutools push ./cs425 --course 48194 --path assignments/p1.md
edutools push ./cs425 --course 48194 --path 'assignments/p*.md' --path index.md
```

It takes a repo-relative path or a glob and is repeatable, and a pattern matching
nothing is an error rather than a silent no-op. The full pipeline still runs for
what is selected, so dates, links, rubric and styling all come from the repository.
Whole-course module rebuilding is skipped, since that is a structural change rather
than a correction.

Correcting something students can already see needs `--update-published` as well:

```bash
edutools push ./cs425 --course 48194 --path assignments/p1.md --update-published
```

That leaves the assignment published. `--publish` makes an object visible; its
absence means "leave visibility as it is", not "hide it", so a correction never
pulls a live assignment out from under the class reading it.

A push also **leaves published content alone**. Rewriting a page or an assignment
that a class is part-way through reading is worse than leaving it stale, so anything
already visible to students is skipped and listed at the end. `--update-published`
overwrites it anyway. The same guard covers modules and rubrics: a module is not
rebuilt while it is published, and a rubric is not replaced on work already under
way.

`push` runs in two passes: the first pass creates or updates every Canvas object so
each one has an id, and the second pass rewrites cross-references between them into
real Canvas links. `verify` then fetches the published content and compares it
semantically against what the repo says it should be, so a partial or stale publish
is visible instead of silent.

`dates` computes assignment due dates from the term skeleton in the repo's
`canvas.toml`. `--show` prints the computed schedule without publishing anything.

### Course repository layout

By default a course repo looks like this, and a repo shaped this way needs no
`[layout]` section at all:

```
canvas.toml            term skeleton, date policies, module layout
syllabus.md            becomes the Canvas syllabus
objectives.md          published as a page
resources.md           published as a page
modules/*.md           published as pages
assignments/lab-*.md   published as assignments
assignments/*-exam-guide.md   published as pages
quizzes/quiz-*.md      published as quizzes
discussions/*.md       published as discussions
docs/*.pdf, data/*     uploaded as files
```

Courses that name things differently declare their own shape instead. A directory
that is also a VitePress site, for instance, has to call its syllabus `index.md`,
and may call its projects `p0.md` rather than `lab-0.md`:

```toml
[layout]
syllabus = "index.md"
pages    = ["objectives.md", "resources.md", "notes/*.md", "assignments/*-exam-guide.md"]
files    = []

[layout.gradable]
project    = "assignments/p[0-9]*.md"
quiz       = "quizzes/quiz-*.md"
discussion = "discussions/*.md"
```

Anything the section leaves out keeps its default. Page patterns are matched before
gradable ones, so a file caught by both stays a page. The keys under
`[layout.gradable]` are item kinds (`lab`, `project`, `quiz`, `discussion`, `exam`),
and each needs a matching `[term.policy.<kind>]` to compute its dates from.

### VitePress source

A course directory can be served as a website and pushed to Canvas at the same
time. `push` resolves the VitePress-only syntax that pandoc would otherwise emit as
literal text:

| In the markdown | In Canvas |
| --------------- | --------- |
| YAML frontmatter | removed |
| `<!--@include: path.md-->` | the target file, inlined recursively |
| `::: danger` ... `:::` | a blockquote with a bold lead line |
| `<OfficeHoursLink />` and other capitalised tags | removed |
| `<script setup>` blocks | removed |

Ordinary lowercase HTML is left alone, and an include written inline in prose,
rather than alone on its own line, stays as text so it can be documented.

### Point totals

`[term] total_points` is what every gradable item should add up to, defaulting to
1000. Set it to `0` for a course that grades by weighted assignment groups instead,
which skips the check.

### Date policies

Each item kind gets a `[term.policy.<kind>]` with `due`, an optional `unlock`, and
an optional `grace_days`:

```toml
[term.policy.project]
due        = "tue 23:59"   # required
grace_days = 2             # days between due_at and lock_at
# unlock   = "mon 00:00"   # omit to leave Canvas's "Available from" blank
```

Omitting `unlock` means the item has no availability date and is visible as soon as
it is published. The field is sent to Canvas empty rather than left out, so removing
`unlock` from a policy clears a date that an earlier push had set.

### Editing one object at a time

`push` drives a whole repository. When you only need to touch one thing, `create`,
`update`, `delete`, `publish`, and `unpublish` each take a kind (`page`,
`assignment`, `discussion`, `quiz`, or `module`) and a course:

```bash
edutools create assignment -c 12345 --title "Lab 7" --points 50 \
    --body-file assignments/lab-07.md --due 2026-10-14T23:59:00-06:00

edutools update assignment 98765 -c 12345 --points 40
edutools publish assignment 98765 -c 12345
edutools unpublish page week-1 -c 12345
edutools delete assignment 98765 -c 12345
```

Like `push`, `create` leaves an object **unpublished** unless `--publish` is given.
A `.md` file passed to `--body-file` goes through the same pandoc rendering and
Canvas-safe HTML pipeline that `push` uses, and its `#` heading becomes the default
title. `update` sends only the fields you name, so it never clears anything you did
not mention. `delete` prints what it is about to remove and asks for confirmation
unless `--yes` is given.

Canvas names the same idea differently on each endpoint (an assignment has a `name`,
a page a `title`; a graded discussion hangs its points off `assignment[...]`).
`edutools` maps the common flags for you, and `--set` reaches anything it does not
model:

```bash
edutools create assignment -c 12345 --title "Lab 7" \
    --set 'assignment[submission_types][]=online_upload' \
    --set 'assignment[omit_from_final_grade]=true'
```

A page is addressed by its url slug (`week-1`) rather than a numeric id; everything
else uses its id.

### Grading with feedback

```bash
edutools ungraded 12345                                  # what still needs a grade
edutools submission -c 12345 -a 67890 -s 555             # read one submission
edutools download -c 12345 -a 67890 --out ./submissions  # pull the attachments down

edutools grade -c 12345 -a 67890 -s 555 --score 18 --comment "Clean tests."
edutools grade -c 12345 -a 67890 -s 555 --comment-file feedback.md
edutools grade -c 12345 -a 67890 -s 555 --excuse
```

`--score` takes whatever the assignment's grading type accepts: points (`18`), a
percentage (`92%`), a letter (`B+`), or `pass`/`fail`. A `--comment` with no
`--score` returns feedback without putting a number on the work.

A whole class at once comes from a file, as JSON (a list of objects, or an object
keyed by student id) or a CSV with a header row. Column names are matched loosely,
so `score`/`grade`/`points` and `comment`/`feedback` all mean the same thing:

```json
[
  {"student": 555, "score": 18, "comment": "Clean tests, good naming."},
  {"student": 556, "score": 12, "comment": "See the note on error handling."},
  {"student": 557, "excuse": true}
]
```

```bash
edutools grade -c 12345 -a 67890 --from-file grades.json --dry-run   # show, write nothing
edutools grade -c 12345 -a 67890 --from-file grades.json
edutools grade -c 12345 -a 67890 --from-file grades.csv
```

Grading is deliberately sequential: Canvas throttles parallel writes, and a
per-student loop reports exactly which rows failed. `--dry-run` prints the table it
would send and writes nothing.

If the assignment uses a **manual posting policy**, a grade written here lands on
the submission but stays hidden from the student until it is posted from the Canvas
gradebook. Canvas exposes posting only through its GraphQL API, so `edutools` does
not do it.

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
├── objects.py      # pure functions: per-kind Canvas field names, grade-file parsing
└── _version.py     # version reporting
tests/
├── test_canvas.py
├── test_cli.py
├── test_dates.py
├── test_objects.py
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
