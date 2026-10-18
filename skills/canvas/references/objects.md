# Changing one object

Part of the canvas skill. Read SKILL.md first: its setup and rules apply here.

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
- **`delete` also takes `file`** (`edutools delete file <file_id> -c <id>`), and only
  `delete` does. The id comes from `audit` or a `pull`'s `files.json`. A page that
  shows or links to the file breaks until a push relinks it, so rule 4 applies.
- **`delete` also takes `group`** (`edutools delete group <group_id> -c <id>`), an
  assignment group by the id `edutools groups --json` shows. Canvas deletes every
  assignment still in the group with it, so a group that holds any is refused,
  even with `--yes`, unless `--move-to <group_id>` names a group to move them into
  first. Rule 4 applies either way.

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

Three things to know before editing those blocks:

- **Groups are paired up by name.** Changing the name in `canvas.toml` does not
  rename the group in Canvas, it creates a second one beside it. Read the current
  names with `edutools groups` and match them character for character.
- **One file can go into a different group than its kind** with
  `[override."<path>"] group = "<name>"`, for example a take home exam
  alternative that is a `project` by kind but counts in the exam's group. The
  name must match a declared `[[group]]`, or the config fails to load.
- **An omitted `weight` means the weight is managed in Canvas**, not that it is
  zero. The push positions and names the group but never writes a weight, which is
  how an extra credit group that is raised by hand before final grades survives a
  later push.
- **Removing a `[[group]]` block does not delete the group in Canvas.** It stays,
  with its old weight. Once it is empty, delete it with `edutools delete group`;
  a group the repo still declares is recreated by the next push.

### When to use `push` instead

If the course lives in a repository of markdown with a `canvas.toml`, use the
course repository commands in `references/repositories.md`. Use `create`/`update` for one-off objects and
for courses that are not repo-backed. **Do not use `create`/`update` to patch an
object that `push` manages**: the next `push` will overwrite it. Edit the markdown
in the repo and push instead.
