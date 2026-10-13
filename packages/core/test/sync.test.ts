/**
 * The two-way sync baseline: fingerprints, and which side moved.
 */

import {
  adopt,
  afterPush,
  type Baseline,
  canvasHtml,
  compareSides,
  fingerprint,
  minute,
  plainCriteria,
  type Sides,
} from "@edutools/core/sync";
import { describe, expect, it } from "vitest";

function sides(repo: Record<string, string>, canvas: Record<string, string>, matches: Record<string, boolean> = {}): Sides {
  return { repo, canvas, matches };
}

const AT = "2026-10-13T12:00:00Z";
const synced: Baseline = { repo: { body: "r1", settings: "rs" }, canvas: { body: "c1", settings: "cs" }, at: AT };

describe("fingerprint", () => {
  it("ignores key order and changes with any value", () => {
    expect(fingerprint({ a: 1, b: [1, 2] })).toBe(fingerprint({ b: [1, 2], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it("canvasHtml drops what Canvas adds on its own, and keeps edits", () => {
    const saved =
      '<p><a href="/courses/1/files/2?verifier=abc123&amp;wrap=1" data-api-endpoint="x" data-api-returntype="File">f</a></p>\n  <p>x</p>';
    const read = '<p><a href="/courses/1/files/2?wrap=1">f</a></p><p>x</p>';
    expect(canvasHtml(saved)).toBe(canvasHtml(read));
    expect(canvasHtml("<p>x</p>")).not.toBe(canvasHtml("<p>y</p>"));
  });

  it("minute compares a UTC copy and an offset copy of the same moment as one", () => {
    expect(minute("2026-10-15T05:59:00Z")).toBe(minute("2026-10-14T23:59:00-06:00"));
    expect(minute("2026-10-15T05:59:59Z")).toBe(minute("2026-10-15T05:59:00Z"));
    expect(minute(null)).toBeNull();
  });

  it("plainCriteria unescapes what Canvas escaped", () => {
    expect(plainCriteria([{ description: "a &quot;b&quot;", points: 2, longDescription: "it&#39;s" }])).toEqual([
      { description: 'a "b"', points: 2, longDescription: "it's" },
    ]);
  });
});

describe("compareSides", () => {
  it("nothing moved is in sync", () => {
    const result = compareSides(synced, sides({ body: "r1", settings: "rs" }, { body: "c1", settings: "cs" }));
    expect(result).toEqual({ state: "in-sync", repo: [], canvas: [], unknown: [] });
  });

  it("a repo change is the repo's", () => {
    const result = compareSides(synced, sides({ body: "r2", settings: "rs" }, { body: "c1", settings: "cs" }));
    expect(result.state).toBe("repo");
    expect(result.repo).toEqual(["body"]);
  });

  it("a Canvas change is Canvas's", () => {
    const result = compareSides(synced, sides({ body: "r1", settings: "rs" }, { body: "c1", settings: "cs2" }));
    expect(result.state).toBe("canvas");
    expect(result.canvas).toEqual(["settings"]);
  });

  it("both sides moving is a conflict, even on different parts", () => {
    const result = compareSides(synced, sides({ body: "r2", settings: "rs" }, { body: "c1", settings: "cs2" }));
    expect(result.state).toBe("conflict");
    expect(result.repo).toEqual(["body"]);
    expect(result.canvas).toEqual(["settings"]);
  });

  it("both sides making the same change is in sync", () => {
    const result = compareSides(synced, sides({ body: "r2", settings: "rs" }, { body: "c2", settings: "cs" }, { body: true }));
    expect(result.state).toBe("in-sync");
  });

  it("with no baseline, agreement is in sync and a difference is unknown", () => {
    expect(compareSides(null, sides({ body: "r" }, { body: "c" }, { body: true })).state).toBe("in-sync");
    const result = compareSides(null, sides({ body: "r" }, { body: "c" }, { body: false }));
    expect(result.state).toBe("unknown");
    expect(result.unknown).toEqual(["body"]);
  });

  it("only the parts the repo manages are compared", () => {
    // Canvas has a rubric the repo does not declare: Canvas's alone.
    const result = compareSides(synced, sides({ body: "r1", settings: "rs" }, { body: "c1", settings: "cs", rubric: "x" }));
    expect(result.state).toBe("in-sync");
  });

  it("an adopted part reads a lasting difference as the repo's change", () => {
    const adopted: Baseline = { repo: {}, canvas: { body: "c1" }, at: AT };
    expect(compareSides(adopted, sides({ body: "r" }, { body: "c1" }, { body: false })).state).toBe("repo");
    expect(compareSides(adopted, sides({ body: "r" }, { body: "c1" }, { body: true })).state).toBe("in-sync");
    expect(compareSides(adopted, sides({ body: "r" }, { body: "c2" }, { body: false })).state).toBe("conflict");
    expect(compareSides(adopted, sides({ body: "r" }, { body: "c2" }, { body: true })).state).toBe("in-sync");
  });
});

describe("recording a baseline", () => {
  it("afterPush records only the parts the push wrote", () => {
    const now = sides({ body: "r2", settings: "rs2", rubric: "rr" }, { body: "c2", settings: "cs2", rubric: "cr" });
    const next = afterPush(synced, now, ["body"], "later");
    expect(next).toEqual({ repo: { body: "r2", settings: "rs" }, canvas: { body: "c2", settings: "cs" }, at: "later" });
  });

  it("adopt fills only missing parts, and records the repo only where the sides agree", () => {
    const now = sides({ body: "r", settings: "rs", rubric: "rr" }, { body: "c", settings: "cs", rubric: "cr" }, { rubric: true });
    const partial: Baseline = { repo: { body: "r0" }, canvas: { body: "c0" }, at: AT };
    expect(adopt(partial, now, "later")).toEqual({
      repo: { body: "r0", rubric: "rr" },
      canvas: { body: "c0", settings: "cs", rubric: "cr" },
      at: "later",
    });
    const full: Baseline = { repo: { rubric: "rr" }, canvas: { body: "c", settings: "cs", rubric: "cr" }, at: AT };
    expect(adopt(full, now, "later")).toBeNull();
  });

  it("adopt records a change copied from Canvas into the repo, and nothing the repo changed alone", () => {
    // Both moved and now agree: the change was brought into the repo by hand.
    const copied = sides({ body: "r2" }, { body: "c2" }, { body: true });
    expect(adopt(synced, copied, "later")).toEqual({
      repo: { body: "r2", settings: "rs" },
      canvas: { body: "c2", settings: "cs" },
      at: "later",
    });
    // Only the repo moved: still a push to make, even if the two look alike.
    expect(adopt(synced, sides({ body: "r2" }, { body: "c1" }, { body: true }), "later")).toBeNull();
    // Adopted while different, and now the same: the repo side is filled in.
    const adopted: Baseline = { repo: {}, canvas: { body: "c1" }, at: AT };
    expect(adopt(adopted, sides({ body: "r" }, { body: "c1" }, { body: true }), "later")).toEqual({
      repo: { body: "r" },
      canvas: { body: "c1" },
      at: "later",
    });
  });
});
