/**
 * The course as a Google Drive folder: the layout, the rendered Docs, and a
 * push and status driven against a small repo on disk and an in-memory Drive.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CourseError } from "@edutools/core/course";
import { DOC_MIME, type DriveFile, FOLDER_MIME } from "@edutools/core/drive";
import { type DriveClient, defaultFolderName, drivePush, driveStatus } from "@edutools/core/drive-push";
import {
  contentType,
  docUrl,
  driveLayout,
  fileUrl,
  imageDataUri,
  rewriteDriveLinks,
} from "@edutools/core/drive-render";
import { Publisher } from "@edutools/core/publisher";
import { describe, expect, it } from "vitest";

const TOML = `[term]
timezone = "America/Boise"
first_monday = 2026-08-24
weeks = 15
last_day_of_instruction = 2026-12-11
finals_start = 2026-12-14
finals_end = 2026-12-18
total_points = 0

[term.policy.project]
due = "tue 23:59"

[layout]
syllabus = "index.md"
pages = ["pages/*.md", "instructor/*.md"]
files = ["images/pic.png", "images/diagram.svg", "docs/book.pdf"]

[layout.gradable]
project = "assignments/p[0-9]*.md"

[icons]
"goal" = "icons/goal.svg"

[[module]]
title = "Instructor Resources"
never_publish = true
items = ["instructor/guide.md"]

[[module]]
title = "Week 1"
items = ["pages/welcome.md", "assignments/p0.md"]
`;

const WELCOME =
  "# Welcome\n\nSee [P0](../assignments/p0.md), [the book](../docs/book.pdf) and [nothing](missing.md).\n\n" +
  "![A picture](../images/pic.png)\n\n![A diagram](../images/diagram.svg)\n\n![](../images/diagram.svg)\n\n" +
  "## Instructor Notes\n\n*Instructor note, not shown to students.* The secret.\n";

function write(repo: string, name: string, text: string | Uint8Array): void {
  const file = path.join(repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  write(repo, "canvas.toml", TOML);
  write(repo, "index.md", "# Syllabus\n\nRead [the welcome](pages/welcome.md).\n");
  write(repo, "pages/welcome.md", WELCOME);
  write(repo, "instructor/guide.md", "# Instructor Guide\n\nFor instructors.\n");
  write(repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points · x**\n\nDo it.\n");
  write(repo, "assignments/p1.md", "# P1\n\n**Week 4 · 100 points · x**\n\nDo more.\n");
  write(repo, "images/pic.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  write(repo, "images/diagram.svg", "<svg/>");
  write(repo, "icons/goal.svg", "<svg/>");
  write(repo, "docs/book.pdf", "%PDF-1.7 book");
  return repo;
}

/** Drive in memory: ids count up, and every write moves the clock a minute. */
class FakeDrive implements DriveClient {
  readonly files = new Map<string, DriveFile>();
  readonly content = new Map<string, string>();
  readonly writes: string[] = [];
  private next = 0;
  private clock = 0;

  private stamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 1) + this.clock * 60_000).toISOString();
  }

  private put(file: DriveFile): DriveFile {
    this.files.set(file.id, file);
    return file;
  }

  private make(name: string, mimeType: string, parent: string | null): DriveFile {
    this.next += 1;
    const id = `id${this.next}`;
    return this.put({
      id,
      name,
      mimeType,
      modifiedTime: this.stamp(),
      trashed: false,
      parents: parent ? [parent] : ["my-drive"],
      webViewLink: `https://drive.example/${id}`,
    });
  }

  private must(id: string): DriveFile {
    const file = this.files.get(id);
    if (!file) throw new Error(`no file ${id}`);
    return file;
  }

  async getFile(id: string): Promise<DriveFile | null> {
    return this.files.get(id) ?? null;
  }

  async createFolder(name: string, parent: string | null): Promise<DriveFile> {
    this.writes.push(`folder ${name}`);
    return this.make(name, FOLDER_MIME, parent);
  }

  async createDoc(name: string, parent: string): Promise<DriveFile> {
    this.writes.push(`doc ${name}`);
    return this.make(name, DOC_MIME, parent);
  }

  async uploadFile(name: string, parent: string, bytes: Uint8Array, type: string): Promise<DriveFile> {
    this.writes.push(`upload ${name}`);
    const file = this.make(name, type, parent);
    this.content.set(file.id, new TextDecoder().decode(bytes));
    return file;
  }

  async replaceContent(id: string, bytes: Uint8Array, _type: string): Promise<DriveFile> {
    this.writes.push(`replace ${this.must(id).name}`);
    this.content.set(id, new TextDecoder().decode(bytes));
    return this.put({ ...this.must(id), modifiedTime: this.stamp() });
  }

  async updateMetadata(
    id: string,
    change: { name?: string; addParent?: string; removeParents?: readonly string[] },
  ): Promise<DriveFile> {
    const file = this.must(id);
    this.writes.push(`meta ${file.name}`);
    const parents = change.addParent
      ? [...file.parents.filter((p) => !(change.removeParents ?? []).includes(p)), change.addParent]
      : file.parents;
    return this.put({ ...file, name: change.name ?? file.name, parents, modifiedTime: this.stamp() });
  }

  async trash(id: string): Promise<void> {
    this.writes.push(`trash ${this.must(id).name}`);
    this.put({ ...this.must(id), trashed: true });
  }

  /** Someone opens the Doc in Drive and types. */
  edit(id: string): void {
    this.put({ ...this.must(id), modifiedTime: this.stamp() });
  }

  /** Docs finishes converting an upload a moment after the write returns. */
  settle(id: string): void {
    const file = this.must(id);
    this.put({ ...file, modifiedTime: new Date(Date.parse(file.modifiedTime) + 900).toISOString() });
  }

  byName(name: string): DriveFile {
    const file = [...this.files.values()].find((f) => f.name === name);
    if (!file) throw new Error(`no file named ${name}`);
    return file;
  }
}

function manifestOf(repo: string): { root: { id: string }; items: Record<string, { id: string; sent: string }> } {
  return JSON.parse(readFileSync(path.join(repo, ".drive", "manifest.json"), "utf8"));
}

function actions(result: { changes: readonly { key: string; action: string }[] }): Record<string, string> {
  return Object.fromEntries(result.changes.filter((c) => c.key).map((c) => [c.key, c.action]));
}

describe("the layout", () => {
  it("puts the syllabus at the top, a folder per module in order, and the rest in Files and Other", () => {
    const repo = makeRepo();
    const publisher = new Publisher(repo, "", null, { report: () => {} });
    const layout = driveLayout(publisher, publisher.plan());
    expect(layout.folders.map((f) => f.key)).toEqual([
      "module:Instructor Resources",
      "module:Week 1",
      "files",
      "other",
    ]);
    expect(layout.folders[0]?.name).toMatch(/^01 Instructor Resources/);
    expect(layout.folders[1]?.name).toMatch(/^02 Week 1/);
    const where = Object.fromEntries(layout.items.map((item) => [item.key, [item.folder, item.name]]));
    expect(where["index.md"]).toEqual(["", "00 Syllabus"]);
    expect(where["instructor/guide.md"]).toEqual(["module:Instructor Resources", "01 Instructor Guide"]);
    expect(where["pages/welcome.md"]).toEqual(["module:Week 1", "01 Welcome"]);
    expect(where["assignments/p0.md"]?.[1]).toMatch(/^02 /);
    expect(where["assignments/p1.md"]?.[0]).toBe("other");
    expect(where["docs/book.pdf"]).toEqual(["files", "book.pdf"]);
    expect(layout.items.find((item) => item.key === "docs/book.pdf")?.kind).toBe("file");
    expect(where["icons/goal.svg"]).toBeUndefined();
  });

  it("names the course folder after the repo", () => {
    expect(defaultFolderName("/x/docs/cs331")).toBe("CS331");
  });
});

describe("rendering", () => {
  it("points repo links at Drive and reports the ones it cannot", () => {
    const repo = makeRepo();
    const source = path.join(repo, "pages", "welcome.md");
    const html =
      '<a href="../assignments/p0.md#part-1">P0</a> <a href="https://x.org">x</a> ' +
      '<a href="#top">top</a> <a href="missing.md">m</a> <a href="../../outside.md">o</a>';
    const [out, unresolved] = rewriteDriveLinks(html, source, repo, (key) =>
      key === "assignments/p0.md" ? docUrl("D") : null,
    );
    expect(out).toContain(`href="${docUrl("D")}"`);
    expect(out).toContain('href="https://x.org"');
    expect(out).toContain('href="#top"');
    expect(unresolved).toEqual(["missing.md", "../../outside.md"]);
  });

  it("embeds raster images and leaves SVG alone", () => {
    const repo = makeRepo();
    expect(imageDataUri(path.join(repo, "images", "pic.png"))).toMatch(/^data:image\/png;base64,/);
    write(repo, "images/logo.svg", "<svg/>");
    expect(imageDataUri(path.join(repo, "images", "logo.svg"))).toBeNull();
    expect(contentType("a/b.PDF")).toBe("application/pdf");
    expect(contentType("a/b.c")).toBe("application/octet-stream");
  });
});

describe("drivePush", () => {
  it("renders on a dry run without Drive and writes nothing", async () => {
    const repo = makeRepo();
    const result = await drivePush(null, { repo, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.root).toBeNull();
    expect(new Set(Object.values(actions(result)))).toEqual(new Set(["create"]));
    const welcome = result.rendered.get("pages/welcome.md") ?? "";
    expect(welcome).toContain("The secret.");
    expect(welcome).toContain("data:image/png;base64,");
    expect(welcome).toContain('<a href="https://drive.google.com/file/d/new:images/diagram.svg/view">A diagram</a>');
    expect(welcome.match(/diagram\.svg/g)).toHaveLength(1);
    expect(result.rendered.get("assignments/p0.md")).toContain("<strong>Due:</strong>");
    expect(result.unresolved).toEqual({ "pages/welcome.md": ["missing.md"] });
    expect(existsSync(path.join(repo, ".drive"))).toBe(false);
  });

  it("builds the whole folder on the first push", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    const result = await drivePush(drive, { repo, name: "CS999" });
    const root = drive.byName("CS999");
    expect(root.parents).toEqual(["my-drive"]);
    expect(result.root?.id).toBe(root.id);
    expect(drive.byName("00 Syllabus").parents).toEqual([root.id]);
    const week = drive.files.get(drive.byName("01 Welcome").parents[0] ?? "");
    expect(week?.name).toMatch(/^02 Week 1/);
    expect(week?.parents).toEqual([root.id]);
    const book = drive.byName("book.pdf");
    expect(drive.content.get(book.id)).toBe("%PDF-1.7 book");

    const manifest = manifestOf(repo);
    const html = drive.content.get(drive.byName("01 Welcome").id) ?? "";
    expect(html).toContain(docUrl(manifest.items["assignments/p0.md"]?.id ?? ""));
    expect(html).toContain(fileUrl(book.id));
    expect(html).toContain("The secret.");
    expect(drive.content.get(drive.byName("00 Syllabus").id)).toContain(
      docUrl(manifest.items["pages/welcome.md"]?.id ?? ""),
    );
    expect(manifest.root.id).toBe(root.id);
    expect(new Set(Object.values(actions(result)))).toEqual(new Set(["create"]));
  });

  it("sends only what changed, to the same Doc", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    await drivePush(drive, { repo });
    const id = manifestOf(repo).items["assignments/p0.md"]?.id;
    drive.writes.length = 0;

    const again = await drivePush(drive, { repo });
    expect(new Set(Object.values(actions(again)))).toEqual(new Set(["unchanged"]));
    expect(drive.writes).toEqual([]);

    write(repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points · x**\n\nDo it better.\n");
    const changed = await drivePush(drive, { repo });
    expect(actions(changed)["assignments/p0.md"]).toBe("update");
    expect(drive.writes).toEqual([expect.stringMatching(/^replace 02 /)]);
    expect(manifestOf(repo).items["assignments/p0.md"]?.id).toBe(id);
    expect(drive.content.get(id ?? "")).toContain("Do it better.");
  });

  it("finds the folder again after it is moved in Drive", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    const first = await drivePush(drive, { repo });
    const root = first.root?.id ?? "";
    drive.files.set(root, { ...(drive.files.get(root) as DriveFile), parents: ["shared-folder"] });
    drive.writes.length = 0;
    const again = await drivePush(drive, { repo });
    expect(again.root?.id).toBe(root);
    expect(drive.writes).toEqual([]);
  });

  it("leaves a Doc edited in Drive alone unless forced", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    await drivePush(drive, { repo });
    const id = manifestOf(repo).items["pages/welcome.md"]?.id ?? "";
    drive.edit(id);
    write(repo, "pages/welcome.md", WELCOME.replace("See", "Read"));

    const status = await driveStatus(drive, { repo });
    expect(status.items.find((item) => item.key === "pages/welcome.md")?.state).toBe("conflict");

    const refused = await drivePush(drive, { repo });
    expect(actions(refused)["pages/welcome.md"]).toBe("conflict");
    expect(drive.content.get(id)).not.toContain("Read");

    const forced = await drivePush(drive, { repo, force: true });
    expect(actions(forced)["pages/welcome.md"]).toBe("update");
    expect(drive.content.get(id)).toContain("Read");
    const after = await driveStatus(drive, { repo });
    expect(after.items.every((item) => item.state === "in-sync")).toBe(true);
  });

  it("does not take Docs finishing its own conversion for an edit", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    await drivePush(drive, { repo });
    for (const id of drive.files.keys()) drive.settle(id);

    const status = await driveStatus(drive, { repo });
    expect(status.items.every((item) => item.state === "in-sync")).toBe(true);
    write(repo, "pages/welcome.md", WELCOME.replace("See", "Read"));
    expect(actions(await drivePush(drive, { repo }))["pages/welcome.md"]).toBe("update");
  });

  it("says which side changed", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    await drivePush(drive, { repo });
    const manifest = manifestOf(repo);
    drive.edit(manifest.items["index.md"]?.id ?? "");
    await drive.trash(manifest.items["instructor/guide.md"]?.id ?? "");
    write(repo, "assignments/p1.md", "# P1\n\n**Week 4 · 100 points · x**\n\nChanged.\n");
    write(repo, "pages/new.md", "# New\n\nHi.\n");
    rmSync(path.join(repo, "docs", "book.pdf"));
    writeFileSync(path.join(repo, "canvas.toml"), TOML.replace(', "docs/book.pdf"', ""));

    const status = await driveStatus(drive, { repo });
    const states = Object.fromEntries(status.items.map((item) => [item.key, item.state]));
    expect(states).toMatchObject({
      "index.md": "drive",
      "instructor/guide.md": "missing",
      "assignments/p1.md": "repo",
      "pages/new.md": "new",
      "docs/book.pdf": "orphan",
      "assignments/p0.md": "in-sync",
    });
  });

  it("recreates what was deleted in Drive and lists or trashes what the repo dropped", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    await drivePush(drive, { repo });
    const manifest = manifestOf(repo);
    const guide = manifest.items["instructor/guide.md"]?.id ?? "";
    const book = manifest.items["docs/book.pdf"]?.id ?? "";
    await drive.trash(guide);
    rmSync(path.join(repo, "docs", "book.pdf"));
    writeFileSync(path.join(repo, "canvas.toml"), TOML.replace(', "docs/book.pdf"', ""));

    const kept = await drivePush(drive, { repo });
    expect(actions(kept)["instructor/guide.md"]).toBe("recreate");
    expect(manifestOf(repo).items["instructor/guide.md"]?.id).not.toBe(guide);
    expect(actions(kept)["docs/book.pdf"]).toBe("orphan");
    expect(drive.files.get(book)?.trashed).toBe(false);

    const pruned = await drivePush(drive, { repo, prune: true });
    expect(actions(pruned)["docs/book.pdf"]).toBe("trash");
    expect(drive.files.get(book)?.trashed).toBe(true);
    expect(manifestOf(repo).items["docs/book.pdf"]).toBeUndefined();
  });

  it("renames a Doc whose title changed, at the same id", async () => {
    const repo = makeRepo();
    const drive = new FakeDrive();
    await drivePush(drive, { repo });
    const id = manifestOf(repo).items["pages/welcome.md"]?.id ?? "";
    write(repo, "pages/welcome.md", WELCOME.replace("# Welcome", "# Hello"));
    const result = await drivePush(drive, { repo });
    const change = result.changes.find((c) => c.key === "pages/welcome.md");
    expect(change?.action).toBe("move");
    expect(drive.files.get(id)?.name).toBe("01 Hello");
  });

  it("reports a repo with no canvas.toml as a course error", async () => {
    const repo = makeRepo();
    rmSync(path.join(repo, "canvas.toml"));
    await expect(drivePush(null, { repo, dryRun: true })).rejects.toThrow(CourseError);
  });
});
