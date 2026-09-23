import type { DifferenceRow } from "../../../shared/ipc";
import { errorFor, resultFor, runJob, useJobs } from "../jobStore";
import { DifferenceTable, ErrorLine, JobLog } from "./JobParts";
import { NoCourse } from "./NoCourse";
import { RepoBar, useCourseRepo } from "./RepoBar";
import { plural, type ScreenProps } from "./types";

/** Each side of the comparison, in the README's words. */
const SIDES: readonly { side: DifferenceRow["side"]; title: string; explain: string; className: string }[] = [
  {
    side: "stale",
    title: "Stale: tracked, but gone from Canvas",
    explain:
      "The manifest still tracks these, but Canvas no longer has them, usually because they were deleted in Canvas. " +
      "If that was a mistake, publish again: the push creates them afresh. If it was deliberate, delete the file from " +
      "the repository (or mark it as a draft) and remove its entry from .canvas/manifest-<course id>.json.",
    className: "message error",
  },
  {
    side: "untracked",
    title: "Untracked: in Canvas, not from the repository",
    explain:
      "Normal, and only reported: a hand-built exam quiz or a file uploaded in Canvas. An item sitting in a module the " +
      "repository manages is dropped when the next push rebuilds that module.",
    className: "muted",
  },
  {
    side: "pending",
    title: "Pending: declared, not in Canvas yet",
    explain: "Modules canvas.toml declares that Canvas does not have yet. The next push creates them.",
    className: "muted",
  },
];

export function Audit({ course, navigate, setStatus }: ScreenProps) {
  const repoState = useCourseRepo(course);
  const jobs = useJobs();

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const ready = repoState.repo !== null && repoState.repo.problem === null;
  const result = resultFor(jobs, "audit", course.id);

  const run = async () => {
    setStatus("Auditing: reading the whole course...");
    const ok = await runJob("audit", course.id, "", () => window.edutools.auditCourse(course.id));
    setStatus(ok ? "Audit finished" : "Audit could not run");
  };

  const differences = result?.value.differences ?? [];
  const stale = differences.filter((d) => d.side === "stale").length;

  return (
    <div className="stack">
      <RepoBar state={repoState} onRefresh={() => void repoState.refresh()} />
      {ready && (
        <>
          <p className="audit-about">
            Verify checks that what the repository published is still there and intact. Audit asks the other way round
            too: what does Canvas hold that the repository did not put there, and what does the repository still track
            that Canvas no longer has. It only reads; nothing is changed.
          </p>
          <div className="toolbar">
            <button type="button" className="run-audit default" disabled={jobs.running !== null} onClick={() => void run()}>
              Run Audit
            </button>
          </div>
          <JobLog jobs={jobs} keys={["audit"]} courseId={course.id} />
          <ErrorLine message={errorFor(jobs, "audit", course.id)} />
          {result && (
            <fieldset className="group audit-result">
              <legend>Result</legend>
              {differences.length === 0 ? (
                <p className="message ok">
                  The repository and the course agree: {plural(result.value.tracked, "tracked object")}, nothing untracked.
                </p>
              ) : (
                <p className={stale > 0 ? "message error" : "message ok"}>
                  {plural(differences.length, "difference")} across {plural(result.value.tracked, "tracked object")}.
                  {stale > 0
                    ? ` ${plural(stale, "stale entry", "stale entries")}: publish again to recreate them, or remove them if the deletion was deliberate.`
                    : " None of them is a problem."}
                </p>
              )}
              {SIDES.map(({ side, title, explain, className }) => {
                const rows = differences.filter((d) => d.side === side);
                if (rows.length === 0) {
                  return null;
                }
                return (
                  <div key={side} className={`audit-side audit-${side}`}>
                    <p>
                      <strong>
                        {title} ({rows.length})
                      </strong>
                    </p>
                    <p className={className}>{explain}</p>
                    <DifferenceTable rows={rows} />
                  </div>
                );
              })}
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
