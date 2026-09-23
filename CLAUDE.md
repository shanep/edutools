# edutools

A Canvas LMS command line tool and desktop app. `edutools` reads course data,
snapshots a course to disk, publishes a course repository of markdown into Canvas,
edits individual Canvas objects, and grades submissions with feedback. The desktop
app puts the same core behind a window.

TypeScript on Node (22.14 or newer), as an npm workspace. It runs on macOS, Windows
and Linux, and CI checks all three.

## Layout

```
packages/core/src/   the library; every other package is built on it
  canvas.ts          CanvasLMS: the only module that talks HTTP to Canvas
  course.ts          whole-course orchestration: push, verify, audit, clean, outline, dates
  publisher.ts       the two-pass course-repo publisher (create objects, rewrite links)
  pull.ts            the course snapshot
  publish.ts         pure: markdown -> Canvas HTML, sanitizer allowlist, manifest
  verify.ts          pure: reads content back and compares it semantically
  audit.ts           pure: the manifest against the live course, both ways
  outline.ts         pure: the module outline a push builds
  dates.ts           pure: due-date computation from a canvas.toml term skeleton
  objects.ts         pure: per-kind Canvas field names, grade-file parsing
  credentials.ts     Canvas sites, and their tokens in the OS keychain
  paths.ts           POSIX repo keys, globbing, fnmatch
  types.ts           Payload, RequestData, RequestParams
packages/cli/src/    the edutools command (commander)
  main.ts            COMMANDS, the ordered list of every command; run()
  cli.ts             Cli: stdout, stderr, stdin, credentials, the Canvas client
  commands/<name>.ts one file per command, exporting register
packages/app/        the Electron desktop app (electron-vite, React)
packages/*/test/     vitest tests, one <module>.test.ts per module
```

The split is the point, and it has three layers:

- **`canvas.ts` owns HTTP.** Nothing else calls `fetch`.
- **`course.ts`, `publisher.ts` and `pull.ts` orchestrate** with an injected client
  (a narrow client type such as `CourseCanvas` or `PullCanvas`, not `CanvasLMS`), and
  never print or prompt. Progress goes to a callback, results come back typed, and a
  step that needs a human's yes is split in two (`planClean`, then `executeClean` or
  a `push` handed that plan) so the caller does the asking.
- **The rest of core is pure**, testable without a token or a network.
- **`cli` and `app` are presentation only**: arguments, prompts, tables, windows.
  Anything both of them need belongs in core, so the CLI and the app always run the
  same sequence.

Where things go:

- **New Canvas endpoint** -> a method on `CanvasLMS` in `canvas.ts`, added to the
  client type its caller takes. Never a `fetch` elsewhere.
- **New rule about what to send** -> a pure function in `objects.ts`, `publish.ts`,
  or `dates.ts`, tested directly.
- **New whole-course operation** -> `course.ts`, so the app can use it too.
- **New command** -> a new file in `packages/cli/src/commands/` exporting
  `register`, plus one line in `COMMANDS` in `main.ts`. No other command changes.
  Commands go through `Cli` (`cli.print`, `cli.note`, `cli.json`, `cli.canvas()`,
  `cli.confirm`), never `process.stdout`, `process.env` or `new CanvasLMS`.
- **Import core by subpath**: `@edutools/core/publish` from another package,
  `./publish` inside core. There is no barrel index.

## Checks

From the repository root. All three must pass before anything is committed:

```bash
npm run lint        # biome
npm run typecheck   # tsc, strict, currently zero errors; keep it there
npm run test        # vitest
```

`npm run check` runs all three. Install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`
unless you are running the app. Run the CLI from source with
`npm run edutools -- <command> ...` (from the repo root, so relative paths resolve
from there), or build the bundle with `npm run build --workspace @edutools/cli`.

Tests never hit the network. Pass a fake `fetch` to `new CanvasLMS({ fetch })` and
assert on the URL and the form body it received, which is where the bugs actually
are; hand the orchestrators a fake client object. CLI tests drive the real
commander program through `packages/cli/test/harness.ts`, with buffers for the
streams, `memoryStore()` for the keychain and a fake client, so they never read or
write a developer's real keychain. Temporary directories come from
`fs.mkdtempSync(path.join(os.tmpdir(), "edutools-"))`.

## The skill moves with the CLI

`skills/canvas/SKILL.md` is how an agent learns to drive this tool
(`~/.claude/skills/canvas` is a symlink to it). Any change to a command's name, its
flags, its behaviour, or its `--json` output updates that file in the same commit.
The README's command reference is its raw material, so keep that exact too.

## Canvas API conventions

These are Canvas's rules, not choices, and getting them wrong fails silently:

- **Every kind names its fields differently.** An assignment has `assignment[name]`,
  a page `wiki_page[title]`, a quiz `quiz[title]`, a module `module[name]`, and a
  discussion takes bare parameters with no prefix at all. A graded discussion hangs
  its points and dates off `assignment[...]` rather than the topic. `objects.ts`
  holds this table; add to it rather than special-casing at a call site.
- **A page is addressed by its url slug**, everything else by numeric id.
- **Repeated bracket keys are lists.** `assignment[submission_types][]` and quiz
  answers must be sent as a list of `[key, value]` pairs, not a record, which is why
  `RequestData` allows both.
- **The sanitizer strips silently.** Canvas drops `<style>`, `<link>`, `<script>`,
  and any CSS property outside its allowlist, and answers 200 either way. That is
  what `publish.ts`'s allowlist and the `verify` command exist for: never trust a
  200 to mean the content arrived.
- **Writes are sequential on purpose.** Canvas throttles with 429 and charges a
  pre-flight penalty for parallel requests. Every Canvas call is awaited one at a
  time; no `Promise.all` over Canvas writes. `CanvasLMS` retries with backoff; do
  not add concurrency to work around slowness.
- **File upload is three steps.** Announce, POST the bytes with `file` last, then
  follow the redirect to confirm. Skipping the third step leaves the file pending.
- **Posting policy is GraphQL-only.** A grade written to an assignment with a manual
  posting policy lands but stays hidden. There is no REST endpoint for posting it;
  say so rather than inventing one.

## Working on a live course

Canvas writes are real and immediate, against courses with real students in them.

- Default to unpublished. `push` and `create` both leave objects invisible to
  students unless `--publish` is passed. Preserve that default in anything new,
  in the app as well as the CLI.
- **Never rewrite published content.** `push` skips any object Canvas reports as
  published, and lists what it skipped; `--update-published` is the opt-in. The
  same guard covers modules and rubrics. Changing a page mid-semester under a
  class that is reading it is worse than leaving it stale, so anything new that
  writes to Canvas has to respect `Publisher.protected` too.
- Prefer `--dry-run` first (`push`, `grade`) and check the output before writing.
- Deletes cascade: removing an assignment or graded discussion takes its
  submissions and grades with it. `delete` confirms before acting, and `push
  --clean` refuses when anything it would delete holds student work and checks
  again right before deleting; keep both that way.
- Do not run `push`, `grade`, or `delete` against a course id you were not given.

## Credentials

Sites (a name and an endpoint) live in `sites.json` in the platform config
directory; tokens live in the OS keychain under the service `edutools`, keyed by
endpoint, through `@napi-rs/keyring`. `CANVAS_TOKEN` and `CANVAS_ENDPOINT` override
both. A token is never a command line flag: `site add` and `site token` read it
from a hidden prompt or from stdin. Never print a token; `maskToken` is all anything shows.

## Portability

- **Repo keys are POSIX.** Anything written to the manifest, read from
  `canvas.toml`, or matched by `--path` uses forward slashes on every platform
  (`toPosix`, `repoKey` in `paths.ts`). Filesystem paths are strings built with
  `node:path`.
- **Names written to disk must be legal on Windows**: none of `: * ? " < > |` or
  control characters, no trailing dots or spaces, and none of
  `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`, with or without an extension. `pull`
  already sanitises its names; do the same for anything new.
- **No shell-outs.** Everything runs in process on every platform; markdown is
  rendered with markdown-it, not a separate tool. A new dependency on an external program
  is a regression.
- **Canvas I/O is async**, and anything that calls it is too. Pure modules stay
  synchronous.

## Style

- Comments explain *why*, especially where the code is shaped by something Canvas
  does. Do not narrate what the next line does.
- Names: `camelCase` for functions and variables, `PascalCase` for classes, types
  and errors (subclass `Error` and set `name`), `SCREAMING_CASE` for module
  constants. Unexported helpers stay unexported.
- Strict types, never `any`: use `unknown` and narrow. An `as` cast needs a comment
  saying why it is safe, and so does a `biome-ignore`.
- Output discipline: stdout carries the result and nothing else; prompts, spinners,
  warnings and errors go to stderr, so `edutools courses --json | jq` always works.
- Read commands take `--json` and emit the raw payload, so output can be parsed
  rather than scraped. Every new read command should too.
- There is no formatter pass (biome's formatter is off); match the surrounding code.
- No em-dashes or en-dashes in code, comments, docs, or commit messages.

## Releases

There is one version, and it comes from git: `scripts/version.cjs` turns `git
describe` into semver at build time, and the CLI bundle, the app and its installers
all stamp it in as `VERSION` from `@edutools/core/version`. Never set a version in a
`package.json`; they stay `0.0.0`. A release is a `v*` tag.

The CI workflow builds the app installers on `workflow_dispatch` or a `v*` tag and
uploads them as artifacts. A pushed `v*` tag also publishes them as a GitHub release
once every check passes, so pushing a tag is releasing: it always needs the owner's
explicit go-ahead.

## References

- Canvas Live API: https://boisestatecanvas.instructure.com/doc/api/live
