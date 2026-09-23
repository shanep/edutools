# Porting edutools to TypeScript

Temporary: this file exists while the Python in `src/edutools/` is ported to the
TypeScript workspace in `packages/`. It is deleted when the port lands and the
Python is removed. The Python is the specification: behaviour, error messages,
and comments carry over, and every Python test becomes a TypeScript test.

## Layout

```
packages/core/src/   one .ts file per Python module, same name
  types.ts           Payload, RequestData, RequestParams (shared, done)
  paths.ts           toPosix, repoKey, globRepo, isFile, fnmatch (shared, done)
  canvas.ts          canvas.py      the only module that talks HTTP
  publish.ts         publish.py
  publisher.ts       publisher.py
  dates.ts           dates.py
  objects.ts         objects.py
  verify.ts audit.ts outline.ts pull.ts
  credentials.ts     new: Canvas sites and tokens in the OS keychain
packages/core/test/  one <module>.test.ts per Python test file
packages/cli/        the edutools command (cli.py)
packages/app/        the Electron desktop app
```

Import core modules by subpath: `import { isDraft } from "@edutools/core/publish"`
from another package, `"./publish"` inside core. There is no barrel index file,
so two ports never edit the same file.

## Translation rules

- **Names:** `snake_case` becomes `camelCase`; classes and exception names stay
  (`PublishError`, `Manifest`, `CanvasLMS`); module constants stay
  `SCREAMING_CASE`; private `_helpers` become unexported functions.
- **Canvas I/O is async.** Every `CanvasLMS` method returns a Promise, so
  anything that calls one (`Publisher`, `Puller`, audit's live reads) is async too.
  Pure modules stay synchronous.
- **Types:** `dict[str, object]` payloads are `Payload`. Frozen dataclasses become
  `interface`s with `readonly` fields built as object literals; a dataclass with
  methods becomes a `class`. Tuples returned from a function stay as tuples
  (`[title, html]`). Never `any`; use `unknown` and narrow. An `as` cast needs a
  comment saying why, like a Python `cast()`.
- **Paths:** filesystem paths are `string`s built with `node:path`. Repo keys and
  anything written to the manifest or canvas.toml are POSIX (`paths.ts`), on
  Windows too. Use `globRepo` for `sorted(repo.glob(...))` and `fnmatch` for
  `fnmatch.fnmatchcase`.
- **Regexes** port directly. Python `(?P<name>...)` becomes `(?<name>...)`,
  `re.S` the `s` flag, `re.M` the `m` flag, `\A` a leading `^` without `m`.
- **Errors:** subclass `Error` and set `name`. Keep the Python messages.
- **Comments:** carry the Python comments and docstrings over (as `//` or JSDoc).
  They explain why Canvas forces a shape; that knowledge is the point.
- **Windows is a target now.** No shell-outs, no POSIX-only assumptions, and a
  file name written to disk must be legal on Windows (`: * ? " < > |`, trailing
  dots and spaces, and `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` are not).

## Tests

- Port every test case in the matching `tests/test_*.py`, same intent, same
  assertions. Name them in the same plain-sentence style.
- Tests never hit the network. Pass a fake `fetch` to `new CanvasLMS({ fetch })`
  and assert on the URL and the form body it received; hand `Publisher`/`Puller`
  a fake client object.
- Tests that read `~/repos/CS331` use `describe.skipIf(!existsSync(...))`.
- Temporary directories: `fs.mkdtempSync(path.join(os.tmpdir(), "edutools-"))`.

## Checks

From the repo root, all must pass before committing:

```bash
npm run lint        # biome
npm run typecheck   # tsc, strict, zero errors
npm run test        # vitest
```

## Rules carried over from CLAUDE.md

Every Canvas convention in `CLAUDE.md` still holds: per-kind field names,
pages by url slug, repeated bracket keys as pairs, the sanitizer strips silently,
writes are sequential, three-step file upload, posting policy is GraphQL only,
unpublished by default, never rewrite published content. No em dashes or en
dashes anywhere. Never add a `Co-Authored-By` line to a commit.
