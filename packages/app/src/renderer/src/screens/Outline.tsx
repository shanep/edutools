import { useEffect, useState } from "react";
import type { CourseOutline, OutlineItemRow, OutlineModuleRow } from "../../../shared/ipc";
import { formatDate, formatPoints } from "../../../shared/overview";
import { NoCourse } from "./NoCourse";
import { RepoBar, useCourseRepo } from "./RepoBar";
import { messageOf, plural, type ScreenProps } from "./types";

const KIND_LABELS: Readonly<Record<string, string>> = {
  page: "Page",
  assignment: "Assignment",
  discussion: "Discussion",
  quiz: "Quiz",
  file: "File",
  header: "Heading",
};

type OutlineRow =
  | { readonly kind: "module"; readonly key: string; readonly module: OutlineModuleRow }
  | { readonly kind: "item"; readonly key: string; readonly item: OutlineItemRow }
  | { readonly kind: "empty"; readonly key: string };

/**
 * The outline as table rows. Titles repeat and items have no ids, so each row is
 * keyed by its place; the outline is only ever rebuilt whole, never reordered.
 */
function rowsOf(outline: CourseOutline): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let n = 0;
  for (const module of outline.modules) {
    rows.push({ kind: "module", key: `row${n++}`, module });
    for (const item of module.items) {
      rows.push({ kind: "item", key: `row${n++}`, item });
    }
    if (module.items.length === 0) {
      rows.push({ kind: "empty", key: `row${n++}` });
    }
  }
  return rows;
}

export function Outline({ course, navigate, setStatus }: ScreenProps) {
  const repoState = useCourseRepo(course);
  const { repo } = repoState;
  const [outline, setOutline] = useState<CourseOutline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const courseId = course?.id ?? null;

  // A new repo object (chosen, or re-read by Refresh) means read the outline again.
  useEffect(() => {
    setOutline(null);
    if (!courseId || !repo || repo.problem) {
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    window.edutools
      .courseOutline(courseId)
      .then(
        (result) => {
          if (live) {
            setOutline(result);
            setStatus(`Outline: ${plural(result.modules.length, "module")}`);
          }
        },
        (err: unknown) => live && setError(messageOf(err)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [courseId, repo, setStatus]);

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const exportJson = async () => {
    try {
      const written = await window.edutools.exportOutline(course.id);
      if (written) {
        setStatus(`Wrote ${written}`);
      }
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const itemCount = outline?.modules.reduce((sum, m) => sum + m.items.length, 0) ?? 0;

  return (
    <div className="stack">
      <RepoBar state={repoState} onRefresh={() => void repoState.refresh()} />
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {outline && (
        <>
          <div className="toolbar">
            <button type="button" onClick={() => void exportJson()}>
              Export JSON...
            </button>
            <span className="spacer" />
            <span className="muted">
              {plural(outline.modules.length, "module")}, {plural(itemCount, "item")}. Computed from the repository
              alone; Canvas is not asked. Instructor-only modules are left out. Due dates are in your local time.
            </span>
          </div>
          <div className="table-frame outline-table">
            <table className="grid">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Title</th>
                  <th>Due</th>
                  <th className="num">Points</th>
                </tr>
              </thead>
              <tbody>
                {rowsOf(outline).map((row) =>
                  row.kind === "module" ? (
                    <tr key={row.key} className="module-row">
                      <td colSpan={4}>{row.module.title || "(untitled module)"}</td>
                    </tr>
                  ) : row.kind === "empty" ? (
                    <tr key={row.key}>
                      <td colSpan={4} className="empty">
                        No items.
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.key}>
                      <td>{KIND_LABELS[row.item.kind] ?? row.item.kind}</td>
                      <td className={row.item.kind === "header" ? "indented outline-heading" : "indented"}>
                        {row.item.title}
                      </td>
                      <td className="nowrap">{formatDate(row.item.dueAt)}</td>
                      <td className="num">{formatPoints(row.item.points)}</td>
                    </tr>
                  ),
                )}
                {outline.modules.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      canvas.toml declares no modules.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {loading && !outline && !error && <p className="muted">Reading the repository...</p>}
    </div>
  );
}
