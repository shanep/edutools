# Grading with feedback

Part of the canvas skill. Read SKILL.md first: its setup and rules apply here.

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
size. A file uploaded through the text editor is only a link in the text, never an
attachment; `download` follows those Canvas file links and saves each file beside
`submission.txt` under its link text (links to other hosts are never followed).
Files a student attached to their own comments, often work sent after the
assignment closed, land in `<out>/<user_id>/comments/`.
**Read the actual work before grading it.** Do not assign a score from a
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

### Correcting feedback already sent

`grade` only ever adds a comment. To change one, rewrite it in place with
`edit-comment`: the student then sees the corrected text, not the old comment
with a second one under it.

```bash
edutools edit-comment -c 12345 -a 67890 -s 555 --comment "Clearer wording."
edutools edit-comment -c 12345 -a 67890 -s 555 --comment-id 4321 --comment-file fix.md
edutools edit-comment -c 12345 -a 67890 --from-file grades.json --dry-run
edutools edit-comment -c 12345 -a 67890 --from-file grades.json
```

- **Without `--comment-id` it edits the most recent comment the token's user
  wrote** on that submission, never a student's reply. A submission with no such
  comment fails that row and the command exits 1.
- **The batch file is a grades file.** Only the student and comment are read,
  plus an optional `comment_id`; a score in it is ignored, so edit the comments in
  the file that did the grading and send it again. Scores change only through
  `grade`.
- **Its `--dry-run` needs the token**: it reads each submission and prints the old
  text beside the new. Show that before writing, as with any bulk change.
- `submission --json` lists a submission's comments with their `id`s when a
  specific older comment is the one to change.

### Grading a discussion

Discussion posts are not in `submission --json`. Read them with
`discussion <topic_id> --json`: `participants` maps user ids to names, and `view`
holds the top-level posts with their `replies` nested, each with `user_id`,
`parent_id`, `created_at` and the HTML `message`. Canvas builds that view in the
background, so a reply posted seconds ago can be missing from it.

A graded discussion's peer reviews are listed by its **assignment id** (the
topic's `assignment_id`), not the topic id. In `peer-reviews --json`, only
comments whose `author_id` is the `assessor_id` are the review; the reviewee may
have replied underneath.

### A rubric on an assignment no repo manages

```bash
edutools rubric -c 12345 -a 67890 --from-file rubric.json --dry-run
edutools rubric -c 12345 -a 67890 --from-file rubric.json
```

The file is `{"title", "criteria": [{"description", "points", "long_description"?,
"ratings"?: [{"description", "points"}]}]}`. Use it for partial credit, which a
repo's `## Rubric` table cannot express (every table row is full or no marks).
For a repo-backed course, edit the table and push instead; `rubric` on an
assignment `push` manages is overwritten by the next push.

- **An existing rubric is rewritten in place**, never replaced, so grades already
  given with it stay attached.
- **The highest rating must equal the criterion's points**, and the dry run warns
  when the total differs from the assignment's points. Read that warning out.
- To grade with it, read the criterion ids from `submission --json` or the
  assignment's `rubric` field and pass them in each row's `rubric` object.

### Replacing a hand built quiz's questions

```bash
edutools quiz-questions <quiz_id> -c <course_id> --from-file questions.json \
    [--remove-group <id>]... [--update-published] --dry-run
```

For a quiz no repo manages (an exam behind LockDown Browser). The file is a list
of questions in the quiz questions API's shape, the same as `pull`'s
`.questions.json`: `question_name`, `question_type` (any type, matching and short
answer included), `points_possible`, `question_text` (HTML), the `*_comments`
fields, `matching_answer_incorrect_matches`, and `answers` with `answer_weight`
(100 or 0), `answer_text` or `answer_html`, `answer_match_left` and
`answer_match_right`. Every existing question is deleted first.

- **Relative image paths are uploaded and relinked**, into a hidden course folder
  (`quiz images/<quiz_id>`), so students cannot browse an exam's figures. Remote
  image urls are left alone and warned about; download them first if the quiz
  should not depend on another server.
- **`--remove-group` deletes a question group**, such as a draw from a bank.
  Canvas cannot list a quiz's groups. Their ids come from a whole-course
  `export --type common_cartridge`: each group is a `<section ident="g...">` in
  the quiz's file in `non_cc_assessments/`, where the hex after the `g` is the
  MD5 of `quizzes/quiz_group_<global id>`, and a global id is
  `shard * 10**13 + id`. Recover the shard the same way from the quiz's own
  ident, the MD5 of `quizzes:quiz_<global id>`, then try local group ids from 0
  up (a few million take seconds). The dry run reads each group back and refuses one from another quiz,
  which proves the ids before anything is deleted.
- **A published quiz needs `--update-published`** (rule 5), and is unpublished,
  rebuilt and published again, because Canvas freezes a published quiz's question
  set. Canvas refuses the unpublish once a student has taken the quiz. Check
  `submissions` first.
- **It reads the quiz back** and exits 1 when Canvas reports a different question
  count or point total than the file. Report that rather than retrying.

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
