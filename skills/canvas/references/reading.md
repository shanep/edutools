# Reading a course

Part of the canvas skill. Read SKILL.md first: its setup and rules apply here.

## Reading

```bash
edutools courses [--all] --json               # --all includes concluded courses
edutools assignments <course_id> --json
edutools students <course_id> --json
edutools submissions <course_id> <assignment_id> --json
edutools ungraded <course_id> --json          # everything still needing a grade
edutools groups <course_id> --json            # assignment groups and their weights
edutools modules <course_id> --json           # modules, each with its items under "items"
edutools discussion <topic_id> -c <course_id> --json   # a discussion's full thread
edutools peer-reviews -c <course_id> -a <assignment_id> --json   # who reviews whom, and the reviews
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

## Exporting quizzes and question banks

A quiz that draws from a linked question bank comes back from `pull` with an
empty `.questions.json`: the quiz questions API cannot see bank questions, and
banks have no REST endpoint. `export` downloads the package Settings -> Export
Course Content builds. It only reads course content, so it is safe on any course
the user names; it does show up in the course's export history.

```bash
edutools export <course_id> --type common_cartridge  # whole course with every bank, .imscc
edutools export <course_id>                          # every quiz, ./canvas-<id>-qti.zip
edutools export <course_id> --quiz <id> --quiz <id> -o exam.zip
edutools export <course_id> --json                   # {"path", "bytes", "export"}
```

- **Only a whole-course `common_cartridge` export has the banks.** A `qti`
  export, or any export narrowed with `--quiz`, names each bank in
  `<sourcebank_ref>` and leaves its questions out. To read bank questions, export
  the whole course and look in `non_cc_assessments/`: each bank is an
  `<objectbank>` file (QTI 1.2) whose `bank_title` metadata names it, and each
  quiz there lists its question groups with the bank ident, how many to pick,
  and the points each.

- **It waits.** Canvas builds the package in the background; the command polls
  every few seconds and gives up after 30 minutes. A whole course with its files
  takes a minute or two and can run past 100 MB; a few quizzes take seconds.
- **The package is not unzipped.** Unpack it yourself (`.imscc` is a zip).
  Course files sit under `web_resources/`, referenced from HTML as
  `$IMS-CC-FILEBASE$/...`. A question's image may instead be an absolute url to
  another host, such as a publisher's server, which the package does not copy.
- **`--quiz` takes classic quiz ids** and only works with `qti` and
  `common_cartridge`; with `zip` it is a usage error (exit 2).
- **`export.attachment.url` in the `--json` output carries a verifier** that can
  work without a login. Do not paste it anywhere public.
