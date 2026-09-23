import { type FormEvent, useEffect, useState } from "react";
import type { CourseSchedule } from "../../../shared/ipc";
import { formatPoints } from "../../../shared/overview";
import { NoCourse } from "./NoCourse";
import { RepoBar, useCourseRepo } from "./RepoBar";
import { messageOf, plural, type ScreenProps } from "./types";

function signed(days: number): string {
  return days > 0 ? `+${days}` : String(days);
}

export function Dates({ course, navigate, setStatus }: ScreenProps) {
  const repoState = useCourseRepo(course);
  const { repo } = repoState;
  const [schedule, setSchedule] = useState<CourseSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shiftText, setShiftText] = useState("0");
  const [shift, setShift] = useState(0);
  const courseId = course?.id ?? null;

  useEffect(() => {
    setSchedule(null);
    if (!courseId || !repo || repo.problem) {
      return;
    }
    let live = true;
    setError(null);
    window.edutools.courseSchedule(courseId, shift).then(
      (result) => {
        if (live) {
          setSchedule(result);
          setStatus(
            result.problems.length === 0
              ? `Dates: ${plural(result.items.length, "item")}, no problems`
              : `Dates: ${plural(result.problems.length, "problem")}`,
          );
        }
      },
      (err: unknown) => live && setError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [courseId, repo, shift, setStatus]);

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const preview = (event: FormEvent) => {
    event.preventDefault();
    const days = Number(shiftText.trim());
    if (!Number.isInteger(days)) {
      setError("Shift by a whole number of days, such as 7 or -3.");
      return;
    }
    setShift(days);
  };

  return (
    <div className="stack">
      <RepoBar state={repoState} onRefresh={() => void repoState.refresh()} />
      {repo && !repo.problem && (
        <form className="toolbar" onSubmit={preview}>
          <label htmlFor="shift-days">Shift term by</label>
          <input
            id="shift-days"
            type="number"
            step={1}
            className="narrow-input"
            value={shiftText}
            onChange={(e) => setShiftText(e.target.value)}
          />
          <span>days</span>
          <button type="submit">Preview</button>
          <button
            type="button"
            disabled={shift === 0}
            onClick={() => {
              setShiftText("0");
              setShift(0);
            }}
          >
            Reset
          </button>
          <span className="spacer" />
          <span className="muted">Read only: nothing is written to the repository or to Canvas.</span>
        </form>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {schedule && (
        <>
          {schedule.shiftDays !== 0 && (
            <p className="message warn">
              Showing the term shifted by {signed(schedule.shiftDays)} days. This is a preview only.
            </p>
          )}
          <p>
            <strong>
              {schedule.weeks}-week schedule, {plural(schedule.items.length, "gradable item")}, {formatPoints(schedule.totalPoints)}{" "}
              points.
            </strong>{" "}
            <span className="muted">Times are in the course's time zone, {schedule.timezone}.</span>
          </p>
          <div className="table-frame dates-table">
            <table className="grid">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Type</th>
                  <th className="num">Wk</th>
                  <th className="num">Pts</th>
                  <th>Available from</th>
                  <th>Due</th>
                  <th>Until</th>
                </tr>
              </thead>
              <tbody>
                {schedule.items.map((item) => (
                  <tr key={item.path}>
                    <td title={item.path}>{item.title}</td>
                    <td>{item.kind}</td>
                    <td className="num">{item.week ?? "-"}</td>
                    <td className="num">{formatPoints(item.points)}</td>
                    <td className="nowrap mono">{item.unlockText}</td>
                    <td className="nowrap mono strong">{item.dueText}</td>
                    <td className="nowrap mono">{item.lockText}</td>
                  </tr>
                ))}
                {schedule.items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      No gradable items found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {schedule.problems.length === 0 ? (
            <p className="message ok">The dates are consistent with the term and the syllabus schedule.</p>
          ) : (
            <div className="dates-problems">
              <p className="message error">{plural(schedule.problems.length, "problem")}:</p>
              <ul className="path-list">
                {schedule.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
