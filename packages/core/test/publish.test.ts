import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globRepo } from "@edutools/core/paths";
import {
  addHeadingIcons,
  assertNoForbiddenTags,
  assignmentOptions,
  CANVAS_CSS_PROPERTIES,
  canvasPath,
  classifyCallouts,
  decorate,
  Entry,
  formatG,
  inlineCss,
  internalLinks,
  isDraft,
  Manifest,
  markTableRows,
  moduleEntries,
  moduleKeys,
  PublishError,
  parseQuiz,
  parseRubric,
  pathIsDraft,
  type Question,
  questionFields,
  renderGfm,
  renderInline,
  renderMarkdown,
  rewriteLinks,
  rubricFields,
  stripInstructorSections,
  stripTitle,
  stripVitepress,
  structureCounts,
  styleDeclarations,
  ValueError,
  visibleText,
  wrapTables,
} from "@edutools/core/publish";
import { describe, expect, it } from "vitest";

// EDUTOOLS_CS331 points the course checks at another checkout of the course repo.
const CS331 = process.env.EDUTOOLS_CS331 ?? path.join(os.homedir(), "repos", "CS331");
// The directory alone is not enough: the checks need the course content in it.
const noCS331 = !existsSync(path.join(CS331, "quizzes"));

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

function write(root: string, name: string, text: string): string {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

describe("the Canvas allowlist", () => {
  it("has 122 properties: the base list plus every prefix expansion, including border-{side}-{property}", () => {
    expect(CANVAS_CSS_PROPERTIES.size).toBe(122);
  });

  it.each([
    "background-color",
    "border-left",
    "padding-top",
    "font-family",
    "font-size",
    "border-radius",
    "grid-template-columns",
    "margin-top",
    "border-left-color",
    "border-top-width",
  ])("allows %s", (prop) => {
    expect(CANVAS_CSS_PROPERTIES.has(prop)).toBe(true);
  });

  it.each([
    "box-shadow",
    "text-shadow",
    "opacity",
    "transition",
    "transform",
    "letter-spacing",
    "text-transform",
    "font-weight",
  ])("blocks %s, which Canvas strips silently", (prop) => {
    expect(CANVAS_CSS_PROPERTIES.has(prop)).toBe(false);
  });
});

describe("rendering", () => {
  it("strips the title", () => {
    const [title, body] = stripTitle("# Lab 4\n\nSome prose.\n");
    expect(title).toBe("Lab 4");
    expect(body).not.toContain("# Lab 4");
  });

  it("removes instructor sections", () => {
    const source =
      "# Quiz\n\nBody.\n\n## Canvas import notes\n\n" +
      "*Instructor note, not shown to students.* Items 2 and 7 are multiple-answer.\n";
    const cleaned = stripInstructorSections(source);
    expect(cleaned).not.toContain("Instructor note");
    expect(cleaned).toContain("Body.");
  });

  it("detects forbidden tags", () => {
    expect(assertNoForbiddenTags("<p>ok</p>")).toEqual([]);
    expect(assertNoForbiddenTags("<style>p{color:red}</style>")).toContain("style");
  });
});

describe("the renderer emits pandoc's HTML", () => {
  it("gives headings GitHub style ids, numbering repeats", () => {
    expect(renderGfm("## Hello *World* & you\n\n## Hello *World* & you\n")).toBe(
      '<h2 id="hello-world--you">Hello <em>World</em> &amp; you</h2>\n' +
        '<h2 id="hello-world--you-1">Hello <em>World</em> &amp; you</h2>\n',
    );
  });

  it("writes tables with bare rows and pandoc's alignment styles", () => {
    expect(renderGfm("| a | b | c |\n|:--|---|--:|\n| 1 | 2 | 3 |\n")).toBe(
      "<table>\n<thead>\n<tr>\n" +
        '<th style="text-align: left;">a</th>\n<th>b</th>\n<th style="text-align: right;">c</th>\n' +
        "</tr>\n</thead>\n<tbody>\n<tr>\n" +
        '<td style="text-align: left;">1</td>\n<td>2</td>\n<td style="text-align: right;">3</td>\n' +
        "</tr>\n</tbody>\n</table>\n",
    );
  });

  it("drops a table header whose cells are all empty", () => {
    expect(renderGfm("| | |\n|---|---|\n| a | b |\n")).not.toContain("<thead>");
  });

  it("passes raw HTML through verbatim", () => {
    expect(renderGfm("<a href='x.md'>single</a> and <img src=x.png>\n")).toBe(
      "<p><a href='x.md'>single</a> and <img src=x.png></p>\n",
    );
  });

  it("classes a code block by its language and escapes quotes in it", () => {
    expect(renderGfm("```python\nx = 'a' < \"b\"\n```\n")).toBe(
      '<pre class="python"><code>x = &#39;a&#39; &lt; &quot;b&quot;</code></pre>\n',
    );
  });

  it("writes a soft break as a space and keeps link targets unencoded", () => {
    expect(renderGfm("one\ntwo [x](café.md)\n")).toBe('<p>one two <a href="café.md">x</a></p>\n');
  });

  it("links bare URLs, www. and email addresses, but not a bare domain", () => {
    expect(renderGfm("www.example.com and me@example.com and example.com\n")).toBe(
      '<p><a href="http://www.example.com">www.example.com</a> and ' +
        '<a href="mailto:me@example.com">me@example.com</a> and example.com</p>\n',
    );
  });

  it("writes task lists as pandoc does", () => {
    expect(renderGfm("- [ ] one\n- [x] two\n")).toBe(
      '<ul class="task-list">\n<li><label><input type="checkbox" />one</label></li>\n' +
        '<li><label><input type="checkbox" checked="" />two</label></li>\n</ul>\n',
    );
  });

  it("writes footnotes as pandoc does", () => {
    expect(renderGfm("A[^1].\n\n[^1]: Note.\n")).toBe(
      '<p>A<a href="#fn1" class="footnote-ref" id="fnref1" role="doc-noteref"><sup>1</sup></a>.</p>\n' +
        '<section id="footnotes" class="footnotes footnotes-end-of-document" role="doc-endnotes">\n<hr />\n<ol>\n' +
        '<li id="fn1"><p>Note.<a href="#fnref1" class="footnote-back" role="doc-backlink">\u21a9\ufe0e</a></p></li>\n' +
        "</ol>\n</section>\n",
    );
  });

  it("numbers an ordered list the way pandoc does", () => {
    expect(renderGfm("3. a\n4. b\n")).toBe('<ol start="3" type="1">\n<li>a</li>\n<li>b</li>\n</ol>\n');
  });
});

describe("decorate", () => {
  it("gives sections classes", () => {
    const out = decorate("<h2>Rubric</h2><p>x</p><h2>AI disclosure</h2><p>y</p>");
    expect(out).toContain('class="cs-rubric"');
    expect(out).toContain('class="cs-ai"');
  });

  it("gives an unknown heading a neutral class", () => {
    expect(decorate("<h2>Using ATT&amp;CK</h2><p>x</p>")).toContain('class="cs-section"');
  });

  it("leaves a page with no headings alone", () => {
    expect(decorate("<p>x</p>")).toBe("<p>x</p>");
  });

  it("tags the meta line", () => {
    expect(decorate("<p><strong>Week 7 · 38 points</strong></p>")).toContain('class="cs-meta"');
  });

  it("marks alternate rows", () => {
    const out = markTableRows("<table><tr><th>a</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></table>");
    expect(out).toContain("cs-row-odd");
    expect(out).toContain("cs-row-even");
  });

  it("gives tables a scroll wrapper", () => {
    const out = wrapTables("<table><tr><td>1</td></tr></table>");
    expect(out.startsWith('<div class="cs-scroll">')).toBe(true);
    expect(out.endsWith("</div>")).toBe(true);
  });
});

describe("inlineCss", () => {
  it("turns class rules into style attributes", () => {
    const [html, dropped] = inlineCss('<p class="cs-meta">x</p>', ".cs-meta{color:#001F60}");
    expect(html).toContain("style=");
    expect(html).toContain("color");
    expect(dropped).toEqual([]);
  });

  it("reports blocked properties rather than losing them silently", () => {
    const [html, dropped] = inlineCss('<p class="a">x</p>', ".a{color:red;box-shadow:0 0 4px #000}");
    expect(dropped).toEqual(["box-shadow"]);
    expect(html).not.toContain("box-shadow");
    expect(html).toContain("color");
  });

  it("does not keep the style tag", () => {
    const [html] = inlineCss("<p>x</p>", "p{color:red}");
    expect(html).not.toContain("<style");
  });
});

const QUIZ = `# Quiz

**Q1.** A single-answer question. *(Objective 1.1)*

- A. wrong
- B. right
- C. wrong
- D. wrong

*Answer:* **B** \u2014 because of reasons. (CyBOK §1.1)

---

**Q2.** Select **all** that apply.

- A. yes
- B. no
- C. yes
- D. no

*Answer:* **A and C** \u2014 two are correct.

---

**Q3.** True or false: something.

- A. True
- B. False

*Answer:* **B** \u2014 false, because.
`;

describe("quiz parsing", () => {
  const quiz = (text: string): string => write(tmp(), "quiz-99-test.md", text);

  it("takes the types from the stem", () => {
    expect(parseQuiz(quiz(QUIZ)).map((q) => q.kind)).toEqual([
      "multiple_choice_question",
      "multiple_answers_question",
      "true_false_question",
    ]);
  });

  it("reads the correct answers", () => {
    const questions = parseQuiz(quiz(QUIZ));
    expect(questions[0]?.correctLetters).toEqual(["B"]);
    expect(questions[1]?.correctLetters).toEqual(["A", "C"]);
  });

  it("extracts the objective from the stem", () => {
    const [first] = parseQuiz(quiz(QUIZ));
    expect(first?.objective).toBe("1.1");
    expect(first?.stem).not.toContain("Objective");
  });

  it("captures the rationale", () => {
    expect(parseQuiz(quiz(QUIZ))[0]?.rationale.startsWith("because of reasons")).toBe(true);
  });

  it("keeps a select-all with one correct answer as multiple answers", () => {
    // quiz-01 Q2 is exactly this shape; reading the type off the answer would misclassify it.
    const text = "**Q1.** Select **all** that apply.\n\n- A. yes\n- B. no\n\n*Answer:* **A only** \u2014 just one.\n";
    const [first] = parseQuiz(quiz(text));
    expect(first?.kind).toBe("multiple_answers_question");
    expect(first?.correctLetters).toEqual(["A"]);
  });

  it("treats disagreement with the instructor note as fatal", () => {
    const text = `${QUIZ}\n\n## Canvas import notes\n\nItems 1 are multiple-answer; the rest are not.\n`;
    expect(() => parseQuiz(quiz(text))).toThrow(PublishError);
    expect(() => parseQuiz(quiz(text))).toThrow(/instructor note/);
  });

  it("keys the right answers in the question fields", () => {
    const question = parseQuiz(quiz(QUIZ))[1] as Question;
    const weights = questionFields(question, 1)
      .filter(([k]) => k.endsWith("[answer_weight]"))
      .map(([, v]) => v);
    expect(weights).toEqual(["100", "0", "100", "0"]);
  });
});

describe("rubric parsing", () => {
  it("reads criteria and points", () => {
    const criteria = parseRubric(
      "## Rubric\n\n| Row | What is assessed | Points |\n| --- | --- | ---: |\n" +
        "| 1 | First thing | 6 |\n| 2 | Second thing | 12 |\n| | **Total** | **18** |\n",
    );
    expect(criteria.map((c) => c.points)).toEqual([6, 12]);
    expect(criteria[0]?.description).toBe("First thing");
  });

  it("returns nothing without a rubric section", () => {
    expect(parseRubric("## Goal\n\nNothing here.\n")).toEqual([]);
  });

  it("makes the rubric fields total match", () => {
    const criteria = parseRubric(
      "## Rubric\n\n| Row | What | Points |\n| --- | --- | ---: |\n| 1 | a | 20 |\n| 2 | b | 18 |\n",
    );
    const fields = Object.fromEntries(rubricFields("Lab 1 rubric", criteria, "123"));
    expect(fields["rubric[points_possible]"]).toBe("38");
    expect(fields["rubric_association[association_id]"]).toBe("123");
  });

  it("formats points as Python's :g does", () => {
    expect([38, 2.5, 0, 0.1 + 0.2, 1234567, 0.00001].map(formatG)).toEqual([
      "38",
      "2.5",
      "0",
      "0.3",
      "1.23457e+06",
      "1e-05",
    ]);
  });
});

describe("manifest and links", () => {
  it("round trips", () => {
    const root = tmp();
    const manifest = new Manifest(path.join(root, ".canvas", "m.json"));
    manifest.put("modules/week-01.md", new Entry({ kind: "page", canvasId: "w1", pageUrl: "w1", title: "Week 1" }));
    const entry = new Manifest(path.join(root, ".canvas", "m.json")).get("modules/week-01.md");
    expect(entry).not.toBeNull();
    expect(entry?.pageUrl).toBe("w1");
  });

  it("writes the file Python wrote: sorted keys, snake case, ASCII escapes", () => {
    const root = tmp();
    const file = path.join(root, ".canvas", "m.json");
    const manifest = new Manifest(file);
    manifest.put("b.md", new Entry({ kind: "assignment", canvasId: "7", title: "Café" }));
    manifest.put("a.md", new Entry({ kind: "page", canvasId: "p", pageUrl: "p", extra: { z: "1", a: "2" } }));
    expect(readFileSync(file, "utf8")).toBe(
      '{\n  "entries": {\n    "a.md": {\n      "canvas_id": "p",\n      "extra": {\n        "a": "2",\n' +
        '        "z": "1"\n      },\n      "kind": "page",\n      "page_url": "p",\n      "title": ""\n    },\n' +
        '    "b.md": {\n      "canvas_id": "7",\n      "extra": {},\n      "kind": "assignment",\n' +
        '      "page_url": "",\n      "title": "Caf\\u00e9"\n    }\n  }\n}\n',
    );
  });

  it("builds Canvas paths", () => {
    expect(canvasPath(new Entry({ kind: "page", canvasId: "x", pageUrl: "week-01" }), "42")).toBe(
      "/courses/42/pages/week-01",
    );
    expect(canvasPath(new Entry({ kind: "assignment", canvasId: "7" }), "42")).toBe("/courses/42/assignments/7");
    expect(canvasPath(new Entry({ kind: "file", canvasId: "9" }), "42")).toBe("/courses/42/files/9");
  });

  it("rewrites relative links", () => {
    const repo = tmp();
    const source = write(repo, "modules/week-01.md", "x");
    write(repo, "assignments/lab-00.md", "y");
    const manifest = new Manifest(path.join(repo, ".canvas", "m.json"));
    manifest.put("assignments/lab-00.md", new Entry({ kind: "assignment", canvasId: "55", title: "Lab 0" }));
    const [out, unresolved] = rewriteLinks('<a href="../assignments/lab-00.md">Lab 0</a>', source, repo, manifest, "42");
    expect(out).toContain('href="/courses/42/assignments/55"');
    expect(unresolved).toEqual([]);
  });

  it("reports an unknown target", () => {
    const repo = tmp();
    const source = write(repo, "modules/week-01.md", "x");
    const manifest = new Manifest(path.join(repo, ".canvas", "m.json"));
    const [, unresolved] = rewriteLinks('<a href="../nope.md">x</a>', source, repo, manifest, "42");
    expect(unresolved).toEqual(["../nope.md"]);
  });

  it("leaves absolute and anchor links alone", () => {
    const repo = tmp();
    const source = write(repo, "modules/w.md", "x");
    const manifest = new Manifest(path.join(repo, ".canvas", "m.json"));
    const html = '<a href="https://example.com">a</a><a href="#frag">b</a>';
    const [out, unresolved] = rewriteLinks(html, source, repo, manifest, "42");
    expect(out).toBe(html);
    expect(unresolved).toEqual([]);
  });
});

describe("comparison helpers", () => {
  it("collapses visible text, ignoring markup", () => {
    expect(visibleText("<p>Hello   <strong>world</strong></p>")).toBe("Hello world");
  });

  it("counts structure", () => {
    const counts = structureCounts("<h2>a</h2><table><tr><td>1</td></tr></table>");
    expect(counts.h2).toBe(1);
    expect(counts.table).toBe(1);
    expect(counts.td).toBe(1);
  });

  it("normalises style declarations", () => {
    expect(styleDeclarations('<p style="color: RED; padding: 2px">x</p>')).toEqual(["color:red", "padding:2px"]);
  });

  it("lists internal links", () => {
    const html = '<a href="/courses/42/pages/w1">a</a><a href="https://x.test">b</a>';
    expect(internalLinks(html, "42")).toEqual(["/courses/42/pages/w1"]);
  });
});

describe.skipIf(noCS331)("against CS331", () => {
  const quizzes = (): string[] => globRepo(CS331, "quizzes/*.md").map((k) => path.join(CS331, k));

  it("parses all quizzes", () => {
    let total = 0;
    for (const file of quizzes()) {
      const questions = parseQuiz(file);
      expect(questions.length, file).toBeGreaterThan(0);
      total += questions.length;
    }
    expect(total).toBe(85);
  });

  it("gives every question a correct answer and a rationale", () => {
    for (const file of quizzes()) {
      for (const question of parseQuiz(file)) {
        expect(question.correctLetters.length, `${file} Q${question.number}`).toBeGreaterThan(0);
        expect(question.rationale, `${file} Q${question.number}`).not.toBe("");
      }
    }
  });

  it("gives multiple choice questions exactly one answer", () => {
    for (const file of quizzes()) {
      for (const question of parseQuiz(file)) {
        if (question.kind === "multiple_choice_question") {
          expect(question.correctLetters.length, `${file} Q${question.number}`).toBe(1);
        }
      }
    }
  });

  it("sums every lab and discussion rubric to its points", () => {
    const keys = [...globRepo(CS331, "assignments/lab-*.md"), ...globRepo(CS331, "discussions/*.md")];
    for (const key of keys) {
      const text = readFileSync(path.join(CS331, key), "utf8");
      const criteria = parseRubric(text);
      expect(criteria.length, key).toBeGreaterThan(0);
      const header = /·\s*([\d.]+)\s+points/.exec(text);
      expect(header, key).not.toBeNull();
      expect(
        criteria.reduce((sum, c) => sum + c.points, 0),
        key,
      ).toBe(Number(header?.[1]));
    }
  });

  it("keeps the stylesheet entirely Canvas compatible", () => {
    const css = readFileSync(path.join(CS331, "canvas.css"), "utf8");
    for (const name of [
      "modules/week-07-symmetric-cryptography.md",
      "assignments/lab-04-symmetric-encryption.md",
      "discussions/d03-authentication-policy-critique.md",
    ]) {
      const [, html] = renderMarkdown(path.join(CS331, name));
      const [styled, dropped] = inlineCss(wrapTables(markTableRows(decorate(html))), css);
      expect(dropped, `${name}: Canvas would strip ${dropped}`).toEqual([]);
      expect(assertNoForbiddenTags(styled)).toEqual([]);
    }
  });

  it("never leaks the instructor note into a published page", () => {
    for (const file of quizzes()) {
      const [, html] = renderMarkdown(file);
      expect(html, file).not.toContain("Instructor note");
    }
  });
});

describe("stripVitepress", () => {
  // The same file is a VitePress page and a Canvas object, so the VitePress-only
  // syntax has to be resolved rather than passed through as literal text.
  const strip = (root: string, file: string): string => stripVitepress(readFileSync(file, "utf8"), file, root);

  it("removes the frontmatter", () => {
    const root = tmp();
    const source = write(root, "a.md", "---\nnext: false\nprev: false\n---\n\n# Title\n");
    expect(strip(root, source).trim()).toBe("# Title");
  });

  it("does not mistake a horizontal rule for frontmatter", () => {
    const root = tmp();
    const source = write(root, "a.md", "# Title\n\n---\n\nBody\n");
    expect(strip(root, source)).toContain("Body");
    expect(strip(root, source)).toContain("---");
  });

  it("inlines an include", () => {
    const root = tmp();
    write(root, "parts/boiler.md", "## Boilerplate\n\nShared text.\n");
    const source = write(root, "a.md", "# Title\n\n<!--@include: parts/boiler.md-->\n");
    const out = strip(root, source);
    expect(out).toContain("## Boilerplate");
    expect(out).not.toContain("@include");
  });

  it("resolves an include relative to the including file", () => {
    const root = tmp();
    write(root, "parts/boiler.md", "Shared.\n");
    const source = write(root, "deep/a.md", "<!--@include: ../parts/boiler.md-->\n");
    expect(strip(root, source)).toContain("Shared.");
  });

  it("treats a missing include as an error", () => {
    const root = tmp();
    const source = write(root, "a.md", "<!--@include: nope.md-->\n");
    expect(() => strip(root, source)).toThrow(PublishError);
    expect(() => strip(root, source)).toThrow(/does not exist/);
  });

  it("treats an include cycle as an error", () => {
    const root = tmp();
    write(root, "b.md", "<!--@include: a.md-->\n");
    const source = write(root, "a.md", "<!--@include: b.md-->\n");
    expect(() => strip(root, source)).toThrow(/nested more than/);
  });

  it("turns a container into a quoted callout", () => {
    const root = tmp();
    const source = write(root, "a.md", "::: danger\n\nDo not do this.\n\nEver.\n\n:::\n");
    const out = strip(root, source);
    expect(out).not.toContain(":::");
    // Every body line stays inside the blockquote, blank lines included, or the
    // quote would end at the first of them and the warning would escape it.
    expect(out).toContain("**Warning**");
    expect(out).toContain("<!--cs-callout:danger-->");
    expect(out).toContain("> Do not do this.");
    expect(out).toContain("> Ever.");
  });

  it("lets a container title override the default", () => {
    const root = tmp();
    const source = write(root, "a.md", "::: tip Read this first\n\nBody.\n\n:::\n");
    const out = strip(root, source);
    expect(out).toContain("**Read this first**");
    expect(out).toContain("<!--cs-callout:tip-->");
  });

  it("drops Vue components", () => {
    const root = tmp();
    const source = write(
      root,
      "a.md",
      '<script setup>\nimport x from "./x.json"\n</script>\n\n' +
        '# Title\n\n<OfficeHoursLink />\n\n<CourseSchedule :weeks="x.weeks" />\n',
    );
    const out = strip(root, source);
    expect(out).not.toContain("OfficeHoursLink");
    expect(out).not.toContain("CourseSchedule");
    expect(out).not.toContain("import x");
    expect(out).toContain("# Title");
  });

  it("leaves ordinary HTML alone, since only capitalised tags are Vue components", () => {
    const root = tmp();
    const source = write(root, "a.md", "<img src='x.png' alt='x'>\n\n<br>\n");
    const out = strip(root, source);
    expect(out).toContain("<img");
    expect(out).toContain("<br>");
  });
});

describe("question rendering", () => {
  // Question text reaches Canvas as HTML; unrendered markdown is what a student
  // would otherwise read, including the '**all**' that marks a multi-answer item.
  const TEXT =
    "# Q\n\n**Week 1 · 20 points · x**\n\n---\n\n" +
    "**Q1.** Select **all** that apply to `La/R`. *(Objective 1.2)*\n\n" +
    "- A. Uses `L/R` arithmetic\n- B. Plain option\n\n" +
    "*Answer:* **A** -- Because `L/R` is the formula.\n";
  const question = (): Question => parseQuiz(write(tmp(), "quiz-01.md", TEXT))[0] as Question;

  it("renders empty input as empty", () => {
    expect(renderInline("   ")).toBe("");
  });

  it("renders emphasis and code", () => {
    const out = renderInline("Select **all** for `x`");
    expect(out).toContain("<strong>all</strong>");
    expect(out).toContain("<code>x</code>");
  });

  it("renders the stem", () => {
    const fields = Object.fromEntries(questionFields(question(), 1));
    expect(fields["question[question_text]"]).toContain("<strong>all</strong>");
    expect(fields["question[question_text]"]).not.toContain("**");
  });

  it("sends the rationale to the html field, rendered", () => {
    const fields = Object.fromEntries(questionFields(question(), 1));
    expect(fields["question[neutral_comments_html]"]).toContain("<code>L/R</code>");
  });

  it("sends an answer with markdown as HTML", () => {
    const html = questionFields(question(), 1)
      .filter(([k]) => k.endsWith("[answer_html]"))
      .map(([, v]) => v);
    expect(html.length).toBe(1);
    expect(html[0]).toContain("<code>L/R</code>");
  });

  it("keeps a plain answer as plain text", () => {
    // Canvas empties answer_text whenever answer_html is set, so an answer that
    // needs no rendering should keep its plain form.
    const text = questionFields(question(), 1)
      .filter(([k]) => k.endsWith("[answer_text]"))
      .map(([, v]) => v);
    expect(text).toEqual(["Plain option"]);
  });
});

describe("callout classes", () => {
  // Every ::: container renders as a blockquote, so the severity has to survive
  // as a class or a "this fails your project" warning looks like an aside.
  const html = (markdown: string): string => {
    const root = tmp();
    return decorate(renderMarkdown(write(root, "a.md", markdown), root)[1]);
  };

  it("gives danger and tip different classes", () => {
    const out = html("# T\n\n::: danger\n\nLoud.\n\n:::\n\n::: tip\n\nQuiet.\n\n:::\n");
    expect(out).toContain('class="cs-callout cs-danger"');
    expect(out).toContain('class="cs-callout cs-tip"');
  });

  it("removes the marker", () => {
    const out = html("# T\n\n::: warning\n\nBody.\n\n:::\n");
    expect(out).not.toContain("cs-callout:");
    expect(out).not.toContain("&lt;!--");
  });

  it("keeps the body through the rewrite", () => {
    const out = html("# T\n\n::: danger\n\nDo not.\n\nEver.\n\n:::\n");
    expect(out).toContain("Do not.");
    expect(out).toContain("Ever.");
  });

  it("renders the title as bold, not literal markdown", () => {
    // The marker has to trail the title. A comment leading a line opens a
    // CommonMark HTML block, which emits the rest of the line as literal text,
    // so the reader sees '**Warning**' with the asterisks.
    const out = html("# T\n\n::: danger\n\nBody.\n\n:::\n");
    expect(out).toContain("<strong>Warning</strong>");
    expect(out).not.toContain("**");
  });

  it("leaves a plain blockquote alone", () => {
    const quote = "<blockquote><p>Just a quote.</p></blockquote>";
    expect(classifyCallouts(quote)).toBe(quote);
  });
});

describe("draft frontmatter", () => {
  // `draft: true` marks a file that is not a Canvas object at all.
  it("recognises a draft", () => {
    expect(isDraft("---\nnext: false\ndraft: true\n---\n\n# A1\n")).toBe(true);
  });

  it("does not treat frontmatter without the key as a draft", () => {
    expect(isDraft("---\nnext: false\nprev: false\n---\n\n# A1\n")).toBe(false);
  });

  it("does not treat a file with no frontmatter as a draft", () => {
    expect(isDraft("# A1\n\nSome text.\n")).toBe(false);
  });

  it("does not treat draft: false as a draft", () => {
    expect(isDraft("---\ndraft: false\n---\n\n# A1\n")).toBe(false);
  });

  it.each(["true", "True", "TRUE", "yes", "on"])("accepts %s as a spelling of true", (value) => {
    expect(isDraft(`---\ndraft: ${value}\n---\n\n# A1\n`)).toBe(true);
  });

  it("ignores the word draft in the body", () => {
    // Only the frontmatter block counts, or any page that discusses drafting
    // would disappear from the course.
    expect(isDraft("---\nnext: false\n---\n\n# A1\n\ndraft: true\n")).toBe(false);
  });

  it("requires the frontmatter to be at the top", () => {
    expect(isDraft("# A1\n\n---\ndraft: true\n---\n")).toBe(false);
  });

  it("reads the file in pathIsDraft", () => {
    expect(pathIsDraft(write(tmp(), "a1.md", "---\ndraft: true\n---\n\n# A1\n"))).toBe(true);
  });

  it("treats a missing file as not a draft", () => {
    expect(pathIsDraft(path.join(tmp(), "nope.md"))).toBe(false);
  });

  it("treats a binary file as not a draft", () => {
    // A PDF matched by layout.files has no front matter and is not a draft.
    const file = path.join(tmp(), "a1-worksheet.pdf");
    writeFileSync(file, Buffer.from([...Buffer.from("%PDF-1.4\n"), 0xd3, 0xf3, 0x0c, 0xe2, 0x0a]));
    expect(pathIsDraft(file)).toBe(false);
  });
});

describe("moduleKeys", () => {
  // moduleKeys() is the union of every [[module]]'s page and items.
  it("collects both page and items", () => {
    const modules = [
      { title: "Week 1", page: "week1.md", items: ["assignments/p0.md"] },
      { title: "Week 2", items: ["assignments/p1.md", "quizzes/q1.md"] },
    ];
    expect(moduleKeys(modules)).toEqual(new Set(["week1.md", "assignments/p0.md", "assignments/p1.md", "quizzes/q1.md"]));
  });

  it("takes nothing from a malformed table", () => {
    const modules = ["not a table", { title: "Week 3", items: "assignments/p2.md" }, { page: "" }];
    expect(moduleKeys(modules)).toEqual(new Set());
  });
});

describe("assignment options", () => {
  // submission: and grading: in the frontmatter set the two fields that vary.
  it("defaults when there is no frontmatter", () => {
    const options = assignmentOptions("# P0\n");
    expect(options.submissionTypes).toEqual(["online_text_entry"]);
    expect(options.gradingType).toBeNull();
  });

  it("parses a comma list and a YAML list", () => {
    expect(assignmentOptions("---\nsubmission: online_upload, online_text_entry\n---\n").submissionTypes).toEqual([
      "online_upload",
      "online_text_entry",
    ]);
    expect(assignmentOptions("---\nsubmission: [online_upload]\n---\n").submissionTypes).toEqual(["online_upload"]);
  });

  it("parses the grading type", () => {
    expect(assignmentOptions("---\ngrading: pass_fail\n---\n").gradingType).toBe("pass_fail");
  });

  it("reports a value Canvas would reject here", () => {
    expect(() => assignmentOptions("---\nsubmission: upload\n---\n")).toThrow(PublishError);
    expect(() => assignmentOptions("---\nsubmission: upload\n---\n")).toThrow(/submission type/);
    expect(() => assignmentOptions("---\ngrading: pass/fail\n---\n")).toThrow(/grading type/);
  });
});

describe("rewriting through symlinks", () => {
  it.skipIf(process.platform === "win32")("resolves a link to a symlinked file to its manifest key", () => {
    // The website serves worksheets from docs/public; the course dir holds
    // symlinks to them. The manifest keys the file by the symlink's path.
    const root = tmp();
    const repo = path.join(root, "docs", "cs425");
    mkdirSync(path.join(repo, "activities"), { recursive: true });
    const pub = path.join(root, "docs", "public", "cs425", "activities");
    mkdirSync(pub, { recursive: true });
    writeFileSync(path.join(pub, "a1-worksheet.pdf"), "%PDF");
    symlinkSync(path.join(pub, "a1-worksheet.pdf"), path.join(repo, "activities", "a1-worksheet.pdf"));
    const manifest = new Manifest(path.join(repo, ".canvas", "m.json"));
    manifest.entries.set(
      "activities/a1-worksheet.pdf",
      new Entry({ kind: "file", canvasId: "25109507", title: "a1-worksheet.pdf" }),
    );

    const [html, unresolved] = rewriteLinks(
      '<a href="./a1-worksheet.pdf">x</a>',
      path.join(repo, "activities", "a1.md"),
      repo,
      manifest,
      "48194",
    );
    expect(unresolved).toEqual([]);
    expect(html).toBe('<a href="/courses/48194/files/25109507">x</a>');
  });
});

describe("image links", () => {
  it("points an image at the preview", () => {
    // The bare file URL is an HTML page about the file; an <img> needs /preview.
    const root = tmp();
    write(root, "icons/task.svg", "<svg/>");
    const manifest = new Manifest(path.join(root, ".canvas", "m.json"));
    manifest.entries.set("icons/task.svg", new Entry({ kind: "file", canvasId: "9", title: "task.svg" }));
    const [html, unresolved] = rewriteLinks(
      '<img src="../icons/task.svg"><a href="../icons/task.svg">x</a>',
      path.join(root, "notes", "w.md"),
      root,
      manifest,
      "42",
    );
    expect(unresolved).toEqual([]);
    expect(html).toContain('<img src="/courses/42/files/9/preview">');
    expect(html).toContain('<a href="/courses/42/files/9">');
  });
});

describe("heading icons", () => {
  const ICONS: ReadonlyArray<readonly [string, string]> = [
    ["learning objectives", "icons/list.svg"],
    ["due by *", "icons/task.svg"],
  ];
  const add = (html: string, root: string, source = "notes/w.md"): string =>
    addHeadingIcons(html, ICONS, path.join(root, source), root);

  it("puts the icon first in a matching h2", () => {
    expect(add('<h2 id="lo">Learning Objectives</h2>', tmp())).toBe(
      '<h2 id="lo"><img class="cs-icon" src="../icons/list.svg" alt="" ' +
        'role="presentation" width="45" height="35">Learning Objectives</h2>',
    );
  });

  it("matches ignoring case and inline markup", () => {
    expect(add("<h3>Due by <em>Thursday</em> at 11:59 p.m.</h3>", tmp())).toContain('src="../icons/task.svg"');
  });

  it("writes the src relative to the source file", () => {
    expect(add("<h2>Learning Objectives</h2>", tmp(), "home.md")).toContain('src="icons/list.svg"');
  });

  it("leaves other headings untouched", () => {
    const html = "<h2>Readings</h2><h4>Due by Sunday</h4><p>Learning Objectives</p>";
    expect(add(html, tmp())).toBe(html);
  });

  it("does nothing with no icons", () => {
    const root = tmp();
    const html = "<h2>Learning Objectives</h2>";
    expect(addHeadingIcons(html, [], path.join(root, "w.md"), root)).toBe(html);
  });
});

describe("module entries", () => {
  it("lists the page then the items, with headers in place", () => {
    const entries = moduleEntries({
      page: "o.md",
      items: [{ header: "Due by Thursday" }, "a.md", { header: "Due by Sunday" }, "b.md"],
    });
    expect(entries).toEqual([
      { key: "o.md", header: "", native: null },
      { key: "", header: "Due by Thursday", native: null },
      { key: "a.md", header: "", native: null },
      { key: "", header: "Due by Sunday", native: null },
      { key: "b.md", header: "", native: null },
    ]);
  });

  it("treats a malformed item as an error", () => {
    expect(() => moduleEntries({ items: [{ heading: "x" }] })).toThrow(ValueError);
    expect(() => moduleEntries({ items: [{ heading: "x" }] })).toThrow(/item 1/);
  });

  it("skips headers in the module keys", () => {
    expect(moduleKeys([{ page: "o.md", items: [{ header: "H" }, "a.md"] }])).toEqual(new Set(["o.md", "a.md"]));
  });
});

describe("native items in place", () => {
  it("keeps a native table in items at its position", () => {
    const entries = moduleEntries({ items: ["a.md", { quiz: 7, title: "Survey" }, "b.md"] });
    expect(entries.map((e) => e.key || e.native)).toEqual([
      "a.md",
      { kind: "quiz", ident: "7", title: "Survey" },
      "b.md",
    ]);
  });

  it("treats a header with extra keys as an error", () => {
    expect(() => moduleEntries({ items: [{ header: "x", quiz: 1 }] })).toThrow(/header/);
  });
});

describe("syllabus links", () => {
  it("sends a syllabus link to the syllabus with its anchor", () => {
    // The course root is the home page; the syllabus has its own address.
    const root = tmp();
    mkdirSync(path.join(root, "exams"));
    write(root, "index.md", "# Syllabus\n");
    const manifest = new Manifest(path.join(root, ".canvas", "m.json"));
    manifest.entries.set("index.md", new Entry({ kind: "syllabus", canvasId: "42", title: "Syllabus" }));
    const [html, unresolved] = rewriteLinks(
      '<a href="../index.md#ai-policy">AI policy</a><a href="../index.md">syllabus</a>',
      path.join(root, "exams", "final.md"),
      root,
      manifest,
      "42",
    );
    expect(unresolved).toEqual([]);
    expect(html).toContain('href="/courses/42/assignments/syllabus#ai-policy"');
    expect(html).toContain('href="/courses/42/assignments/syllabus"');
  });
});
