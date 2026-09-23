import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A small course repository: one module with a page and a lab, one
 * instructor-only module the outline must leave out, and a stylesheet so
 * rendering goes through the native CSS inliner.
 */
export function writeSampleRepo(root: string): string {
  const files: Record<string, string> = {
    "canvas.toml": [
      "[term]",
      'timezone = "America/Boise"',
      "first_monday = 2026-08-24",
      "weeks = 15",
      "last_day_of_instruction = 2026-12-11",
      "finals_start = 2026-12-14",
      "finals_end = 2026-12-18",
      "total_points = 30",
      "",
      "[term.policy.lab]",
      'unlock = "mon 00:00"',
      'due = "sun 23:59"',
      "grace_days = 2",
      "",
      "[[module]]",
      'title = "Getting started"',
      "week = 1",
      'page = "modules/week-01.md"',
      'items = ["assignments/lab-01.md"]',
      "",
      "[[module]]",
      'title = "Instructor notes"',
      "never_publish = true",
      'page = "modules/instructor.md"',
      "",
    ].join("\n"),
    "modules/week-01.md": "# Week 1 overview\n\nWelcome to the course.\n",
    "modules/instructor.md": "# Instructor notes\n",
    "assignments/lab-01.md": "# Lab 1: Hello\n\n**Week 1 · 30 points**\n\nSay hello.\n",
    "canvas.css": "p { color: #333333; }\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text, "utf8");
  }
  return root;
}
