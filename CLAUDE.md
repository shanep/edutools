# edutools

A Canvas LMS command line tool. `edutools` reads course data, publishes a course
repository of markdown into Canvas, edits individual Canvas objects, and grades
submissions with feedback.

Installed as a `uv` tool (`make install`), so `edutools` on `PATH` is this
checkout in editable mode.

## Layout

```
src/edutools/
├── cli.py        typer app; every command lives here, nothing else does
├── canvas.py     the only module that talks HTTP to Canvas
├── publish.py    pure: markdown -> Canvas HTML, sanitizer allowlist, manifest
├── publisher.py  two-pass course-repo publisher (create objects, rewrite links)
├── verify.py     pure: reads content back and compares it semantically
├── dates.py      pure: due-date computation from a canvas.toml term skeleton
├── objects.py    pure: per-kind Canvas field names, grade-file parsing
└── _version.py   version reporting
```

The split is the point: `canvas.py` owns the network, everything else is pure and
testable without a token, and `cli.py` is a thin presentation layer. Keep it that
way.

- **New Canvas endpoint** -> a method on `CanvasLMS`, never a `requests` call
  elsewhere.
- **New rule about what to send** -> a pure function in `objects.py`, `publish.py`,
  or `dates.py`, tested directly.
- **New command** -> `cli.py`, doing argument handling, Rich output, and nothing
  else. Import `edutools.*` inside the command body, not at module scope: it is
  what keeps `--help` fast.

## Checks

All three must pass before anything is committed:

```bash
make lint       # ruff check
make typecheck  # pyright, currently clean at zero errors - keep it there
make test       # pytest
```

`make fmt` reformats the entire tree, and the tree is not currently ruff-formatted,
so running it turns a small change into a 15-file diff. Leave it alone unless the
user asks for a formatting pass of its own.

Tests never hit the network. Patch `edutools.canvas.requests.request` (the write
path) or `edutools.canvas.requests.get` (the paginated read path) and assert on
the URL and the form body that was built, which is where the bugs actually are.

## Canvas API conventions

These are Canvas's rules, not choices, and getting them wrong fails silently:

- **Every kind names its fields differently.** An assignment has `assignment[name]`,
  a page `wiki_page[title]`, a quiz `quiz[title]`, a module `module[name]`, and a
  discussion takes bare parameters with no prefix at all. A graded discussion hangs
  its points and dates off `assignment[...]` rather than the topic. `objects.py`
  holds this table; add to it rather than special-casing at a call site.
- **A page is addressed by its url slug**, everything else by numeric id.
- **Repeated bracket keys are lists.** `assignment[submission_types][]` and quiz
  answers must be sent as a list of tuples, not a dict, which is why `RequestData`
  allows both.
- **The sanitizer strips silently.** Canvas drops `<style>`, `<link>`, `<script>`,
  and any CSS property outside its allowlist, and answers 200 either way. That is
  what `publish.py`'s allowlist and the `verify` command exist for: never trust a
  200 to mean the content arrived.
- **Writes are sequential on purpose.** Canvas throttles with 429 and charges a
  pre-flight penalty for parallel requests. `_request` retries with backoff; do not
  add concurrency to work around slowness.
- **File upload is three steps.** Announce, POST the bytes with `file` last, then
  follow the redirect to confirm. Skipping the third step leaves the file pending.
- **Posting policy is GraphQL-only.** A grade written to an assignment with a manual
  posting policy lands but stays hidden. There is no REST endpoint for posting it;
  say so rather than inventing one.

## Working on a live course

Canvas writes are real and immediate, against courses with real students in them.

- Default to unpublished. `push` and `create` both leave objects invisible to
  students unless `--publish` is passed. Preserve that default in anything new.
- **Never rewrite published content.** `push` skips any object Canvas reports as
  published, and lists what it skipped; `--update-published` is the opt-in. The
  same guard covers modules and rubrics. Changing a page mid-semester under a
  class that is reading it is worse than leaving it stale, so anything new that
  writes to Canvas has to respect `Publisher.protected` too.
- Prefer `--dry-run` first (`push`, `grade`) and check the output before writing.
- Deletes cascade: removing an assignment or graded discussion takes its
  submissions and grades with it. `delete` confirms before acting; keep it that way.
- Do not run `push`, `grade`, or `delete` against a course id you were not given.

## Style

- Comments explain *why*, especially where the code is shaped by something Canvas
  does. Do not narrate what the next line does.
- Full type annotations; `make typecheck` is at zero errors.
- No em-dashes or en-dashes in code, comments, docs, or commit messages.
- Read commands take `--json` and emit the raw payload, so output can be parsed
  rather than scraped. Every new read command should too.

## References

- Canvas Live API: https://boisestatecanvas.instructure.com/doc/api/live
