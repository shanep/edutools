---
name: canvas
description: Work with Canvas LMS through the `edutools` CLI - list courses, students, assignments and submissions; create, update, delete, publish and unpublish pages, assignments, discussions, quizzes and modules; and grade submissions with written feedback. Use whenever the request touches Canvas, an LMS course, a gradebook, a course page or module, an assignment or quiz, student submissions, grading, or leaving feedback on student work.
---

# Canvas LMS

All Canvas work goes through `edutools`, a CLI already on `PATH`. Never call the
Canvas REST API directly with `curl` or a one-off script: `edutools` handles
auth, pagination, throttling, retries, and the per-kind field names that Canvas
gets fussy about.

Run `edutools --help`, or `edutools <command> --help`, whenever the exact flags
matter. This file covers what the help text cannot: which command to reach for,
and what goes wrong.

## Before anything else

```bash
edutools check                 # confirms the token works
edutools courses --json        # the course ids you are allowed to touch
```

If `check` fails, the token is missing from `~/.config/edutools/config.toml`.
Tell the user to run `edutools init` and paste a token from Canvas (Account ->
Settings -> Approved Integrations -> + New Access Token). Do not try to work
around a missing token.

Every read command takes `--json` and prints the raw Canvas payload. **Always use
`--json` when you need to read a value**; parse that, never the Rich table.

## Rules that are not negotiable

Canvas writes are immediate and land on real courses with real students.

1. **Never write to a course id the user did not give you.** If the course is
   ambiguous, list courses and ask which one. Do not guess from a name match.
2. **Create unpublished.** `create` and `push` leave objects invisible to students
   unless `--publish` is passed. Keep that default; publish as a separate,
   deliberate step once the user has seen what was made.
3. **Dry run first for anything bulk.** `grade --dry-run` and `push --dry-run`
   print exactly what would be sent and write nothing. Show that output before
   writing.
4. **Deleting cascades.** Removing an assignment, quiz, or graded discussion takes
   its submissions and grades with it, irreversibly. Confirm with the user first,
   naming the object. Do not pass `--yes` unless the user has already confirmed
   that specific object in this conversation.
5. **Report what actually happened.** `grade` and `push` print a per-row result
   table and exit non-zero on failure. If rows failed, say which ones and why.

## Reading

```bash
edutools courses [--all] --json               # --all includes concluded courses
edutools assignments <course_id> --json
edutools students <course_id> --json
edutools submissions <course_id> <assignment_id> --json
edutools ungraded <course_id> --json          # everything still needing a grade
edutools groups <course_id> --json            # assignment groups and their weights
```

Ids are what these commands are for: get the assignment id from `assignments`,
the student user id from `students`. Do not ask the user for an id you can look
up.

## Creating, changing, and removing one object

The five kinds are `page`, `assignment`, `discussion`, `quiz`, `module`.

```bash
edutools create <kind> --course <id> --title "..." [options]
edutools update <kind> <object_id> --course <id> [options]
edutools delete <kind> <object_id> --course <id>
edutools publish <kind> <object_id> --course <id>
edutools unpublish <kind> <object_id> --course <id>
```

Shared options on `create` and `update`:

| Option | Applies to | Notes |
| --- | --- | --- |
| `--title` / `-t` | all | Defaults to the `#` heading of a markdown `--body-file` |
| `--body-file` / `-f` | all but module | `.md` is rendered through pandoc; anything else is sent as-is |
| `--body` | all but module | Literal HTML, for something short |
| `--points` / `-p` | assignment, discussion | A quiz scores from its questions instead |
| `--due` `--unlock` `--lock` | assignment, discussion, quiz | ISO 8601, **with an offset**: `2026-10-14T23:59:00-06:00` |
| `--position` | module | 1-based |
| `--publish` / `--no-publish` | all | `update` uses `--publish` / `--unpublish` |
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
mention. To change one thing, pass one flag.

### Gotchas

- **A page is addressed by its url slug** (`week-1`), not a numeric id. Everything
  else uses its id. `edutools create page --json` prints the slug it got.
- **Markdown bodies go through the same pipeline as `push`**, which needs `pandoc`
  on `PATH`. If pandoc is missing the command says so; install it rather than
  hand-writing HTML.
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

If the course lives in a repository of markdown with a `canvas.toml`, the whole
course is published with `edutools push <repo> --course <id>` and checked with
`edutools verify <repo> --course <id>`. Use `create`/`update` for one-off objects
and for courses that are not repo-backed. **Do not use `create`/`update` to patch
an object that `push` manages**: the next `push` will overwrite it. Edit the
markdown in the repo and push instead.

## Grading with feedback

The full loop:

```bash
edutools ungraded 12345 --json                            # what needs a grade
edutools submission -c 12345 -a 67890 -s 555 --json       # read one submission
edutools download -c 12345 -a 67890 --out ./submissions   # pull attachments down
edutools grade -c 12345 -a 67890 -s 555 --score 18 --comment "..."
```

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
want.

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

CSV with a header row works too, and is inferred from a `.csv` filename:

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

`edutools` is the user's own project, at `~/repos/edutools`. If a Canvas task
genuinely cannot be expressed with the commands above, adding to the tool is the
right move rather than reaching for `curl`. That repo has its own `CLAUDE.md`
covering layout, checks, and Canvas API conventions. Read it first.
