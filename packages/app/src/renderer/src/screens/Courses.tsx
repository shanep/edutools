import { useCallback, useEffect, useMemo, useState } from "react";
import { filterCourses, type SortKey, sortCourses } from "../../../shared/courses";
import type { CourseList } from "../../../shared/ipc";
import { messageOf, type ScreenProps } from "./types";

const COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "code", label: "Code" },
  { key: "id", label: "ID" },
  { key: "term", label: "Term" },
];

export function Courses({ setStatus, navigate }: ScreenProps) {
  const [includeAll, setIncludeAll] = useState(false);
  const [list, setList] = useState<CourseList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "name", descending: false });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus("Fetching courses from Canvas...");
    try {
      const result = await window.edutools.listCourses({ includeAll });
      setList(result);
      setStatus(`${result.courses.length} ${includeAll ? "" : "active "}courses from ${result.endpoint}`);
    } catch (err) {
      setList(null);
      setError(messageOf(err));
      setStatus("Could not fetch courses");
    } finally {
      setLoading(false);
    }
  }, [includeAll, setStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () => sortCourses(filterCourses(list?.courses ?? [], filter), sort.key, sort.descending),
    [list, filter, sort],
  );

  const sortBy = (key: SortKey) =>
    setSort((current) => ({ key, descending: current.key === key ? !current.descending : false }));

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        <label className="check">
          <input type="checkbox" checked={includeAll} onChange={(e) => setIncludeAll(e.target.checked)} />
          Show concluded courses
        </label>
        <span className="spacer" />
        <label>
          Filter:{" "}
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, code or term" />
        </label>
      </div>

      {error && (
        <div className="message error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => navigate("settings")}>
            Open Settings
          </button>
        </div>
      )}

      {list && (
        <p className="muted">
          Site: {list.site ?? "(environment)"} ({list.endpoint})
        </p>
      )}

      <div className="table-frame">
        <table className="grid">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.key === "id" ? "num" : undefined}
                  aria-sort={sort.key === c.key ? (sort.descending ? "descending" : "ascending") : "none"}
                >
                  <button type="button" className="th-button" onClick={() => sortBy(c.key)}>
                    {c.label}
                    {sort.key === c.key ? (sort.descending ? " ▾" : " ▴") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>{row.code}</td>
                <td className="num">{row.id}</td>
                <td>{row.term}</td>
              </tr>
            ))}
            {!loading && list && rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  No courses found.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  Loading...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {rows.length} of {list?.courses.length ?? 0} shown
      </p>
    </div>
  );
}
