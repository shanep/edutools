import { errorFor, resultFor, runJob, useJobs } from "../jobStore";
import { ErrorLine, JobLog, VerifyResultView } from "./JobParts";
import { NoCourse } from "./NoCourse";
import { RepoBar, useCourseRepo } from "./RepoBar";
import type { ScreenProps } from "./types";

export function Verify({ course, navigate, setStatus }: ScreenProps) {
  const repoState = useCourseRepo(course);
  const jobs = useJobs();

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const ready = repoState.repo !== null && repoState.repo.problem === null;
  const result = resultFor(jobs, "verify", course.id);

  const run = async () => {
    setStatus("Verifying: reading every published object back from Canvas...");
    const ok = await runJob("verify", course.id, "", () => window.edutools.verifyCourse(course.id));
    setStatus(ok ? "Verify finished" : "Verify could not run");
  };

  return (
    <div className="stack">
      <RepoBar state={repoState} onRefresh={() => void repoState.refresh()} />
      {ready && (
        <>
          <p className="verify-about">
            Canvas answers every write with "OK", even when its sanitiser has quietly stripped part of a page. Verify reads
            each object this repository published back from Canvas and checks it arrived intact: the body, its links,
            quiz questions, files, module membership and the gradebook total. It only reads; nothing is changed.
          </p>
          <div className="toolbar">
            <button type="button" className="run-verify default" disabled={jobs.running !== null} onClick={() => void run()}>
              Verify Now
            </button>
          </div>
          <JobLog jobs={jobs} keys={["verify"]} courseId={course.id} />
          <ErrorLine message={errorFor(jobs, "verify", course.id)} />
          {result && (
            <fieldset className="group">
              <legend>Result</legend>
              <VerifyResultView result={result.value} />
            </fieldset>
          )}
        </>
      )}
    </div>
  );
}
