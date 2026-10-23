# Google Drive copies

Part of the canvas skill. Read SKILL.md first: its setup and rules apply here.

`edutools drive` copies a course repository to Google Drive as Google Docs, so
colleagues and eCampus can read, comment on and copy the course without a Canvas
seat. It reads the same `canvas.toml` and markdown that `push` sends to Canvas,
and it never touches Canvas.

```bash
edutools drive login --client ~/Downloads/client_secret_....json   # once per machine
edutools drive push <repo> --dry-run --preview /tmp/drive          # render everything, write nothing
edutools drive push <repo>                                         # create or update the Drive folder
edutools drive status <repo>                                       # which side changed since the last push
edutools drive folder <repo>                                       # pick the folder the course folder goes in
```

## What the copy holds

- A course folder named after the repo directory in capitals (`docs/cs331` becomes
  `CS331`; `--name` overrides it on the first push). It goes in the folder picked
  with `drive folder`, or at the top of My Drive when none was picked. Without a
  picked folder the user can move it anywhere, and later pushes still find it by id.
- `00 Syllabus` at the top, then one folder per `[[module]]` in order
  (`01 Course Resources`, `02 ...`), each holding its items in module order with a
  number prefix. An item two modules list goes in the first.
- Every page, assignment, discussion and quiz is a Google Doc with its title, the
  computed due date for gradable items, and the page body. Course files (PDFs, data,
  images) are stored as they are. Files no module lists go in `Files`, other items
  in `Other`.
- **Instructor content is kept**, unlike Canvas: `## Instructor Notes` sections stay
  in, and `never_publish` modules are folders like any other. The copy is for
  instructors. Do not share the folder with students.
- An **Objective Alignment Sheet** (a Google Sheet, at the top of the course
  folder) when `objectives.md` at the repo root has `## TLO n: ...` sections, each
  with a `> **The student will be able to** ...` quote, a facets line
  (`*Introduced in this course · Required · Bloom: Apply · Knowledge type: Process*`),
  a table of supporting objectives matched by header (`#`, `The student will be
  able to…`, `Bloom`, `Knowledge type`, `How it will be assessed`, `Location in
  course`) and an optional `**Notes.**` paragraph. Its columns follow the eCampus
  alignment template; a location cell with one link to a course item links to its
  Doc. The rest of the page is left out. It is regenerated like any Doc, so edit
  `objectives.md`, not the Sheet. When the repo has
  `objective-alignment-template.xlsx` (eCampus's template downloaded as Excel), the
  Sheet is that workbook with the rows written into its Objectives tab, in its
  styling and dropdowns, and without its letter to the instructor in J1. Facets are
  matched to the dropdown choices ignoring case. The template needs the Sheets API
  (setup step 2).
- Links between course items point at the Drive copies. Raster images are embedded.
  Docs cannot show SVG, so an SVG image becomes a link to its file, or is dropped
  when its alt text is empty. The `[icons]` images only decorate Canvas headings and
  are left out.

Sharing is the user's job, in Drive. The command never changes permissions.

## Push

The first push creates everything. Each later push updates the same Docs in place,
at the same URLs, and sends only what changed. `<repo>/.drive/manifest.json` records
every Drive id and what was sent: **commit it**, or a push from another machine
builds a second copy.

- **A Doc edited in Drive is not overwritten.** The push compares Drive's
  `modifiedTime` with the one it recorded, reports a `conflict`, leaves the Doc
  alone and exits 1. Copy the edit into the repo, or rerun with `--force` to
  overwrite it. Do not pass `--force` unless the user has seen what changed in Drive.
  A change within 30 seconds of the push is Docs finishing its own import of the
  page and does not count.
- Replacing a Doc's text can detach comments anchored to text that changed. Say so
  before pushing over a Doc colleagues have commented on.
- An item or folder the repo no longer has is listed as an `orphan`. `--prune`
  moves it to the Drive trash, where it stays restorable for 30 days.
- An item deleted or trashed in Drive is recreated, with a new id and URL.
- `--dry-run` needs no sign-in, and `--preview <dir>` writes each Doc's HTML there
  for a look before the real push. Unresolved links are listed as warnings.

`--json` prints `{"root", "dryRun", "changes", "unresolved"}`. `root` is
`{"id", "url"}` (null on a dry run before the first push). Each change has `key`,
`kind` (`doc`, `file`, `sheet` or `folder`), `name`, `action` (`create`, `recreate`,
`update`, `move`, `unchanged`, `conflict`, `trash`, `orphan`) and `detail`.

## Folder

`drive folder <repo>` opens Google's folder picker in the browser (and prints its
127.0.0.1 URL), the user picks a folder, and edutools saves it as `parent` in the
manifest. If the course folder exists it moves there at once, and every Doc keeps
its id and URL. Each later push moves the course folder back if someone moved it
out. Commit the manifest afterwards.

The picker is the only way to point edutools at a folder it did not make, such as
one eCampus shared: the `drive.file` scope hides everything else, so a folder id
or URL alone is not enough. Picking a folder grants edutools access to it, so pick
only a folder the user named in the conversation, and otherwise let them choose.
Cancelling changes nothing and exits 1.

`--json` prints `{"parent": {"id", "name", "url"}, "root", "moved"}`. `root` is
null before the first push.

## Status

`drive status` reads Drive and never writes it. Each item is `in-sync`, `repo` (the
next push sends a change), `drive` (edited in Drive), `conflict` (both), `new`
(never pushed), `missing` (deleted or trashed in Drive) or `orphan`. It exits 1 on
`drive`, `conflict` or `missing`. `--json` prints `{"root", "items"}`, and each item
has `key`, `kind`, `name`, `state` and `url`.

## Signing in

edutools signs in with the `drive.file` scope, which reaches only the files and
folders edutools created, plus a folder picked with `drive folder`, and nothing
else in the account. The client and the
refresh token live in the OS keychain beside the Canvas tokens.
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` override them.

The OAuth client is a one-time manual step, because Google has no API for creating
one. The user does it in Google Cloud Console (offer to drive it with Claude in
Chrome while they watch):

1. Create a project, or pick one.
2. Enable the **Google Drive API** (APIs & Services, Library), and the **Google
   Sheets API** if a course uses the alignment template.
3. Set up the OAuth consent screen. Pick **Internal** on a university Workspace
   account, so the sign-in does not expire after 7 days.
4. Create an OAuth client ID of type **Desktop app** and download its JSON.
5. Run `edutools drive login --client <the JSON>`. It opens the consent page in the
   browser and prints the URL too. After that, `edutools drive login` alone signs in
   again.

`drive login` is the user's to run, like `site add`: it opens their browser on their
account. Never ask for the client secret or a token in the conversation.
`drive logout` forgets the sign-in, and `drive logout --client` forgets the client too.

If the sign-in fails with "access blocked" or "app not approved", the Workspace
admins block unapproved apps. That needs the admins, not a code change.
