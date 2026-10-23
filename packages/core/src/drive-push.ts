/**
 * Push a course repository to Google Drive, and say what changed since.
 *
 * Two passes, like the Canvas push and for the same reason: links need ids.
 * Pass one makes sure every folder, Doc and file exists in the right place,
 * creating an empty Doc for anything new. Pass two renders each Doc with its
 * links pointed at those ids and sends only what changed since the last push.
 *
 * A Doc someone edited in Drive is not overwritten: its modifiedTime no longer
 * matches the one the last push recorded, so the push reports a conflict and
 * leaves it alone unless told to force it.
 *
 * Orchestration only: Drive comes in as a narrow client, progress goes out
 * through a callback, and nothing here prints.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { CourseError } from "./course";
import { DateConfigError } from "./dates";
import type { DriveFile, GoogleDrive } from "./drive";
import {
  contentFingerprint,
  contentType,
  type DriveEntry,
  type DriveItem,
  type DriveLayout,
  DriveManifest,
  driveLayout,
  driveResolver,
  folderUrl,
  renderDoc,
} from "./drive-render";
import { PublishError, ValueError } from "./publish";
import { Publisher } from "./publisher";

/** The part of GoogleDrive a push drives, so a test can hand in plain fakes. */
export type DriveClient = Pick<
  GoogleDrive,
  "getFile" | "createFolder" | "createDoc" | "uploadFile" | "replaceContent" | "updateMetadata" | "trash"
>;

export interface DriveProgress {
  readonly message: string;
  readonly done?: number;
  readonly total?: number;
}

export type DriveAction = "create" | "recreate" | "update" | "move" | "unchanged" | "conflict" | "trash" | "orphan";

export interface DriveChange {
  readonly key: string;
  readonly kind: "doc" | "file" | "folder";
  readonly name: string;
  readonly action: DriveAction;
  readonly detail: string;
}

export interface DrivePushResult {
  readonly dryRun: boolean;
  /** The course folder, or null on a dry run before the first push. */
  readonly root: { readonly id: string; readonly url: string } | null;
  readonly changes: readonly DriveChange[];
  /** Repo key -> links in it that point at nothing Drive holds. */
  readonly unresolved: Readonly<Record<string, readonly string[]>>;
  /** Repo key -> the HTML each Doc was made from, for --preview. */
  readonly rendered: ReadonlyMap<string, string>;
}

export interface DrivePushOptions {
  readonly repo: string;
  /** Render and compare against the manifest, write nothing. */
  readonly dryRun?: boolean;
  /** Overwrite Docs and files that were edited in Drive. */
  readonly force?: boolean;
  /** Trash what the repo no longer has. Without it, those are listed as orphans. */
  readonly prune?: boolean;
  /** The course folder's name; defaults to the repo directory's name in capitals. */
  readonly name?: string;
  readonly progress?: (progress: DriveProgress) => void;
}

function open(repo: string): { publisher: Publisher; layout: DriveLayout } {
  try {
    const publisher = new Publisher(repo, "", null, { report: () => {} });
    return { publisher, layout: driveLayout(publisher, publisher.plan()) };
  } catch (error) {
    if (error instanceof PublishError || error instanceof ValueError || error instanceof DateConfigError) {
      throw new CourseError(error.message);
    }
    throw error;
  }
}

/** The course folder's default name: `docs/cs331` is "CS331". */
export function defaultFolderName(repo: string): string {
  return path.basename(path.resolve(repo)).toUpperCase();
}

function bytesOf(file: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(file));
}

function encode(html: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(html);
}

function entryOf(file: DriveFile, parent: string, sent: string): DriveEntry {
  return { id: file.id, name: file.name, parent, sent, modified: file.modifiedTime };
}

/** The content an item would send now, and its fingerprint. */
function content(
  item: DriveItem,
  repo: string,
  resolver: ReturnType<typeof driveResolver>,
): { bytes: Uint8Array<ArrayBuffer>; type: string; sent: string; html: string | null; unresolved: readonly string[] } {
  if (item.kind === "file") {
    const bytes = bytesOf(item.source);
    return { bytes, type: contentType(item.source), sent: contentFingerprint(bytes), html: null, unresolved: [] };
  }
  const doc = renderDoc(item, repo, resolver);
  return { bytes: encode(doc.html), type: "text/html", sent: contentFingerprint(doc.html), ...doc };
}

export async function drivePush(drive: DriveClient | null, options: DrivePushOptions): Promise<DrivePushResult> {
  const { publisher, layout } = open(options.repo);
  const repo = publisher.repo;
  const manifest = DriveManifest.forRepo(repo);
  const progress = options.progress ?? (() => {});
  const changes: DriveChange[] = [];
  const unresolved: Record<string, readonly string[]> = {};
  const rendered = new Map<string, string>();
  const change = (key: string, kind: DriveChange["kind"], name: string, action: DriveAction, detail = "") =>
    changes.push({ key, kind, name, action, detail });
  const wanted = new Set(layout.items.map((item) => item.key));
  const wantedFolders = new Set(layout.folders.map((folder) => folder.key));

  if (options.dryRun || drive === null) {
    // Ids come from the manifest; anything new links to a placeholder until it exists.
    const resolver = driveResolver(repo, layout.items, (key) => manifest.items.get(key)?.id ?? `new:${key}`);
    layout.items.forEach((item, index) => {
      progress({ message: `Rendering ${item.key}`, done: index, total: layout.items.length });
      const next = content(item, repo, resolver);
      if (next.html !== null) rendered.set(item.key, next.html);
      if (next.unresolved.length > 0) unresolved[item.key] = next.unresolved;
      const entry = manifest.items.get(item.key);
      if (entry === undefined) change(item.key, item.kind, item.name, "create");
      else if (entry.sent !== next.sent) change(item.key, item.kind, item.name, "update");
      else change(item.key, item.kind, item.name, "unchanged");
    });
    for (const key of manifest.items.keys()) {
      if (!wanted.has(key)) change(key, "doc", manifest.items.get(key)?.name ?? key, options.prune ? "trash" : "orphan");
    }
    const root = manifest.root ? { id: manifest.root.id, url: folderUrl(manifest.root.id) } : null;
    return { dryRun: true, root, changes, unresolved, rendered };
  }

  // -- the course folder and the module folders -------------------------

  progress({ message: "Finding the course folder" });
  const rootName = options.name ?? manifest.root?.name ?? defaultFolderName(repo);
  let root = manifest.root ? await drive.getFile(manifest.root.id) : null;
  if (root === null || root.trashed) {
    root = await drive.createFolder(rootName, null);
    change("", "folder", rootName, manifest.root ? "recreate" : "create");
  } else if (root.name !== rootName) {
    root = await drive.updateMetadata(root.id, { name: rootName });
  }
  manifest.root = entryOf(root, "", "");
  manifest.save();
  const rootId = root.id;

  /** Make sure a file sits under `parent` with `name`, moving or renaming it if not. */
  const place = async (file: DriveFile, name: string, parent: string): Promise<DriveFile> => {
    const misplaced = !file.parents.includes(parent);
    if (!misplaced && file.name === name) return file;
    return drive.updateMetadata(file.id, {
      ...(file.name === name ? {} : { name }),
      ...(misplaced ? { addParent: parent, removeParents: file.parents } : {}),
    });
  };

  const folderIds = new Map<string, string>();
  for (const folder of layout.folders) {
    const entry = manifest.folders.get(folder.key);
    let file = entry ? await drive.getFile(entry.id) : null;
    if (file === null || file.trashed) {
      file = await drive.createFolder(folder.name, rootId);
      change(folder.key, "folder", folder.name, entry ? "recreate" : "create");
    } else {
      const before = file;
      file = await place(file, folder.name, rootId);
      if (file !== before) change(folder.key, "folder", folder.name, "move", `was ${before.name}`);
    }
    manifest.folders.set(folder.key, entryOf(file, rootId, ""));
    folderIds.set(folder.key, file.id);
  }
  manifest.save();

  // -- pass one: every item exists, in its folder, under its name --------

  const editedInDrive = new Set<string>();
  const fresh = new Set<string>();
  for (const [index, item] of layout.items.entries()) {
    progress({ message: `Placing ${item.key}`, done: index, total: layout.items.length });
    const parent = item.folder ? (folderIds.get(item.folder) ?? rootId) : rootId;
    const entry = manifest.items.get(item.key);
    const existing = entry ? await drive.getFile(entry.id) : null;
    if (entry === undefined || existing === null || existing.trashed) {
      let file: DriveFile;
      let sent = "";
      if (item.kind === "file") {
        const bytes = bytesOf(item.source);
        file = await drive.uploadFile(item.name, parent, bytes, contentType(item.source));
        sent = contentFingerprint(bytes);
      } else {
        file = await drive.createDoc(item.name, parent);
      }
      manifest.items.set(item.key, entryOf(file, parent, sent));
      manifest.save();
      fresh.add(item.key);
      change(item.key, item.kind, item.name, entry ? "recreate" : "create");
      continue;
    }
    const edited = existing.modifiedTime !== entry.modified;
    if (edited) editedInDrive.add(item.key);
    const moved = await place(existing, item.name, parent);
    if (moved !== existing) {
      // A move after an edit in Drive keeps the old baseline, so the edit still shows.
      manifest.items.set(item.key, { ...entry, name: moved.name, parent, modified: edited ? entry.modified : moved.modifiedTime });
      manifest.save();
      change(item.key, item.kind, item.name, "move", `was ${existing.name}`);
    }
  }

  // -- pass two: content --------------------------------------------------

  const resolver = driveResolver(repo, layout.items, (key) => manifest.items.get(key)?.id ?? null);
  for (const [index, item] of layout.items.entries()) {
    progress({ message: `Writing ${item.key}`, done: index, total: layout.items.length });
    const entry = manifest.items.get(item.key);
    if (entry === undefined) continue;
    const next = content(item, repo, resolver);
    if (next.html !== null) rendered.set(item.key, next.html);
    if (next.unresolved.length > 0) unresolved[item.key] = next.unresolved;
    if (entry.sent === next.sent) {
      if (!fresh.has(item.key) && !changes.some((c) => c.key === item.key)) {
        change(item.key, item.kind, item.name, "unchanged");
      }
      continue;
    }
    if (editedInDrive.has(item.key) && !options.force) {
      change(item.key, item.kind, item.name, "conflict", "edited in Drive since the last push; --force overwrites it");
      continue;
    }
    const file = await drive.replaceContent(entry.id, next.bytes, next.type);
    manifest.items.set(item.key, { ...entry, sent: next.sent, modified: file.modifiedTime });
    manifest.save();
    if (!fresh.has(item.key)) change(item.key, item.kind, item.name, "update");
  }

  // -- what the repo no longer has ---------------------------------------

  for (const [key, entry] of [...manifest.items.entries()]) {
    if (wanted.has(key)) continue;
    if (options.prune) {
      await drive.trash(entry.id);
      manifest.items.delete(key);
      change(key, "doc", entry.name, "trash");
    } else {
      change(key, "doc", entry.name, "orphan", "no longer in the repo; --prune trashes it");
    }
  }
  for (const [key, entry] of [...manifest.folders.entries()]) {
    if (wantedFolders.has(key)) continue;
    if (options.prune) {
      await drive.trash(entry.id);
      manifest.folders.delete(key);
      change(key, "folder", entry.name, "trash");
    } else {
      change(key, "folder", entry.name, "orphan", "no longer a module; --prune trashes it");
    }
  }
  manifest.save();

  return { dryRun: false, root: { id: rootId, url: folderUrl(rootId) }, changes, unresolved, rendered };
}

// ============================================================================
// Status
// ============================================================================

export type DriveState = "in-sync" | "repo" | "drive" | "conflict" | "new" | "missing" | "orphan";

export interface DriveStatusItem {
  readonly key: string;
  readonly kind: "doc" | "file";
  readonly name: string;
  readonly state: DriveState;
  /** The Drive URL, or "" for an item never pushed. */
  readonly url: string;
}

export interface DriveStatusResult {
  readonly root: { readonly id: string; readonly url: string } | null;
  readonly items: readonly DriveStatusItem[];
}

/** The states that need a decision before the next push. */
export const DRIVE_NEEDS_ATTENTION: ReadonlySet<DriveState> = new Set(["drive", "conflict", "missing"]);

/**
 * Which side moved since the last push, item by item. Reads Drive, never
 * writes it. "repo" means the next push sends a change; "drive" means someone
 * edited the Doc in Drive and a push would refuse to overwrite it.
 */
export async function driveStatus(
  drive: Pick<DriveClient, "getFile">,
  options: { repo: string; progress?: (progress: DriveProgress) => void },
): Promise<DriveStatusResult> {
  const { publisher, layout } = open(options.repo);
  const repo = publisher.repo;
  const manifest = DriveManifest.forRepo(repo);
  const progress = options.progress ?? (() => {});
  const resolver = driveResolver(repo, layout.items, (key) => manifest.items.get(key)?.id ?? `new:${key}`);
  const items: DriveStatusItem[] = [];
  for (const [index, item] of layout.items.entries()) {
    progress({ message: `Checking ${item.key}`, done: index, total: layout.items.length });
    const entry = manifest.items.get(item.key);
    if (entry === undefined) {
      items.push({ key: item.key, kind: item.kind, name: item.name, state: "new", url: "" });
      continue;
    }
    const remote = await drive.getFile(entry.id);
    const url = remote?.webViewLink ?? "";
    if (remote === null || remote.trashed) {
      items.push({ key: item.key, kind: item.kind, name: item.name, state: "missing", url });
      continue;
    }
    const repoChanged = content(item, repo, resolver).sent !== entry.sent || remote.name !== item.name;
    const driveChanged = remote.modifiedTime !== entry.modified;
    const state: DriveState =
      repoChanged && driveChanged ? "conflict" : driveChanged ? "drive" : repoChanged ? "repo" : "in-sync";
    items.push({ key: item.key, kind: item.kind, name: item.name, state, url });
  }
  const wanted = new Set(layout.items.map((item) => item.key));
  for (const [key, entry] of manifest.items) {
    if (!wanted.has(key)) items.push({ key, kind: "doc", name: entry.name, state: "orphan", url: "" });
  }
  const root = manifest.root ? { id: manifest.root.id, url: folderUrl(manifest.root.id) } : null;
  return { root, items };
}
