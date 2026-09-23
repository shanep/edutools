---
name: canvas
description: Work with Canvas LMS through the `edutools` CLI - list courses, students, assignments, modules and submissions; snapshot a whole course to disk; publish a course repository of markdown into Canvas and verify or audit what landed; preview the module outline and due dates; create, update, delete, publish and unpublish pages, assignments, discussions, quizzes and modules; and grade submissions with written feedback. Use whenever the request touches Canvas, an LMS course, course design or course content, a backup or snapshot of a course, a gradebook, a course page or module, an assignment or quiz, student submissions, grading, or leaving feedback on student work.
---

# Canvas LMS

All Canvas work goes through `edutools`, a CLI already on `PATH`. Never call the
Canvas REST API directly with `curl` or a one-off script: `edutools` handles
auth, pagination, throttling, retries, and the per-kind field names that Canvas
gets fussy about.

Run `edutools --help`, or `edutools <command> --help`, whenever the exact flags
matter. This file covers what the help text cannot: which command to reach for,
and what goes wrong. `--help` does not mark which options are required; the ones
that are say so below.

## Before anything else

```bash
edutools check --json          # confirms the credentials work
edutools courses --json        # the course ids you are allowed to touch
```

`check --json` always prints one object on stdout. On success it is
`{"ok": true, "endpoint", "source", "site", "courses"}`. If the credentials are
missing or rejected it is `{"ok": false, "endpoint", "error"}` (`endpoint` is null
when no site is set up) and it exits 1. Read `error`, then:

- **No site set up.** Tell the user to generate a token in Canvas (Account ->
  Settings -> Approved Integrations -> + New Access Token) and run
  `edutools site add <name> --endpoint https://<their canvas>` themselves. It asks
  for the token at a hidden prompt; a token is never a flag. Do not ask the user
  to paste a token into the conversation, and do not try to work around a
  missing token.
- **The token expired or was revoked** (`error` mentions 401 or an invalid access
  token, or no token is saved for the site). Tell the user to generate a new one
  and run `edutools site token <name>` themselves; it asks for the token the same
  way `site add` does.
- **They used an older edutools** with `~/.config/edutools/config.toml`:
  `edutools init` moves that token into the OS keychain and prints the setup
  status. It is safe to run; it only reads the old file.

Tokens live in the OS keychain, one per Canvas **site**. `edutools site list
--json` shows the sites, which is the default, and a masked hint of each token.
Every command takes a global `--site <name>` (`edutools --site other courses
--json`) to use a site other than the default.
`CANVAS_TOKEN` and `CANVAS_ENDPOINT` in the environment override all of it.

Every read command takes `--json` and prints the raw Canvas payload. **Always use
`--json` when you need to read a value**; parse that, never the table. With
`--json`, stdout is pure JSON and everything else (prompts, progress, warnings,
errors) goes to stderr, so piping stdout into a parser is safe.

Exit codes: 0 for success, 1 for a failure or a problem found, 2 for a usage
error such as a missing required option.

## Rules that are not negotiable

Canvas writes are immediate and land on real courses with real students.

1. **Never write to a course id the user did not give you.** If the course is
   ambiguous, list courses and ask which one. Do not guess from a name match.
2. **Create unpublished.** `create` and `push` leave objects invisible to students
   unless `--publish` is passed. Keep that default; publish as a separate,
   deliberate step once the user has seen what was made. The one exception is a
   `[[module]]` the repo marks `publish = true` (see Module tables below): the
   user decided that once, in `canvas.toml`, and every push honours it.
3. **Dry run first for anything bulk.** `grade --dry-run` and `push --dry-run`
   print exactly what would be sent and write nothing. Show that output before
   writing.
4. **Deleting cascades.** Removing an assignment, quiz, or graded discussion takes
   its submissions and grades with it, irreversibly. Confirm with the user first,
   naming the object. Do not pass `--yes` unless the user has already confirmed
   that specific object in this conversation.
5. **Leave published content alone.** `push` skips anything students can already
   see and lists it. Do not add `--update-published` unless the user has asked
   for that specific published content to change in this conversation.
6. **Report what actually happened.** `grade`, `push` and `pull` print what they
   did and exit non-zero on failure. If something failed, say what and why.
7. **Never handle tokens.** Do not run `site add`, `site token`, `site remove` or
   `site default` on the user's behalf unless they ask, and never put a token on a command line.

## Reading

```bash
edutools courses [--all] --json               # --all includes concluded courses
edutools assignments <course_id> --json
edutools students <course_id> --json
edutools submissions <course_id> <assignment_id> --json
edutools ungraded <course_id> --json          # everything still needing a grade
edutools groups <course_id> --json            # assignment groups and their weights
edutools modules <course_id> --json           # modules, each with its items under "items"
```

Ids are what these commands are for: get the assignment id from `assignments`,
the student user id from `students`. Do not ask the user for an id you can look
up. **Always pass the ids.** A course or assignment id left off is prompted for
interactively, which an agent cannot answer.

## Snapshotting a whole course

`pull` writes everything a course contains to a directory, as Canvas stores it.
It only reads, so it is safe on any course the user names. Reach for it when the
user wants a backup, wants to compare the course across two dates, or when you
need to read a lot of course content: one pull and then reading files beats
dozens of separate commands.

```bash
edutools pull <course_id>                        # into ./canvas-<course_id>
edutools pull <course_id> --out ~/backups/cs121
edutools pull <course_id> --only pages --only assignments
edutools pull <course_id> --json                 # print index.json when done
```

What lands where:

```
index.json                    every path the pull wrote, and any problems
course.json, syllabus.html
pages/<url>.json, .html
assignments/<id>-<slug>.json, .html
discussions/<id>-<slug>.json, .html
announcements/<id>-<slug>.json, .html
quizzes/<id>-<slug>.json, .html, .questions.json
modules.json                  modules with their items nested
assignment_groups.json, rubrics.json
folders.json, files.json
files/<folder>/<name>         the course files themselves
```

The `.html` is the body, as Canvas holds it, after its sanitizer. Pulling again
into the same directory refreshes it and removes what an earlier pull wrote for
objects that are gone; nothing else in the directory is touched.

- **A snapshot is not a course repository.** Nothing is converted to markdown, and
  `push` cannot read it.
- **Student work is not in it**: no submissions, grades, or discussion replies.
  Use `download` for submissions.
- **A New Quizzes quiz shows up only as its assignment**, with no questions.
- **`files.json` holds download urls that may work without a login.** Do not
  paste them anywhere public.

## Creating, changing, and removing one object

The five kinds are `page`, `assignment`, `discussion`, `quiz`, `module`.
`--course` / `-c` is required on all five commands.

```bash
edutools create <kind> --course <id> --title "..." [options]
edutools update <kind> <object_id> --course <id> [options]
edutools delete <kind> <object_id> --course <id> [--yes] [--json]
edutools publish <kind> <object_id> --course <id> [--json]
edutools unpublish <kind> <object_id> --course <id> [--json]
```

Shared options on `create` and `update`:

| Option | Applies to | Notes |
| --- | --- | --- |
| `--title` / `-t` | all | Defaults to the `#` heading of a markdown `--body-file` |
| `--body-file` / `-f` | all but module | `.md` is rendered as `push` renders it; anything else is sent as-is |
| `--body` | all but module | Literal HTML, for something short |
| `--points` / `-p` | assignment, discussion | A quiz scores from its questions instead |
| `--due` `--unlock` `--lock` | assignment, discussion, quiz | ISO 8601, **with an offset**: `2026-10-14T23:59:00-06:00` |
| `--position` | module | 1-based |
| `--publish` / `--no-publish` | `create` only | Unpublished is the default |
| `--publish` / `--unpublish` | `update` only | Two separate flags; both at once is an error, neither leaves visibility alone |
| `--set key=value` | all | Any Canvas field not modelled above; repeatable |
| `--json` | all | Emit the resulting object |

`--set` is the escape hatch and it is worth remembering, because the flags above
cover the common fields and nothing else:

```bash
edutools create assignment -c 12345 --title "Lab 7" --points 50 \
    --set 'assignment[submission_types][]=online_upload' \
    --set 'assignment[grading_type]=points' \
    --set 'assignment[omit_from_final_grade]=true'
```

`update` sends only the fields you name, so it never clears anything you did not
mention. To change one thing, pass one flag. With no field at all it exits 1.

`delete` reads the object first and asks on stderr before deleting; without
`--yes` it needs an answer on stdin, and anything but `y` leaves the object alone
(exit 0). Publishing a module publishes everything in it.

### Gotchas

- **A page is addressed by its url slug** (`week-1`), not a numeric id. Everything
  else uses its id. `edutools create page --json` prints the slug it got.
- **Markdown bodies go through the same pipeline as `push`**, rendered in
  process: nothing external needs to be installed. Prefer a markdown
  `--body-file` over hand-writing HTML.
- **Canvas strips HTML silently and still answers 200.** `<style>`, `<link>`,
  `<script>`, and CSS properties outside its allowlist vanish. Prefer markdown
  `--body-file` over hand-rolled HTML, and for repo-published content run
  `edutools verify` to prove what landed.
- **Canvas refuses to unpublish anything with student submissions.** The error
  says so; that is Canvas, not a bug.

### Assignment groups

`edutools groups <course_id>` prints the groups, their weights, how many
assignments are in each, and whether the course weights the final grade by group
at all. That last part matters: Canvas stores a `group_weight` on every group and
ignores all of them until the course-level setting is on, so weights that look
right can still be doing nothing.

For a repo-backed course the groups are declared in `canvas.toml` and land with
`push`, so do not create or reweight them by hand:

```toml
[[group]]
name   = "Projects"
weight = 10
kinds  = ["project"]
```

Two things to know before editing those blocks:

- **Groups are paired up by name.** Changing the name in `canvas.toml` does not
  rename the group in Canvas, it creates a second one beside it. Read the current
  names with `edutools groups` and match them character for character.
- **An omitted `weight` means the weight is managed in Canvas**, not that it is
  zero. The push positions and names the group but never writes a weight, which is
  how an extra credit group that is raised by hand before final grades survives a
  later push.

### When to use `push` instead

If the course lives in a repository of markdown with a `canvas.toml`, use the
course repository commands below. Use `create`/`update` for one-off objects and
for courses that are not repo-backed. **Do not use `create`/`update` to patch an
object that `push` manages**: the next `push` will overwrite it. Edit the markdown
in the repo and push instead.

## Course repositories

A course repository is a directory of markdown with a `canvas.toml` at its root:
the term dates, date policies, assignment groups, and `[[module]]` tables. `push`
publishes it; the rest check it. The `README.md` in `~/repos/edutools`
documents the layout and every `canvas.toml` key; read it before editing
`canvas.toml`.

The usual loop, and the order to run it in:

```bash
edutools dates <repo> --json                       # due dates, from canvas.toml alone
edutools outline <repo>                            # the modules a push will build
edutools push <repo> --course <id> --dry-run       # render everything, write nothing
edutools push <repo> --course <id>                 # write it, unpublished, then verify
edutools audit <repo> --course <id> --json         # what Canvas holds that the repo did not put there
```

`dates` and `outline` need no token and never touch Canvas, so they are the
first thing to show a user who is changing the schedule or the module layout.
`dates` only prints; `push` is what writes the dates to Canvas. `dates --shift 7d`
previews the whole term moved by a week, and `outline --out <file>` writes the
outline as JSON (`outline` has no `--json`).

`dates --json` prints `{"items": [...], "problems": [...]}`. Each item has `path`,
`title`, `kind`, `week` (null in finals week), `points`, and `unlock_at`, `due_at`
and `lock_at` as the exact ISO strings `push` sends (`2026-10-14T23:59:00-06:00`;
`unlock_at` may be null). It exits 1 when `problems` is not empty; without
`--json` it lists the problems on stderr and exits 1 too.

### `push`

`--course <id>` is required.

| Option | Notes |
| --- | --- |
| `--dry-run` | Renders everything and writes nothing. Run it first. Needs no token, except with `--clean`. |
| `--path <file or glob>` | Push one correction, not the whole course. Repeatable. Skips the module rebuild. |
| `--only <group>` | `pages`, `assignments`, `discussions`, `quizzes`, `files`, `modules`, `syllabus`, `rubrics`, `groups`. Repeatable. |
| `--publish` | Makes what it writes visible. Leave it off unless asked. |
| `--update-published` | Also rewrites content students can already see. See rule 5. |
| `--preview <dir>` | Also writes the rendered HTML to a directory to inspect. It still pushes unless `--dry-run` is given too. |
| `--no-verify` | Skips the read-back that normally follows. Rarely right. |
| `--clean` | Start of term only: deletes every page, assignment, discussion, quiz and module the repo does not own, then pushes everything. See below. |
| `--yes` / `-y` | Only with `--clean`: skips its confirmation. Rule 4 applies. |

- **Without `--publish`, a push never changes visibility** of an object that
  already exists. It does not unpublish a live assignment.
- **A push that hits a problem exits 1** and lists each problem on stderr: a
  malformed `canvas.toml`, a `--path` that matches nothing (it lists the paths
  that exist), a file that fails to render, a Canvas error on one object. Read
  the list and report it; do not retry blindly.
- **A module is rebuilt from `canvas.toml`**: every item is removed and re-added
  from the table's `page`, `items`, and `canvas` lists. Something added to a
  repo-managed module by hand in Canvas disappears on the next push unless it is
  named under `canvas`. `audit` reports exactly those items.
- **A file marked `draft: true` in its frontmatter is not pushed.** Marking an
  already-pushed file as a draft orphans its Canvas object rather than deleting
  it; the push prints the path.
- **A gradable file that no `[[module]]` lists** is published but invisible to
  students, who find work through Modules. The push warns about each one; tell
  the user rather than letting the warning scroll by.
- **`--clean` deletes, so it follows rule 4.** Always run
  `push --clean --dry-run` first, show the user the delete list, and get a yes
  naming what goes before running it for real. It keeps course files, the front
  page, native module items and `[clean] keep`, and refuses if anything holds
  student work; never try to get past that refusal. It checks for student work
  once more right before deleting, since a student may submit between the list
  and the yes, and stops at the first failed delete. It cannot be combined with
  `--only` or `--path`. Never use it mid-term.
- **Retitling a page changes its Canvas url slug.** The push records the new one,
  so a module still finds it. A page created while an old page of the same title
  exists gets a `-2` slug; delete the old one (after confirming) if that matters.
- **Repo paths use forward slashes** in `--path`, `canvas.toml` and the manifest,
  on Windows too.

### Module tables

A `[[module]]` table can do more than list files. Read the README before
writing one; the short version:

```toml
[[module]]
title = "Module 5: Authentication"
week  = 5                          # name gets " (February 8 - February 14)"
page  = "notes/week-05-overview.md"
items = [
    { header = "Due by Thursday at 11:59 p.m. Mountain Time" },   # a text header
    "notes/week-05-notes.md",
    "discussions/d03.md",
    { header = "Due by Sunday at 11:59 p.m. Mountain Time" },
    "reminders/d03-replies.md",    # the `reminder` kind: an ungraded nudge
    { quiz = 393733, title = "5.04 Survey" },   # a Canvas-native item, kept in place
]
```

- **`week`** dates the module name from the term skeleton (`"finals"` for finals
  week). Modules are matched by name, and a module with the same title but other
  dates, or none, is renamed in place, so a new term does not duplicate them. A
  module whose title changes some other way is created fresh: rename the old one
  with `edutools update module <id> --course <id> --set 'module[name]=...'`
  before pushing.
- **`never_publish = true`** is for instructor-only modules. Every push writes the
  module and all it lists unpublished, whatever the flags, pulls back anything
  published in the Canvas UI (the one time a push rewrites published content),
  and locks the module until 2099. `verify` fails if any of it is published, and
  `outline` leaves it out. Never work around it with `publish` or `update`.
- **`publish = true`** is the opposite, for Course Resources and the like: the
  module and its contents are published on every push. A published module is
  still only rebuilt with `--update-published`, per rule 5.
- **`[icons]`** maps heading text to an image in the repo; the push uploads it and
  puts it in front of each matching h2/h3. Style it through `.cs-icon` in the
  repo's `canvas.css`, which the push inlines into every page.

### `verify` and `audit`

Both require `--course <id>`.

- `verify <repo> --course <id>` reads every object the repo pushed back from
  Canvas and compares it with what the repo says it should be. It catches the
  sanitizer stripping HTML, partial quiz writes, files stuck pending, and someone
  editing in the Canvas UI. `push` runs it automatically. It exits 1 when anything
  failed. With `--json` it prints
  `{"checked", "drafts", "failures": [{"key", "check", "detail"}]}`, where `key` is
  the repo path and `drafts` the paths skipped because they are now drafts.
- `audit <repo> --course <id> --json` answers the other direction: objects in
  Canvas the repo did not create (`untracked`, normal for a hand-built exam),
  modules `canvas.toml` declares that do not exist yet (`pending`), and manifest
  entries pointing at objects Canvas no longer has (`stale`). Only `stale` exits
  non-zero, because the next push would try to update something that is gone.

## Grading with feedback

The full loop:

```bash
edutools ungraded 12345 --json                            # what needs a grade
edutools submission -c 12345 -a 67890 -s 555 --json       # read one submission
edutools download -c 12345 -a 67890 --out ./submissions   # pull attachments down
edutools grade -c 12345 -a 67890 -s 555 --score 18 --comment "..."
```

Always pass `-c` and `-a`; left off, they are prompted for. `submission` requires
`-s`, and `download` requires `--out` (`-s` limits it to one student).

`submission --json` gives the submitted text, the attachment list, and any
comments already left. `download` writes `<out>/<user_id>/<filename>` plus
`submission.txt` for typed-in text, skipping files already present at the same
size. **Read the actual work before grading it.** Do not assign a score from a
filename or a submission timestamp.

### One student

```bash
edutools grade -c 12345 -a 67890 -s 555 --score 18 --comment "Clean tests, good naming."
edutools grade -c 12345 -a 67890 -s 555 --comment-file feedback.md   # longer feedback
edutools grade -c 12345 -a 67890 -s 555 --comment "See the note above."  # feedback, no score
edutools grade -c 12345 -a 67890 -s 555 --excuse
edutools grade -c 12345 -a 67890 -s 555 --score 15 --late-status late
```

`--score` takes whatever the assignment's grading type accepts: points (`18`), a
percentage (`92%`), a letter (`B+`), or `pass`/`fail`. A comment with no score
returns feedback without putting a number on the work, which is a real thing to
want. `--late-status` is one of `late`, `missing`, `extended`, `none`.

### A whole class

Write a file, dry run it, then send it:

```bash
edutools grade -c 12345 -a 67890 --from-file grades.json --dry-run
edutools grade -c 12345 -a 67890 --from-file grades.json
```

JSON, as a list of objects or an object keyed by student id. Column and key names
are matched loosely: `student`/`user_id`/`student_id`/`id`, `score`/`grade`/
`points`, `comment`/`feedback`.

```json
[
  {"student": 555, "score": 18, "comment": "Clean tests, good naming."},
  {"student": 556, "score": 12, "comment": "Error handling drops the exception - see line 40."},
  {"student": 557, "excuse": true}
]
```

CSV with a header row works too, and is inferred from a `.csv` filename (or
forced with `--csv`):

```csv
student_id,score,comment
555,18,"Clean tests, good naming."
556,12,"Error handling drops the exception."
```

A rubric assessment rides along per row, keyed by criterion id (get those from
the assignment's rubric):

```json
[{"student": 555, "rubric": {"crit_1": {"points": 4, "comments": "Good design."}}}]
```

`-` as the filename reads stdin, so a generated file need not be written to disk.
`--student` and `--from-file` cannot be combined.

Grading runs sequentially on purpose: Canvas throttles parallel writes, and the
loop reports exactly which students failed. A class of 40 takes well under a
minute.

### Feedback that is worth reading

When writing comments for a student, be specific and point at the work: name the
file and line, say what the consequence is, and say what would fix it. "Good job"
and "needs work" are not feedback. Match the tone and length the user asks for;
if they have not said, keep it to two or three sentences per student and keep it
about the code, not the person.

### The one thing edutools cannot do

If the assignment has a **manual posting policy**, the grade and comment land on
the submission but stay hidden from the student until the grades are posted.
Canvas exposes posting only through its GraphQL API, so `edutools` does not do it.
Write the grades, then tell the user to post them from the Canvas gradebook
(Gradebook -> the assignment's column menu -> Post grades).

## Changing edutools itself

`edutools` is the user's own project, at `~/repos/edutools`, a TypeScript npm
workspace. If a Canvas task genuinely cannot be expressed with the commands above,
adding to the tool is the right move rather than reaching for `curl`. That repo
has its own `CLAUDE.md` covering layout, checks, and Canvas API conventions. Read
it first. In short:

- A command is `packages/cli/src/commands/<name>.ts`, registered by one line in
  `COMMANDS` in `packages/cli/src/main.ts`.
- A Canvas endpoint is a method on `CanvasLMS` in `packages/core/src/canvas.ts`.
- Whole-course logic (push, verify, audit, clean, outline, dates) lives in
  `packages/core/src/course.ts`, which the CLI and the desktop app share.
- `npm run lint`, `npm run typecheck` and `npm run test` must pass, and
  `npm run edutools -- <command> ...` runs the CLI from source.

This skill lives in that repo too, at `skills/canvas/SKILL.md`; `~/.claude/skills/canvas`
is a symlink to it. A change to a command's name, flags, or `--json` output
updates this file in the same commit.
