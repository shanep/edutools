import { hunks, lineDiff, markupLines, textLines } from "@edutools/core/diff";
import { describe, expect, it } from "vitest";

describe("textLines", () => {
  it("writes a body as readable lines, the markdown way", () => {
    const html =
      '<h2 id="x">Intro</h2>\n<p>See <a href="/courses/1/pages/a">the page</a> and <code>ls -l</code>.</p>' +
      '<ul><li>One</li><li>Two <img src="/x.png" alt="logo"></li></ul>' +
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>&amp; 2</td></tr></table>";
    expect(textLines(html)).toEqual([
      "## Intro",
      "See [the page](/courses/1/pages/a) and `ls -l`.",
      "- One",
      "- Two ![logo](/x.png)",
      "a | b",
      "1 | & 2",
    ]);
  });

  it("keeps the lines of a pre block", () => {
    expect(textLines('<p>Run:</p><pre class="bash"><code>make\n  make test\n</code></pre>')).toEqual([
      "Run:",
      "make",
      "  make test",
    ]);
  });

  it("drops what Canvas adds on its own", () => {
    const repo = '<p><a href="/courses/1/files/9">pdf</a> <img src="/courses/1/files/8/preview" alt=""></p>';
    const canvas =
      '<link rel="stylesheet" href="https://cdn/x.css"><p><a href="https://canvas.example.edu/courses/1/files/9?location=course_syllabus_1" ' +
      'data-api-endpoint="x">pdf</a> <img src="https://canvas.example.edu/courses/1/files/8/preview?verifier=ab12-cd34-ef56" alt=""></p>';
    expect(textLines(canvas)).toEqual(textLines(repo));
    expect(markupLines(canvas)).toEqual(markupLines(repo));
  });
});

describe("markupLines", () => {
  it("puts every tag on a line of its own and ignores a style's closing semicolon", () => {
    expect(markupLines('<p style="color: red;">Hi <em>there</em></p>')).toEqual([
      '<p style="color: red">',
      "Hi",
      "<em>",
      "there",
      "</em>",
      "</p>",
    ]);
  });
});

describe("lineDiff and hunks", () => {
  it("marks dropped and added lines and keeps the rest", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "x" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
  });

  it("agreeing sides have no hunks", () => {
    expect(hunks(lineDiff(["a", "b"], ["a", "b"]))).toEqual([]);
  });

  it("numbers each hunk the unified way and keeps distant changes apart", () => {
    const repo = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const canvas = repo.map((line) => (line === "line 2" || line === "line 18" ? `${line}!` : line));
    const found = hunks(lineDiff(repo, canvas), 2);
    expect(found.map((h) => [h.repoStart, h.repoCount, h.canvasStart, h.canvasCount])).toEqual([
      [1, 4, 1, 4],
      [16, 5, 16, 5],
    ]);
    expect(found[0]?.lines).toEqual([
      { op: " ", text: "line 1" },
      { op: "-", text: "line 2" },
      { op: "+", text: "line 2!" },
      { op: " ", text: "line 3" },
      { op: " ", text: "line 4" },
    ]);
  });

  it("a line added to an empty side starts at 0 there", () => {
    expect(hunks(lineDiff([], ["new"]))).toEqual([
      { repoStart: 0, repoCount: 0, canvasStart: 1, canvasCount: 1, lines: [{ op: "+", text: "new" }] },
    ]);
  });
});
