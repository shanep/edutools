/**
 * Path rules the Python version got from pathlib and fnmatch.
 *
 * Repo keys are always POSIX (`assignments/p1.md`), on Windows too, because they
 * are written into the manifest and canvas.toml and must mean the same file on
 * every machine.
 */

import { globSync, statSync } from "node:fs";
import path from "node:path";

/** A repo-relative path with forward slashes, whatever the platform. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** The repo key of an absolute or relative path under `repo`. */
export function repoKey(repo: string, file: string): string {
  return toPosix(path.relative(repo, path.resolve(repo, file)));
}

/**
 * Order paths the way Python's sorted() orders Path objects: part by part, so
 * `a/b` comes before `a-b/x` even though "-" sorts before "/" as a character.
 */
export function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/**
 * `sorted(repo.glob(pattern))`: repo keys matching a pathlib-style glob, in
 * Python's order. `*` stays within one directory and `**` crosses them. Unlike
 * pathlib, a dot file is never matched; no course repo layout relies on one.
 */
export function globRepo(repo: string, pattern: string): string[] {
  const found = globSync(pattern, { cwd: repo }).map(toPosix);
  return [...new Set(found)].sort(comparePaths);
}

/** `path.is_file()` for a repo key. */
export function isFile(repo: string, key: string): boolean {
  try {
    return statSync(path.join(repo, key)).isFile();
  } catch {
    return false;
  }
}

/**
 * Python's `fnmatch.fnmatchcase`: `*` matches anything including "/", `?` one
 * character, `[seq]` and `[!seq]` a class. Case sensitive; lower both sides for
 * the case-insensitive `fnmatch`.
 */
export function fnmatch(name: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${re})$`, "s").test(name);
}
