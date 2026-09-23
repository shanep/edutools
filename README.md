# Edu Tools

A command line tool and a desktop app for Canvas LMS. The `edutools` command reads
course data out of Canvas (courses, assignments, modules, students, submissions,
ungraded work), snapshots a whole course to disk, publishes a course repository of
markdown into Canvas pages, assignments, discussions, quizzes and modules, edits
individual Canvas objects, and grades submissions with written feedback.

Every read command can emit raw JSON with `--json`, so the output is easy to parse
from a script or an agent instead of scraping table borders. With `--json`, stdout
carries the JSON and nothing else; prompts, progress and errors go to stderr.

The desktop app does the same course work with windows and buttons, for an
instructional designer who does not use a terminal; see [Desktop app](#desktop-app)
and [the designer guide](docs/designer-guide.md).

Both the CLI and the app are TypeScript on Node, and run on macOS, Windows and
Linux. Nothing shells out to an external program: markdown is rendered in process.

## Download the desktop app

These links always point at the newest release:

- [macOS, Apple Silicon (M1 and later)](https://github.com/shanep/edutools/releases/latest/download/edutools-mac-arm64.dmg)
- [macOS, Intel](https://github.com/shanep/edutools/releases/latest/download/edutools-mac-x64.dmg)
- [Windows](https://github.com/shanep/edutools/releases/latest/download/edutools-windows-x64-setup.exe)

Not sure which Mac you have? Open the Apple menu, choose About This Mac, and look
at the Chip line: Apple M-anything is Apple Silicon, Intel is Intel.

On a Mac, open the `.dmg` and drag edutools into Applications. On Windows, run the
installer. The builds are not signed yet, so the first launch needs one extra step:

- **macOS** says the app cannot be verified. Click Done, open System Settings ->
  Privacy & Security, scroll down to the message about edutools, and click Open
  Anyway.
- **Windows** SmartScreen says it protected your PC. Click More info, then Run
  anyway.

Older versions and release notes are on the
[releases page](https://github.com/shanep/edutools/releases). Then see
[Desktop app](#desktop-app) and [the designer guide](docs/designer-guide.md).

## Install the CLI

You need Node 22.14 or newer, and npm. From a checkout of this repository:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci        # the CLI never needs the Electron binary
npm run install:cli                           # builds the bundle and puts edutools on PATH
edutools --version
```

`npm run install:cli` runs the two steps you would otherwise type by hand:
`npm run build --workspace @edutools/cli`, which bundles
`packages/cli/dist/edutools.js`, then `npm install -g ./packages/cli`.

`npm install -g` of a folder links it rather than copying it (`cd packages/cli &&
npm link` does the same thing), so the `edutools` on `PATH` is this checkout. Two
things follow from that:

- After pulling changes, rebuild with `npm run build --workspace @edutools/cli`.
  There is nothing to reinstall.
- The bundle loads its two native modules (`@napi-rs/keyring` and
  `@css-inline/css-inline`) from the checkout's `node_modules`, so keep the
  checkout and rerun `npm ci` if you clear it.

To remove it: `npm uninstall -g @edutools/cli`.

Without installing anything, `npm run edutools -- <command> ...` runs the CLI
straight from the TypeScript source. npm runs it from the repository root, so a
relative path in its arguments is relative to the root, not to where you typed it.

## Setup

### Canvas sites and tokens

Credentials are a list of Canvas **sites**, each a short name and an endpoint,
with one of them the default. The token for a site lives in the OS keychain
(macOS Keychain, Windows Credential Manager, the Secret Service on Linux) under
the service `edutools`, keyed by the site's endpoint. The site list itself holds
no secrets and lives in `sites.json` in the platform config directory:

| Platform | Site list |
| --- | --- |
| macOS | `~/Library/Application Support/edutools/sites.json` |
| Windows | `%APPDATA%\edutools\sites.json` |
| Linux | `$XDG_CONFIG_HOME/edutools/sites.json`, else `~/.config/edutools/sites.json` |

The desktop app's Settings screen and the CLI read and write the same list and the
same keychain entries.

Get a token from Canvas: **Account -> Settings -> Approved Integrations -> + New
Access Token**. Then add the site:

```bash
edutools site add bsu --endpoint https://boisestatecanvas.instructure.com
edutools check
```

`site add` asks for the token at a hidden prompt, or reads the first line of stdin
when piped (`pbpaste | edutools site add bsu --endpoint ...`). It never takes the
token as a flag, so the token never lands in shell history or a process listing.
The first site added becomes the default.

```bash
edutools site list [--json]        # every site, which is the default, and a masked hint of each token
edutools site token <name>         # replace a site's token, e.g. after it expires
edutools site default <name>       # the site commands use when --site is not given
edutools site remove <name>        # drop a site and delete its token from the keychain
edutools --site <name> <command>   # use another site for one command
```

`site token` reads the new token the same way `site add` does, at a hidden prompt
or from the first line of stdin (`pbpaste | edutools site token bsu`), and keeps
the site's name and endpoint. The desktop app's Settings screen can replace a
token too.

### Moving from the old config.toml

Earlier versions kept the token in plain text in `~/.config/edutools/config.toml`.
`edutools init` imports it: the token moves into the keychain, under a new site
named after the endpoint's host, or replacing the token of a site that already
uses that endpoint. The old file is left in place for you to delete. `init` then
prints the setup status: every site, whether it has a token, and what to do next.
With no old file it only prints the status.

### Environment variables

`CANVAS_TOKEN` and `CANVAS_ENDPOINT` still work, for CI and scripts that have no
keychain, and they override the saved sites:

1. `CANVAS_TOKEN` wins over everything. Its endpoint is `CANVAS_ENDPOINT`, else the
   chosen site's endpoint, else `https://boisestatecanvas.instructure.com`.
2. `CANVAS_ENDPOINT` alone picks the keychain token saved for that endpoint.
3. Otherwise the `--site` site, or the default site, with its keychain token.

`edutools check` says which of these it used.

## Commands

Options marked *required* must be given; commander's `--help` lists them among the
other options without saying so. A course or assignment id shown as optional is
prompted for, from a numbered list on stderr, when it is left off.

```
edutools [--site <name>] <command>                 every command; --site picks a Canvas site
edutools --version | -V                            print the version

edutools init                                      import an old config.toml token, show setup status
edutools check [--json]                            verify the credentials work
edutools site list [--json]                        list sites and token hints
edutools site add <name> --endpoint <url>          add a site; the token is prompted for or piped
edutools site token <name>                         replace a site's token; prompted for or piped
edutools site remove <name>                        remove a site and its keychain token
edutools site default <name>                       make a site the default

edutools courses [-a|--all] [--json]               courses where you are a teacher
edutools assignments [course_id] [--json]          assignments in a course
edutools modules [course_id] [--json]              modules and the items in each
edutools groups [course_id] [--json]               assignment groups, weights, and contents
edutools students [course_id] [--json]             students in a course
edutools submissions [course_id] [assignment_id] [--json]
                                                   submissions for one assignment
edutools ungraded [course_id] [--json]             submissions with no grade set
edutools pull [course_id] [-o|--out <dir>] [--only <kind>]... [--json]
                                                   snapshot the whole course to disk

edutools push <repo> --course <id> [options]       publish a course repo into Canvas
edutools verify <repo> --course <id> [--json]      read published content back and prove it landed
edutools audit <repo> --course <id> [--json]       compare the manifest with the live course, both ways
edutools outline <repo> [--out <file>]             the module outline a push builds, from the repo alone
edutools dates <repo> [--show] [--shift <Nd>] [--json]
                                                   due dates computed from canvas.toml

edutools create <kind> -c <id> [options]           create one page/assignment/discussion/quiz/module
edutools update <kind> <object_id> -c <id> [options]
                                                   change one object
edutools delete <kind> <object_id> -c <id> [-y] [--json]
                                                   delete one object (asks first)
edutools publish <kind> <object_id> -c <id> [--json]
                                                   make one object student-visible
edutools unpublish <kind> <object_id> -c <id> [--json]
                                                   hide one object from students

edutools submission [-c <id>] [-a <id>] -s <id> [--json]
                                                   one submission with its comments
edutools download [-c <id>] [-a <id>] -o <dir> [-s <id>]
                                                   download submission attachments
edutools grade [-c <id>] [-a <id>] -s <id> [grading options]
                                                   grade one submission, with feedback
edutools grade [-c <id>] [-a <id>] --from-file <file|-> [--csv] [--dry-run]
                                                   grade a batch from JSON or CSV
```

Exit codes: 0 on success, 1 when a command fails or finds a problem (a failed
push, verify failures, a stale audit entry, a declined confirmation), and 2 for a
usage error such as a missing required option.

`push` takes these flags:

```
--course <id>          Canvas course ID (required)
--dry-run              render everything, write nothing to Canvas; needs no token
                       unless combined with --clean
--publish              make the objects student-visible (default: unpublished)
--update-published     also rewrite content students can already see
--only <group>         limit to pages, assignments, discussions, quizzes, files,
                       modules, syllabus, rubrics, or groups (repeatable)
--path <file>          limit to specific repo files, exact or glob (repeatable)
--verify               read everything back afterwards (the default)
--no-verify            skip that read-back
--preview <dir>        also write the rendered HTML to a directory; still pushes unless --dry-run
--clean                start of term: delete what the repo does not own, then push all
-y, --yes              with --clean, skip the confirmation prompt
```

`create` and `update` share these:

```
-c, --course <id>      Canvas course ID (required)
-t, --title <title>    title; on create, defaults to the H1 of a markdown --body-file
--body <html>          body as literal HTML
-f, --body-file <path> body from a file; .md is rendered as push renders it
-p, --points <n>       points possible (assignments and graded discussions)
--due <date>           due date, ISO 8601 with an offset (2026-09-15T23:59:00-06:00)
--unlock <date>        available-from date, ISO 8601
--lock <date>          available-until date, ISO 8601
--position <n>         module position, 1-based
--set <key=value>      any other Canvas field (repeatable)
--json                 emit the resulting object as JSON
```

`create` also takes `--publish` and `--no-publish` (the default). `update` takes
`--publish` or `--unpublish`, which are two separate flags; passing both is an
error, and passing neither leaves visibility alone.

`grade` takes:

```
-c, --course <id>        Canvas course ID (prompted if omitted)
-a, --assignment <id>    assignment ID (prompted if omitted)
-s, --student <id>       student user ID (omit with --from-file)
--score <grade>          points ('18'), percent ('92%'), letter ('B+'), or pass/fail
--comment <text>         feedback comment
--comment-file <path>    feedback comment from a file
--excuse                 excuse the student from the assignment
--late-status <status>   late, missing, extended, or none
--from-file <path>       grade a batch from JSON or CSV; '-' reads stdin
--csv                    treat --from-file as CSV (inferred from a .csv name)
--dry-run                show what would be sent, write nothing
```

### Reading course data

```bash
edutools courses                 # active courses you teach
edutools courses --all           # include concluded and unpublished courses
edutools courses --json          # raw JSON instead of a table

edutools assignments 12345
edutools modules 12345           # each module with its items; --json nests them under "items"
edutools groups 12345            # assignment groups, their weights, and their size
edutools students 12345
edutools submissions 12345 67890
edutools ungraded 12345
```

Without `--json` these print a table meant for humans. With `--json` they print
the API payload verbatim, which is the mode to use when another program is
consuming the output.

`check --json` always prints one object on stdout. On success it is
`{"ok": true, "endpoint", "source", "site", "courses"}`: where the credentials came
from (`env` or `keychain`), which site, and how many courses the token can see.
When the credentials are missing or rejected it is
`{"ok": false, "endpoint", "error"}` (`endpoint` is null when no site is set up),
with the explanation on stderr too, and it exits 1.

### Snapshotting a course

`pull` writes everything a course contains to a directory, exactly as Canvas
stores it. Nothing is converted, so the snapshot is lossless: a backup, something
to diff between two dates, or input an agent can read without a token. It is not a
course repo, and `push` cannot read it.

```bash
edutools pull 12345                         # into ./canvas-12345
edutools pull 12345 --out ~/backups/cs121   # somewhere else
edutools pull 12345 --only pages --only assignments
edutools pull 12345 --json                  # print index.json when done
```

```
index.json                    every path this pull wrote, and any problems
course.json                   the course, including syllabus_body
syllabus.html
pages/<url>.json, .html       one pair per page, named by its url slug
assignments/<id>-<slug>.json, .html
discussions/<id>-<slug>.json, .html
announcements/<id>-<slug>.json, .html
quizzes/<id>-<slug>.json, .html, .questions.json
modules.json                  every module with its items nested under "items"
assignment_groups.json
rubrics.json
folders.json, files.json      the raw listings
files/<folder>/<name>         each course file, in its Canvas folder
```

The `.html` file is the body (a page's `body`, an assignment's `description`,
a topic's `message`) and is left out when the body is empty. `--only` takes
`syllabus`, `pages`, `assignments`, `discussions`, `announcements`, `quizzes`,
`modules`, `groups`, `rubrics` or `files`, and is repeatable; `course.json` is
written every time. Every name written to disk is legal on Windows as well, so a
snapshot taken on one platform reads on the others.

Pulling again into the same directory refreshes it. A course file already on
disk at the size and time Canvas reports is not downloaded again. Anything an
earlier pull wrote for an object Canvas no longer has, or under a title that has
since changed, is removed; `index.json` is how the pull knows what it wrote, and
nothing else in the directory is touched. An object or a whole kind that cannot
be fetched keeps its previous copy, is listed as a problem, and makes the command
exit non-zero.

Student work is not part of the snapshot: submissions, grades and discussion
replies stay behind (`download` fetches submissions). A quiz built with New
Quizzes arrives only as its assignment, with no questions, since the classic
quizzes API cannot see it. `files.json` holds each file's download url, which
carries a verifier that can work without a login, so treat a snapshot as you
would the course itself.

### Publishing a course repo

```bash
edutools dates ./cs121 --show                     # due dates computed from canvas.toml
edutools push ./cs121 --course 12345 --dry-run    # render everything, write nothing
edutools push ./cs121 --course 12345              # create and update the Canvas objects
edutools verify ./cs121 --course 12345            # read the content back and compare
```

Objects are created **unpublished** unless `--publish` is given, so a push is safe to
run against a live course before students should see the content. `push` runs
`verify` automatically when it finishes; pass `--no-verify` to skip that. A dry run
reads nothing from Canvas, so it needs no token; `--clean --dry-run` is the
exception, since listing what to delete means reading the course.

A push that hits a problem (a malformed `canvas.toml`, a `--path` that matches
nothing, a file that fails to render, a Canvas error on one object) lists every
problem and exits 1. `--preview <dir>` also writes each rendered page as an HTML
file to look at in a browser. It does not stop the push: without `--dry-run` the
push still writes to Canvas, so combine the two to render without writing.

`verify` walks the manifest and proves each tracked object is still in Canvas and
intact, exiting 1 when anything failed. `verify --json` prints
`{"checked", "drafts", "failures": [{"key", "check", "detail"}]}` instead of the
table, with the same exit code. `audit` asks the other question too: what does Canvas hold that no repo
file produced, and what does the manifest still track that Canvas no longer has.

```bash
edutools audit ./cs121 --course 12345             # stale and untracked, as a table
edutools audit ./cs121 --course 12345 --json      # the same, for scripts
```

Untracked objects are normal (a hand built exam quiz, a file uploaded in the UI)
and are only reported, as is a pending module, one that `canvas.toml` declares and
the next push will create. A stale manifest entry, an object deleted in Canvas since the last
push, exits non-zero because the course no longer matches the repository. If the repo
file is still there, the next push creates the object again. If the removal was
deliberate, delete the repo file (or mark it a draft) and drop its entry from
`.canvas/manifest-<id>.json`. The audit also lists any item sitting in a
repo-managed module that neither the manifest nor the module's `canvas` list
knows about, since the next push rebuilds that module without it.

`outline` needs no token at all. It prints the modules a push will build, item by
item with due dates and points, from `canvas.toml` and the files themselves; with
`--out` it writes that as JSON, which is how a course website renders a schedule
page that matches Canvas's Modules page exactly. The JSON is byte for byte what
earlier versions wrote, so a site that commits it sees no churn.

### Modules

Each `[[module]]` table in `canvas.toml` becomes a Canvas module, in the order
written. `page` is the overview and `items` are the repo files it holds; both are
paths relative to `canvas.toml` and must have been published. A push deletes every
item in the module and rebuilds it from this list, so the repo is the source of
truth for what a module contains.

Some things belong in a module but have no repo file: an exam quiz built in the
Canvas UI, a file uploaded by hand. Name them under `canvas` and the rebuild keeps
them, after the repo items and in the order written:

```toml
[[module]]
title  = "Week 8: Midterm Exam"
page   = "notes/midterm-review.md"
canvas = [
    { quiz = 394147 },
    { quiz = 393662, title = "Midterm Exam" },
]
```

Each entry names exactly one of `page` (by url slug), `assignment`, `discussion`,
`quiz` or `file` (by numeric id), plus an optional `title`; without one Canvas shows
the object's own name. Ids come from `edutools assignments`, `edutools audit`, or the
address bar. A malformed entry is reported as an error for that module rather than
built around.

A module can also carry text headers, and a native item can sit at a particular
point instead of after the repo items. Both go straight into `items`:

```toml
[[module]]
title = "Module 5: Authentication and Credentials"
week  = 5
page  = "notes/week-05-overview.md"
items = [
    { header = "Due by Thursday at 11:59 p.m. Mountain Time" },
    "notes/week-05-authentication-and-credentials.md",
    "discussions/d03-authentication-policy-critique.md",
    { header = "Due by Sunday at 11:59 p.m. Mountain Time" },
    "reminders/d03-replies.md",
    { quiz = 393733, title = "5.04 Survey" },
]
```

A `{ header = "..." }` becomes a Canvas text header (a SubHeader item). `week`
names the module with its dates, as the Boise State Online shell does:
`Module 5: Authentication and Credentials (February 8 - February 14)`, Monday to
Sunday from the term skeleton, skipping the break and stopping at the last day of
instruction; `week = "finals"` uses the finals window. The dates move every term,
so a push that finds the same title with other dates, or with none, renames that
module rather than building a second one beside it.

A module for instructors only, such as the shell's Instructor Resources, says
`never_publish = true`. Every push then writes the module and everything it lists
unpublished, ignoring `--publish`; takes back anything someone published in the
Canvas UI, even though a push otherwise never rewrites published content; and
sets the module's unlock date to 2099, so a publish clicked between pushes still
shows students a locked module rather than its pages. `verify` fails on any of
it found published, and `outline` leaves the module out of the site's copy.

The opposite, `publish = true`, is for a module every student needs from day one,
such as Course Resources: the module and everything it lists are published by
every push, with or without `--publish`. If a file is in both kinds of module,
it stays hidden.

The `reminder` item kind is for the shell's ungraded "Replies" assignment that
sits under a later header than its discussion. Give it a
`[term.policy.reminder]`, a glob under `[layout.gradable]`, and
`grading: not_graded` in its frontmatter.

Students find their work through Modules, so a gradable file that no `[[module]]`
lists is published and yet invisible. A push names every such file it handled as a
warning, and `verify` reports each one as a `module` failure. A repo with no
`[[module]]` tables at all does not use modules and is left alone.

### Pushing one correction

`--path` limits a push to particular files, so a fix to one assignment does not
re-render the course:

```bash
edutools push ./cs425 --course 48194 --path assignments/p1.md
edutools push ./cs425 --course 48194 --path 'assignments/p*.md' --path index.md
```

It takes a repo-relative path or a glob and is repeatable, and a pattern matching
nothing is an error that lists the paths available, rather than a silent no-op.
Paths are written with forward slashes on every platform, Windows included. The
full pipeline still runs for what is selected, so dates, links, rubric and styling
all come from the repository. Whole-course module rebuilding is skipped, since
that is a structural change rather than a correction.

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
`canvas.toml`, and needs no token. It only prints: the dates reach Canvas when
`push` writes each item. `--show` prints the computed schedule; `--shift 7d` (or
`-3d`) previews the whole term moved. Any inconsistency with the syllabus schedule
is listed and exits 1.

`dates --json` prints `{"items": [...], "problems": [...]}`. Each item has `path`,
`title`, `kind`, `week` (null in finals week), `points`, and `unlock_at`, `due_at`
and `lock_at` as the ISO 8601 strings `push` sends Canvas
(`2026-10-14T23:59:00-06:00`; `unlock_at` is null when there is none). It exits 1
when `problems` is not empty.

### Course repository layout

By default a course repo looks like this, and a repo shaped this way needs no
`[layout]` section at all:

```
canvas.toml            term skeleton, date policies, assignment groups, module layout
canvas.css             optional; inlined into every body, since Canvas strips <style>
syllabus.md            becomes the Canvas syllabus
objectives.md          published as a page
resources.md           published as a page
modules/*.md           published as pages
assignments/lab-*.md   published as assignments
assignments/*-exam-guide.md   published as pages
quizzes/quiz-*.md      published as quizzes
discussions/*.md       published as discussions
docs/*.pdf, data/*     uploaded as files
.canvas/manifest-<course_id>.json   written by push: which Canvas object each file became
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
`[layout.gradable]` are item kinds (`lab`, `project`, `extra`, `quiz`, `discussion`, `exam`),
and each needs a matching `[term.policy.<kind>]` to compute its dates from.

`discussions` lists ungraded discussions, such as a Course Questions board: they
are pushed with no points, group or dates, so Canvas keeps them out of the
gradebook. They are matched before `pages`, so a board can sit in a directory a
page glob also covers.

Every path in `canvas.toml` and in the manifest uses forward slashes, on Windows
too, so one repository works from any platform.

### Clean sync at the start of a term

A course copied from a shell, or from last term, holds objects the repo did not
make: template placeholders, last term's pages. `push --clean` makes the course
exactly the repo:

```bash
edutools push ./cs331 --course 12345 --clean --dry-run   # list what it would delete
edutools push ./cs331 --course 12345 --clean             # delete, confirm, then push
```

It deletes every page, assignment, discussion, quiz and module the repo does not
own, forgets manifest entries for objects Canvas no longer has, and then pushes
everything with `--update-published`. It never deletes course files, the front
page, a native item a `[[module]]` names, or anything listed to keep:

```toml
[clean]
keep = [{ quiz = 393731 }, { page = "welcome" }]
```

It refuses outright if anything it would delete holds student work
(submissions, or posts in a discussion), because deleting a graded object takes
its grades with it. It asks before deleting unless given `--yes`, and it cannot
be combined with `--only` or `--path`. Time passes between the list and the yes,
so right before deleting it checks every graded target for student work again,
and re-reads the repository so a `canvas.toml` broken in the meantime stops the
push while the course is still intact. Deletion stops at the first failure.

### Heading icons

The Boise State Online course shell puts a small icon in front of each section
heading. Canvas keeps `<img>` but strips CSS generated content, so the icon has
to be markup, and it has to point at a file in the course being pushed to.
An `[icons]` table names one image per heading:

```toml
[icons]
"learning objectives"   = "icons/list.svg"
"assignments and tasks" = "icons/task.svg"
"due by *"              = "icons/task.svg"
```

Each key is matched, ignoring case, against the visible text of every `h2` and
`h3` (`*` and `?` work as in a shell glob), and the first match wins. The push
uploads each image as a course file without a `[layout] files` entry, inserts
`<img class="cs-icon">` at the start of the heading, and points it at the
uploaded file's `/preview` URL, so the icons follow the course through a copy.
A path that does not exist fails the push. Style the image through `.cs-icon`
in `canvas.css`.

A push never uploads a second copy of a file the course already holds. Before
uploading an icon or any other repo file, it looks for a course file with exactly
the same bytes, whatever its name or folder, and records that one instead. A course
copied from a shell arrives with the shell's icon set, often under other names
(`AI Allowed.svg` for `ai-allowed.svg`), and its pages then use those. The file the
manifest already records is kept while it still matches; otherwise the oldest match
wins. A hidden or locked file is never reused, since students could not load it.

### VitePress source

A course directory can be served as a website and pushed to Canvas at the same
time. `push` resolves the VitePress-only syntax that would otherwise reach Canvas
as literal text:

| In the markdown | In Canvas |
| --------------- | --------- |
| YAML frontmatter | removed |
| `<!--@include: path.md-->` | the target file, inlined recursively |
| `::: danger` ... `:::` | a blockquote with a bold lead line |
| `<OfficeHoursLink />` and other capitalised tags | removed |
| `<script setup>` blocks | removed |

Ordinary lowercase HTML is left alone, and an include written inline in prose,
rather than alone on its own line, stays as text so it can be documented. An
include whose target does not exist fails the push, naming the file.

Markdown is GitHub flavoured: tables, task lists, footnotes, autolinks and fenced
code blocks all render, and headings get GitHub-style ids so `#section` links work.

### Drafts

A file whose frontmatter carries `draft: true` is not a Canvas object at all:

```markdown
---
draft: true
---

# A1 - Get on the Box
```

`push` does not create or update it, `dates` gives it no due date and does not
count its points, and the `[[module]]` that lists it is built without it rather
than reporting it as unpublished. A draft needs no `**Week N · P points**`
header line, so half written work can sit in the repo. `verify` ignores it too.

Marking an *already pushed* file as a draft does not delete anything. The push
drops the manifest entry, which is what stops `verify` checking an object the
repo no longer manages, and prints the path so you know the Canvas object is now
orphaned. Deleting it is left to you, since an assignment may already have
submissions against it.

Hiding a draft from the website as well is the site generator's job, not this
tool's. In VitePress that is `srcExclude`.

### Submission and grading types

Every assignment is created as `online_text_entry`, graded by points, which is
what a project that submits a repository link wants. An assignment that takes a
file, or is pass/fail, says so in its frontmatter:

```markdown
---
submission: online_upload, online_text_entry
grading: pass_fail
---

# Finding Typos, Bugs, and Improvements

**Week 16 · 10 points · extra credit · submit in Canvas**
```

`submission` is one or more of Canvas's submission types (`online_text_entry`,
`online_upload`, `online_url`, `media_recording`, `student_annotation`,
`on_paper`, `external_tool`, `none`), separated by commas; `grading` is one of
`points`, `pass_fail`, `percent`, `letter_grade`, `gpa_scale`, `not_graded`. A
value Canvas would reject is reported by the push, naming the file, rather than
as a 400. Both keys are ignored on anything that is not an assignment.

### Assignment groups

Canvas files every assignment, quiz and graded discussion under an assignment
group, and a course that weights by group computes the final grade from those
weights. Declare them in order with `[[group]]`:

```toml
[[group]]
name   = "Exams"
weight = 50

[[group]]
name   = "In Class Activities"
weight = 40
kinds  = ["lab", "discussion"]

[[group]]
name   = "Projects"
weight = 10
kinds  = ["project"]
```

`kinds` are the same item kinds `[layout.gradable]` uses, and each kind belongs to
at most one group. A group with no `kinds` is still created, which is how a course
whose exams are hand built quizzes gets an "Exams" group worth half the grade with
nothing in the repository to put in it.

A group that omits `weight` is created and positioned like any other, but its
weight is never written, so whatever Canvas holds survives every push. That is the
way to declare a group whose weight is managed by hand: an extra credit group that
sits at 0% all semester and is raised just before final grades are pushed keeps the
raised value, where a declared `weight = 0` would quietly put it back.

`push` creates the missing groups, corrects a weight or a position that has drifted,
and files each item into its group as it goes. Declaration order becomes the order
Canvas shows, so the gradebook reads the way the syllabus does. As soon as any group
declares a `weight`, the course itself is set to weight the final grade by group,
because Canvas stores weights and ignores them until that is on. A repo with no
`[[group]]` blocks leaves the course's groups and its weighting setting untouched.

Groups are matched by name, so renaming one in `canvas.toml` creates a second group
rather than renaming the first. Weights are not required to add to 100. A course
with an extra credit group on top of a full 100% is a normal thing to want, so
nothing here objects to it; run `edutools groups <course>` to see the sum Canvas is
working from.

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
edutools update page week-1 -c 12345 --unpublish
edutools publish assignment 98765 -c 12345
edutools unpublish page week-1 -c 12345
edutools delete assignment 98765 -c 12345
```

Like `push`, `create` leaves an object **unpublished** unless `--publish` is given.
A `.md` file passed to `--body-file` goes through the same markdown rendering and
Canvas-safe HTML pipeline that `push` uses, and its `#` heading becomes the default
title; any other file is sent as it is. `update` sends only the fields you name,
so it never clears anything you did not mention, and with no field at all it
exits 1 rather than sending an empty update. `delete` reads the object first,
prints what it is about to remove, and asks for confirmation unless `--yes` is
given; answering no exits 0 and leaves it alone. Publishing a module publishes
everything in it, and Canvas refuses to unpublish anything with student
submissions.

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
edutools grade -c 12345 -a 67890 -s 555 --score 15 --late-status late
```

`download` writes `<out>/<user_id>/<filename>`, plus `submission.txt` for any
typed-in text, and leaves an existing file of the same size alone.

`--score` takes whatever the assignment's grading type accepts: points (`18`), a
percentage (`92%`), a letter (`B+`), or `pass`/`fail`. A `--comment` with no
`--score` returns feedback without putting a number on the work.

A whole class at once comes from a file, as JSON (a list of objects, or an object
keyed by student id) or a CSV with a header row. Column names are matched loosely,
so `student`/`user_id`/`student_id`/`id`, `score`/`grade`/`points` and
`comment`/`feedback` all mean the same thing:

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
generate-grades | edutools grade -c 12345 -a 67890 --from-file -     # from stdin
```

A rubric assessment rides along per row, keyed by criterion id:
`{"student": 555, "rubric": {"crit_1": {"points": 4, "comments": "Good design."}}}`.

Grading is deliberately sequential: Canvas throttles parallel writes, and a
per-student loop reports exactly which rows failed. `--dry-run` prints the table it
would send and writes nothing; with `-c` and `-a` given it needs no token.

If the assignment uses a **manual posting policy**, a grade written here lands on
the submission but stays hidden from the student until it is posted from the Canvas
gradebook. Canvas exposes posting only through its GraphQL API, so `edutools` does
not do it.

## Desktop app

`packages/app` is an Electron app over the same core as the CLI, for working on a
course without a terminal. It shares the CLI's site list and keychain, so a site
added in either one is there in the other. Whole-course work (publish, clean sync,
verify, audit) runs through the same functions in `packages/core/src/course.ts` that
the CLI uses, so both reach the same results under the same safety rules.

**[The designer guide](docs/designer-guide.md)** walks through the app task by task
for an instructional designer. The screens:

- **Settings**: add and remove Canvas sites, test and save or replace their tokens,
  pick the default, and import the old `config.toml`.
- **Courses**: the courses you teach on the default site; open one to make it the
  current course.
- **Course overview**: the current course's assignments, modules, pages and
  assignment groups, as Canvas has them, each with Open in Canvas.
- **Snapshot**: `pull` with a window, with live progress and a result summary.
- **Outline** and **Dates**: the modules a push will build and the semester's due
  dates, computed from the chosen course repository alone. Outline exports the same
  JSON as `outline --out`; Dates previews a shifted term without writing anything.
- **Publish**: `push`, with Preview (the dry run) required before "Publish to
  Canvas" is enabled, and separate confirmations for making content visible and for
  rewriting published content. **Clean sync** is a separate, warned section: it shows
  the whole plan, refuses outright when anything it would delete holds student work,
  and otherwise needs the course code typed to confirm.
- **Verify** and **Audit**: `verify` and `audit`, with results explained in words.
- **Edit object**: create, change, publish, unpublish or delete one page,
  assignment, discussion, quiz or module. Changing something students can see needs
  an explicit checkbox, and a delete names what goes with it.

Only one Canvas job (snapshot, publish, clean sync, verify, audit) runs at a time.

### Getting the installers

Installers are built by CI (`.github/workflows/ci.yml`), not by hand. Run the CI
workflow from the Actions tab (`workflow_dispatch`), or push a `v*` tag. It builds a
`.dmg` for Apple Silicon and for Intel Macs and an NSIS `.exe` for Windows x64,
self-tests each packaged app on its own platform, and uploads them as workflow
artifacts (`edutools-mac`, `edutools-windows`). Download them from the run's page, or:

```bash
gh run download <run id>
```

A run started from the Actions tab stops there. A pushed `v*` tag goes on to
publish a GitHub release with the three installers attached, once every check and
both self-tests pass. Each installer is attached twice: once with the version in its
name, and once without (`edutools-mac-arm64.dmg`), which is what the
[download links](#download-the-desktop-app) at the top point at. A tag with a prerelease part (`v2.1.0-beta.1`) is published as
a prerelease, and re-running the workflow for a tag replaces its release's
installers.

Until signing certificates are set up the builds are unsigned (ad hoc signed on
macOS), so macOS asks you to approve the app under System Settings -> Privacy &
Security -> Open Anyway on first launch, and Windows SmartScreen warns before
running the installer (More info -> Run anyway). Signing and notarization switch on
by themselves once these repository secrets are set: `CSC_LINK` and
`CSC_KEY_PASSWORD` (a Developer ID Application certificate), `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (notarization), and `WIN_CSC_LINK`
and `WIN_CSC_KEY_PASSWORD` (a Windows code-signing certificate). The app icon comes
from `packages/app/resources/icon.icns` and `icon.ico`; without them it uses
Electron's default.

### Running it from the checkout

This needs the Electron binary, so run `npm ci` without
`ELECTRON_SKIP_BINARY_DOWNLOAD`:

```bash
npm run dev --workspace @edutools/app
```

`EDUTOOLS_SMOKE_TEST=1` launches the app against a fake Canvas, a throwaway config
folder and an in-memory token store, drives every screen, prints `SMOKE OK` and
exits; CI runs it on each packaged app. It never reads your keychain or contacts
Canvas.

## Development

### Layout

An npm workspace of three packages:

```
packages/core/src/   the library everything else is built on
  canvas.ts          the only module that talks HTTP to Canvas
  course.ts          whole-course orchestration: push, verify, audit, clean, outline, dates
  publisher.ts       the two-pass course-repo publisher (create objects, rewrite links)
  pull.ts            the course snapshot
  publish.ts         pure: markdown -> Canvas HTML, sanitizer allowlist, manifest
  verify.ts          pure: compares what Canvas holds with what the repo says
  audit.ts           pure: the manifest against the live course, both ways
  outline.ts         pure: the module outline a push builds
  dates.ts           pure: due dates from a canvas.toml term skeleton
  objects.ts         pure: per-kind Canvas field names, grade-file parsing
  credentials.ts     Canvas sites, and their tokens in the OS keychain
  paths.ts types.ts  POSIX repo keys and globbing; shared payload types
packages/cli/        the edutools command (commander), one file per command
packages/app/        the Electron desktop app (electron-vite, React)
```

Each package has a `test/` directory of vitest tests.

### Common tasks

From the repository root:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci      # install; drop the variable to work on the app
npm run lint                                # biome
npm run typecheck                           # tsc, strict, zero errors
npm run test                                # vitest
npm run check                               # all three
npm run edutools -- courses --json          # run the CLI from source
npm run build --workspace @edutools/cli     # bundle the CLI into packages/cli/dist/edutools.js
npm run install:cli                         # build the bundle and put edutools on PATH
```

CI runs lint, typecheck and test on macOS, Windows and Linux for every push and
pull request.

### Versions and releases

There is one version for the CLI, the desktop app and its installers, and it
comes from git: `scripts/version.cjs` reads `git describe` at build time.

- A build on a `v*` tag is that tag's version: `v1.2.0` builds `1.2.0`.
- A build past the newest tag is a prerelease of the next patch, named by its
  distance from the tag and its commit: five commits past `v1.2.0` builds
  `1.2.1-dev.5.gabc1234`. Uncommitted changes add `.dirty`.
- Running from source (`npm run edutools`, the tests) has no build step, so it
  reports `0.0.0-source`.

The `version` fields in the `package.json` files are placeholders (`0.0.0`) and are
never read. To release, run `scripts/create-release.sh` from master:

```bash
scripts/create-release.sh patch        # or minor, major, or an exact 2.1.0 / 2.1.0-beta.1
scripts/create-release.sh -n minor     # dry run: check everything, tag nothing
```

It refuses unless master is clean and matches `origin/master`, the version is
newer than the latest tag, and `npm run check` passes. Then it asks, tags the
commit (`v1.2.0`, annotated) and pushes the tag. CI builds, self-tests and
publishes the installers as that tag's GitHub release; a tag with a prerelease
part becomes a prerelease. `-y` skips the question.

### Checking the installed CLI

```bash
node skills/canvas/scripts/check-version.mjs [--json]
```

This prints the installed `edutools` version, the checkout's version and the
latest release. It warns if the installed build doesn't match the checkout, if
it's older than the latest release, if the checkout is behind `origin`, or if the
checkout has uncommitted or unpushed changes. It exits 1 when it warns. The Claude
skill runs it at the start of a session and reports what it finds.

### References

- Canvas Live API: https://boisestatecanvas.instructure.com/doc/api/live
