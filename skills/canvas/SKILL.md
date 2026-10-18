---
name: canvas
description: Work with Canvas LMS through the `edutools` CLI - list courses, students, assignments, modules and submissions; snapshot a whole course to disk; publish a course repository of markdown into Canvas, verify or audit what landed, and see which side (the repo or Canvas) changed since the last push; preview the module outline and due dates; create, update, delete, publish and unpublish pages, assignments, discussions, quizzes and modules; and grade submissions with written feedback. Use whenever the request touches Canvas, an LMS course, course design or course content, a backup or snapshot of a course, a gradebook, a course page or module, an assignment or quiz, student submissions, grading, or leaving feedback on student work.
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

## What this skill does

This skill is a guide to `edutools`, and nothing more. It holds no Canvas API
knowledge of its own: every action below is an `edutools` command, and when a
task cannot be expressed with one, the fix is a new command in edutools (see Changing edutools
itself below), not a workaround here.

It covers five jobs, each with its own section:

1. **Reading a course**: courses, students, assignments, modules, groups,
   submissions, and whole-course snapshots and exports. Reads are always safe.
2. **Publishing a course repository**: a directory of markdown plus a
   `canvas.toml` that `push` turns into Canvas pages, assignments, discussions,
   quizzes, rubrics and modules. `verify` proves what landed, `audit` finds what
   Canvas holds that the repo did not put there, and `status` says which side
   changed since the last push, so edits made in the Canvas UI are not lost.
3. **Changing one object** that no repo manages: `create`, `update`, `delete`,
   `publish`, `unpublish`.
4. **Grading**: reading submissions and discussion posts, writing scores and
   feedback, fixing feedback already sent, and rubrics for one assignment.
5. **Changing edutools itself**, when none of the above fits.

How a session goes: check the edutools version and the credentials once (next
section), read with `--json` whenever a value matters, and treat every write as
landing on a live course with real students. The rules after that are what keep
those writes safe.

## Before anything else

First, once per conversation, check which edutools you are driving. The script
sits in this skill's directory (normally `~/.claude/skills/canvas`, a symlink into
the edutools checkout):

```bash
node ~/.claude/skills/canvas/scripts/check-version.mjs
```

It prints the installed version, the version of the checkout it came from, and
the latest release, then a `warning:` line for each thing that is off. It exits 0
when there is nothing to warn about and 1 when there is; `--json` gives the same
as one object with a `warnings` array. **Tell the user the edutools version you
are using, and pass on every warning in your own words**, with the fix it names:

- **The installed build does not match the checkout**, or **it is older than the
  latest release**, or **the checkout is behind origin**: the CLI may be missing
  fixes. Suggest `git pull && npm run install:cli` in the checkout.
- **Uncommitted files or unpushed commits in the checkout**: the CLI may be
  running local changes nobody else has. Say so; it is the user's call whether to
  go on.
- **edutools is not on PATH**: nothing else in this file works until it is
  installed (`npm ci && npm run install:cli` in the checkout).

A warning is information, not a stop: carry on with the task unless edutools is
missing or the user says to fix things first. Never run `git pull`, commit, push
or rebuild on your own to clear a warning.

Then confirm the credentials and the course:

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
   `[[module]]` the repo marks `publish = true` (see Module tables in
   `references/repositories.md`): the
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
8. **Check `status` before pushing a course repository.** A push overwrites any
   Canvas edit to an object it writes. If `status` reports `canvas`, `conflict`
   or `unknown`, show the user what changed in Canvas and settle each one before
   pushing (see Two-way sync:
   `status` in `references/repositories.md`).

## Where the rest is

Each job has its own file under `references/` next to this one. Read the one for
the job before running its commands; the details and the gotchas are there.

| Job | Read |
| --- | --- |
| Reading a course, snapshots (`pull`), quiz and question bank exports | `references/reading.md` |
| `create`, `update`, `delete`, `publish`, `unpublish` on one object, assignment groups | `references/objects.md` |
| Course repositories: `push`, module tables, `verify`, `audit`, `status` | `references/repositories.md` |
| Grading, feedback, discussions, rubrics, quiz questions | `references/grading.md` |

## Changing edutools itself

`edutools` is the user's own project, at `~/repos/edutools`, a TypeScript npm
workspace. If a Canvas task genuinely cannot be expressed with the commands this skill covers,
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

This skill lives in that repo too, at `skills/canvas/` (SKILL.md and `references/`);
`~/.claude/skills/canvas` is a symlink to it. A change to a command's name, flags, or
`--json` output updates the file that documents it in the same commit.
