import { useEffect, useRef, useState } from "react";
import type { SnapshotSummary } from "../../../shared/ipc";
import { startSnapshot, useSnapshotState } from "../snapshotStore";
import { NoCourse } from "./NoCourse";
import { courseLabel, messageOf, type ScreenProps } from "./types";

/** Plain names for the kinds a pull knows; an unknown kind shows as itself. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  syllabus: "Syllabus",
  pages: "Pages",
  assignments: "Assignments",
  discussions: "Discussions",
  announcements: "Announcements",
  quizzes: "Quizzes",
  modules: "Modules",
  groups: "Assignment groups",
  rubrics: "Rubrics",
  files: "Files",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function revealLabel(platform: string): string {
  if (platform === "darwin") {
    return "Show in Finder";
  }
  if (platform === "win32") {
    return "Show in Explorer";
  }
  return "Show Folder";
}

function About() {
  return (
    <fieldset className="group snapshot-about">
      <legend>About snapshots</legend>
      <p>
        A snapshot is a lossless copy of the course exactly as Canvas stores it: each page, assignment, discussion and
        quiz as Canvas's own data with its HTML, the modules, groups and rubrics, and every course file. Use it as a
        backup, or to compare the course between two dates.
      </p>
      <p>
        It is not a course repository: nothing is converted to markdown, and Publish cannot push it back. It holds no
        student work: no submissions, grades or enrollments.
      </p>
      <p>
        <strong>Keep the folder private.</strong> <code>files.json</code> holds each file's download link, and those
        links can work without signing in to Canvas.
      </p>
      <p className="muted">
        Snapshotting into the same folder again updates it: files already current are not downloaded again, and what
        was deleted in Canvas is removed. Nothing else in the folder is touched.
      </p>
    </fieldset>
  );
}

function Summary({ summary, platform, setStatus }: { summary: SnapshotSummary; platform: string; setStatus: (t: string) => void }) {
  const reveal = () => {
    window.edutools.showFolder(summary.folder).catch((err: unknown) => setStatus(messageOf(err)));
  };
  return (
    <fieldset className="group snapshot-summary">
      <legend>Result</legend>
      {summary.problems.length === 0 ? (
        <p className="message ok">Snapshot finished with no problems.</p>
      ) : (
        <p className="message warn">
          Snapshot finished, with {summary.problems.length} {summary.problems.length === 1 ? "problem" : "problems"}{" "}
          listed below. For anything that could not be fetched, the folder keeps the copy from the last snapshot.
        </p>
      )}
      <p>
        <strong>{summary.courseName || `Course ${summary.courseId}`}</strong> in <code>{summary.folder}</code>
      </p>
      <div className="summary-columns">
        <table className="grid compact">
          <thead>
            <tr>
              <th>Kind</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {summary.counts.map((c) => (
              <tr key={c.kind}>
                <td>{kindLabel(c.kind)}</td>
                <td className="num">{c.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <p>Files downloaded: {summary.downloaded}</p>
          <p>Files already current: {summary.unchanged}</p>
          <p>Removed, because Canvas no longer has them: {summary.removed.length}</p>
        </div>
      </div>
      {summary.removed.length > 0 && (
        <details>
          <summary>Removed paths</summary>
          <ul className="path-list mono">
            {summary.removed.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      {summary.problems.length > 0 && (
        <div className="snapshot-problems">
          <p>
            <strong>Problems</strong>
          </p>
          <ul className="path-list">
            {summary.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="buttons">
        <button type="button" onClick={reveal}>
          {revealLabel(platform)}
        </button>
      </div>
    </fieldset>
  );
}

export function Snapshot({ course, navigate, setStatus }: ScreenProps) {
  const run = useSnapshotState();
  const [folder, setFolder] = useState("");
  const [defaultFolder, setDefaultFolder] = useState("");
  const [allKinds, setAllKinds] = useState<readonly string[]>([]);
  const [kinds, setKinds] = useState<ReadonlySet<string>>(new Set());
  const [platform, setPlatform] = useState("");
  const [error, setError] = useState<string | null>(null);
  const logEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    window.edutools.appInfo().then(
      (info) => setPlatform(info.platform),
      () => setPlatform(""),
    );
  }, []);

  const courseId = course?.id;
  const courseName = course?.name ?? "";
  const courseCode = course?.code ?? "";
  useEffect(() => {
    if (!courseId) {
      return;
    }
    let live = true;
    window.edutools.snapshotDefaults({ id: courseId, name: courseName, code: courseCode }).then(
      (defaults) => {
        if (live) {
          setDefaultFolder(defaults.folder);
          setFolder(defaults.folder);
          setAllKinds(defaults.kinds);
          setKinds(new Set(defaults.kinds));
        }
      },
      (err: unknown) => live && setError(messageOf(err)),
    );
    return () => {
      live = false;
    };
  }, [courseId, courseName, courseCode]);

  const logLength = run.log.length;
  useEffect(() => {
    if (logLength > 0) {
      logEnd.current?.scrollIntoView({ block: "nearest" });
    }
  }, [logLength]);

  // The run lives in the store, so this screen can be left and come back to.
  useEffect(() => {
    if (!run.running && run.summary) {
      const n = run.summary.problems.length;
      setStatus(n === 0 ? "Snapshot finished" : `Snapshot finished with ${n} ${n === 1 ? "problem" : "problems"}`);
    } else if (!run.running && run.error) {
      setStatus("The snapshot could not run");
    }
  }, [run.running, run.summary, run.error, setStatus]);

  if (!course) {
    return (
      <div className="stack">
        <NoCourse navigate={navigate} />
        <About />
      </div>
    );
  }

  const choose = async () => {
    setError(null);
    try {
      const picked = await window.edutools.chooseFolder(folder || defaultFolder);
      if (picked) {
        setFolder(picked);
      }
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const toggle = (kind: string, on: boolean) => {
    setKinds((current) => {
      const next = new Set(current);
      if (on) {
        next.add(kind);
      } else {
        next.delete(kind);
      }
      return next;
    });
  };

  const start = async () => {
    setError(null);
    setStatus(`Snapshotting ${courseLabel(course)}...`);
    await startSnapshot({ courseId: course.id, folder, kinds: allKinds.filter((k) => kinds.has(k)) });
  };

  const otherCourse = run.courseId !== null && run.courseId !== course.id;
  const showRun = !otherCourse && (run.running || run.log.length > 0 || run.error !== null);

  return (
    <div className="stack">
      <p>
        <strong>{courseLabel(course)}</strong> <span className="muted">(course {course.id})</span>
      </p>

      <fieldset className="group">
        <legend>Destination folder</legend>
        <div className="form-row folder-row">
          <input type="text" readOnly value={folder} aria-label="Destination folder" className="mono" />
          <button type="button" onClick={() => void choose()} disabled={run.running}>
            Choose...
          </button>
          <button type="button" onClick={() => setFolder(defaultFolder)} disabled={run.running || folder === defaultFolder}>
            Use Default
          </button>
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>What to include</legend>
        <div className="kind-grid">
          {allKinds.map((kind) => (
            <label key={kind} className="check">
              <input
                type="checkbox"
                checked={kinds.has(kind)}
                disabled={run.running}
                onChange={(e) => toggle(kind, e.target.checked)}
              />
              {kindLabel(kind)}
            </label>
          ))}
        </div>
        <div className="buttons">
          <button type="button" disabled={run.running} onClick={() => setKinds(new Set(allKinds))}>
            Select All
          </button>
          <button type="button" disabled={run.running} onClick={() => setKinds(new Set())}>
            Select None
          </button>
        </div>
        <p className="muted">The course's own settings (course.json) are always included.</p>
      </fieldset>

      <div className="toolbar">
        <button
          type="button"
          className="start-snapshot default"
          disabled={run.running || kinds.size === 0 || !folder}
          onClick={() => void start()}
        >
          {run.running ? "Snapshot Running..." : "Start Snapshot"}
        </button>
        {kinds.size === 0 && <span className="muted">Choose at least one kind of content.</span>}
        {otherCourse && run.running && (
          <span className="muted">A snapshot of another course is running. Wait for it to finish.</span>
        )}
      </div>

      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}

      {showRun && (
        <fieldset className="group">
          <legend>Progress</legend>
          <ul className="snapshot-log mono" aria-live="polite">
            {run.log.map((line, i) => (
              // Lines repeat ("Reading pages" on a second run), so position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: the log only ever grows at the end
              <li key={i}>{line}</li>
            ))}
            <li ref={logEnd} className="muted">
              {run.running ? "Working..." : run.error ? "Stopped." : "Done."}
            </li>
          </ul>
          {run.error && (
            <p className="message error" role="alert">
              {run.error}
            </p>
          )}
        </fieldset>
      )}

      {!run.running && run.summary && run.summary.courseId === course.id && (
        <Summary summary={run.summary} platform={platform} setStatus={setStatus} />
      )}

      <About />
    </div>
  );
}
