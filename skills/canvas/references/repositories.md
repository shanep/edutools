# Course repositories

Part of the canvas skill. Read SKILL.md first: its setup and rules apply here.

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
edutools status <repo> --course <id>               # did anything change in Canvas since the last push?
edutools diff <repo> --course <id> --path <file>   # what changed, line by line (- repo, + Canvas)
edutools push <repo> --course <id> --dry-run       # render everything, write nothing
edutools push <repo> --course <id>                 # write it, unpublished, verify, record the baseline
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
| `--dry-run` | Renders everything and writes nothing. Run it first. Needs no token, except with `--clean`. It reads nothing from Canvas, so its "would update" means the manifest records the object; the real push still skips one that is published. |
| `--path <file or glob>` | Push one correction, not the whole course. Repeatable. Skips the module rebuild. |
| `--module <title or glob>` | Rebuild only the `[[module]]` tables whose title matches, ignoring case. Repeatable. Every other module is left alone, so a published module can take `--update-published` without the rest being rebuilt. |
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
  that exist), a `[layout] files` entry naming one file the repo does not have
  (often a large file kept out of git that this clone is missing), a file that
  fails to render, a Canvas error on one object. Read the list and report it;
  do not retry blindly.
- **A `## Rubric` table is kept in step, not recreated.** The push reads the
  rubric already attached to the assignment: unchanged criteria are skipped,
  changed ones are rewritten in that same rubric, and one is created only when
  there is none. (Before this, every push created a fresh rubric and attached it,
  replacing the one the assignment had been graded with.)
- **A module is rebuilt from `canvas.toml`**: every item is removed and re-added
  from the table's `page`, `items`, and `canvas` lists. Something added to a
  repo-managed module by hand in Canvas disappears on the next push unless it is
  named under `canvas`. `audit` reports exactly those items.
- **Module order follows `canvas.toml`, among the repo's own modules only.**
  Modules the repo does not declare (a shell's "Course Links") and published
  modules the push skips stay where they are; every other repo module is placed
  right after the one before it in `canvas.toml`.
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
  `--only`, `--path` or `--module`. Never use it mid-term.
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
    { url = "https://example.edu/slides", title = "Slides" },   # an external link, new tab
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
- **Files are matched by content before they are uploaded.** A repo file whose
  exact bytes are already in the course (a shell's icon set, under any name or
  folder) is recorded against that copy rather than uploaded again. The copy the
  manifest already records is kept while it matches, so switching an
  already-pushed course over to the shell's copies means deleting the pushed
  duplicates first (rule 4). `audit` reports them `stale` until the next push,
  which adopts the shell's files and relinks every page it rewrites. A published
  page is only rewritten with `--update-published` (rule 5), so it points at a
  deleted file until then.

### `verify` and `audit`

Both require `--course <id>`.

- `verify <repo> --course <id>` reads every object the repo pushed back from
  Canvas and compares it with what the repo says it should be. It catches the
  sanitizer stripping HTML, partial quiz writes, files stuck pending, and someone
  editing in the Canvas UI: a body, points, a due, unlock or lock date (compared
  to the minute), or a module's items and their order. `push` runs it
  automatically. It exits 1 when anything failed. With `--json` it prints
  `{"checked", "drafts", "failures": [{"key", "check", "detail"}], "overrides": [{"key", "detail"}]}`,
  where `key` is the repo path (`[[module]] <name>` for a module), `drafts` the
  paths skipped because they are now drafts, and `overrides` the assignments with
  per-student or per-section dates.
- **An override is not drift.** Verify compares an assignment's own dates and
  lists its overrides (extensions) as notes. Leave them alone; a push never
  touches them. The one override it fails is one that now ends before the class
  does, which means the repo moved the class's date past someone's extension:
  tell the user so they can extend it again in Canvas.
- **A date or module failure on published content is real drift**, usually an
  edit made in the Canvas UI. Ask the user which side is right: bring the change
  into the repo, or push the repo's version with `--update-published` (rule 5).
- `audit <repo> --course <id> --json` answers the other direction: objects in
  Canvas the repo did not create (`untracked`, normal for a hand-built exam),
  modules `canvas.toml` declares that do not exist yet (`pending`), and manifest
  entries pointing at objects Canvas no longer has (`stale`). Only `stale` exits
  non-zero, because the course no longer matches the repo. A stale object whose
  repo file still exists is recreated by the next push; if the deletion was
  deliberate, the repo file goes (or becomes a draft) and so does its manifest
  entry. Ask the user which it was rather than guessing.

### Two-way sync: `status`

The repo is the source for a course, but Canvas gets edited too: a typo fixed in
the Canvas editor during class, a due date moved for a snow day, a rubric row
reworded in SpeedGrader. `verify` sees that the two sides differ but not which
one moved. `status` answers that, so a change made in Canvas can come back into
the repo instead of being overwritten by the next push.

```bash
edutools status <repo> --course <id>               # what changed, and on which side
edutools status <repo> --course <id> --json        # the same, to parse
edutools status <repo> --course <id> --path <file> # some repo files only; repeatable, glob ok
edutools status <repo> --course <id> --adopt       # record a baseline (see below); writes the manifest only
```

`--course <id>` is required.

**How it works.** Every push, after writing, reads each object back and records a
baseline in `.canvas/manifest-<id>.json`: under the entry's `synced` key (and
under `modules` for a `[[module]]`), a fingerprint of each part of the object,
taken from the repo as rendered and from what Canvas stored. The parts are
`body`, `settings` (title, points and the three dates), `rubric`, `questions`
(a repo quiz) and `items` (a module). Only the parts a push actually wrote are
recorded: a full push does not attach rubrics, so it leaves the rubric's
baseline as it was, and a published object the push skipped keeps its old
baseline. `status` fingerprints both sides again and compares each one with its
own baseline. The two sides are never compared with each other through a
fingerprint, so Canvas rewriting markup on save is not a change. A part is only
looked at when the repo manages it: a rubric attached by hand to an assignment
with no `## Rubric` table belongs to Canvas.

**The states, and what to do about each:**

| State | Means | What to do |
| --- | --- | --- |
| `in-sync` | Neither side moved, or both made the same change. | Nothing. |
| `repo` | The repo changed. | Push it. Published content needs `--update-published` (rule 5). |
| `canvas` | Canvas changed. | Show the user. Copy the change into the markdown, then `status --adopt`. Or, if the user says the repo wins, push. |
| `conflict` | Both changed, differently. | Show the user both versions and let them decide. Never push over it unasked. |
| `unknown` | No baseline, and the sides differ. | Cannot tell who changed. Ask, or run `--adopt` once the user agrees Canvas holds nothing to keep. |
| `new` | In the repo, never pushed. | The next push creates it. |
| `canvas-deleted` | The manifest tracks it; Canvas does not have it. | Same as a `stale` audit entry: ask whether the deletion was deliberate. |
| `repo-deleted` | The manifest tracks it; the repo file is gone. | Its Canvas object is left alone; ask before deleting it. |

Each row also names the parts that moved (`repo: body, settings`), which says
where to look. To see what Canvas holds now, read the object (`assignments`,
`modules`, `discussion` with `--json`) or `pull` the course, and compare it
with the markdown.

**`--adopt`** writes the manifest and never Canvas. It does two things:

- **A course pushed before baselines existed** has none, so every difference is
  `unknown`. `--adopt` records Canvas as it is now as the baseline: where the
  repo matches Canvas, both sides are recorded; where it differs, only Canvas
  is, so from then on the difference reads as a repo change. Run it only after
  the user has looked at the differences and agreed that nothing in Canvas has
  to come back first, because it turns every difference into "the repo is
  right".
- **A Canvas change copied into the repo by hand.** Once the markdown matches
  what Canvas holds, `--adopt` records both sides again, and the object is in
  sync without pushing it back to a class that is reading it.

It never absorbs a change the repo made alone, even one that looks the same in
Canvas (a changed link target is invisible to the comparison), so that stays a
push to make.

**Bringing a Canvas change into the repo**, the whole loop:

```bash
edutools status <repo> --course <id>                           # 1. find it: state canvas, parts body
edutools diff <repo> --course <id> --path <file>               # 2. see the edit: - repo, + Canvas
#                                                                 3. edit the markdown to match
edutools status <repo> --course <id> --path <file> --adopt     # 4. both sides agree: in-sync
```

`diff` writes each body as readable lines (a paragraph, heading, list item or
table row each, links and images the markdown way) and drops what Canvas adds on
its own, so the `+` lines read as the markdown to write. `--markup` diffs the
HTML a tag per line, for a change the text cannot show, like a style. It compares
titles and bodies only, reads Canvas, never writes it, and exits 1 when anything
differs. `--json` prints
`{"items": [{"key", "kind", "title", "canvasTitle", "hunks": [{"repoStart", "repoCount", "canvasStart", "canvasCount", "lines": [{"op", "text"}]}]}], "compared", "missing"}`.

Nothing converts Canvas HTML back to markdown yet, so step 3 is an edit by hand.
A date moved in Canvas cannot go back into a `Week N` meta line; it becomes an
`[override."<path>"]` in `canvas.toml`, and that is the user's call. A module
changed in Canvas comes back as edits to its `[[module]]` table.

**Exit codes and JSON.** `status` exits 1 for `canvas`, `conflict`, `unknown` and
`canvas-deleted`, the states that need a decision before the next push, and 0
when the repo is only ahead. With `--json` it prints
`{"items": [{"key", "kind", "title", "state", "repo", "canvas", "unknown", "published", "detail"}], "drafts", "adopted", "upgraded"}`
for every object, in sync or not; `repo`, `canvas` and `unknown` list the parts,
`published` is null for the syllabus and files (for a module it is the module's
own flag), and `detail` says why an object could not be compared. `--path` leaves
modules out. Without `--json` it lists only what is not in sync (`--all` lists
everything). `upgraded` counts baselines rewritten because edutools now reads
Canvas a little differently; that is not a Canvas edit, and the manifest
changes it makes are worth committing.

**What it does not cover:** assignment group weights, a module's published
state, and whether an object is published at all, since publishing is a decision
made apart from content. Classic quiz questions are compared by fingerprint, but
a quiz built by hand in Canvas has no repo file and no baseline.
