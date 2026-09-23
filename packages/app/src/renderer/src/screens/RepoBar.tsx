import { useCallback, useEffect, useState } from "react";
import type { CurrentCourse, RepoInfo } from "../../../shared/ipc";
import { messageOf } from "./types";

export interface CourseRepo {
  readonly repo: RepoInfo | null;
  /** True once the remembered repository has been read, so "none" is an answer. */
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly choose: () => Promise<void>;
  readonly forget: () => Promise<void>;
}

/** The current course's repository: read on mount, chosen and forgotten on request. */
export function useCourseRepo(course: CurrentCourse | null): CourseRepo {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const courseId = course?.id ?? null;

  const refresh = useCallback(async () => {
    if (!courseId) {
      return;
    }
    setError(null);
    try {
      setRepo(await window.edutools.getCourseRepo(courseId));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoaded(true);
    }
  }, [courseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = useCallback(async () => {
    if (!courseId) {
      return;
    }
    setError(null);
    try {
      const picked = await window.edutools.chooseCourseRepo(courseId);
      if (picked) {
        setRepo(picked);
      }
    } catch (err) {
      setError(messageOf(err));
    }
  }, [courseId]);

  const forget = useCallback(async () => {
    if (!courseId) {
      return;
    }
    try {
      await window.edutools.forgetCourseRepo(courseId);
      setRepo(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [courseId]);

  return { repo, loaded, error, refresh, choose, forget };
}

/**
 * The course repository line every repository screen starts with. A folder the
 * designer picked that is not a repository is shown with its problem but not
 * remembered, so choosing again is the fix.
 */
export function RepoBar({ state, onRefresh }: { state: CourseRepo; onRefresh?: () => void }) {
  const { repo, error, choose, forget } = state;
  return (
    <fieldset className="group repo-bar">
      <legend>Course repository</legend>
      {repo ? (
        <p>
          <code>{repo.path}</code>
          {repo.weeks !== null && (
            <span className="muted">
              {" "}
              ({repo.weeks} weeks, times in {repo.timezone})
            </span>
          )}
        </p>
      ) : (
        <p className="muted">
          None chosen for this course. Choose the folder of markdown that holds its <code>canvas.toml</code>. edutools
          remembers it for this course.
        </p>
      )}
      {repo?.problem && (
        <p className="message error" role="alert">
          {repo.problem}
        </p>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="buttons">
        <button type="button" onClick={() => void choose()}>
          {repo ? "Choose Another..." : "Choose Folder..."}
        </button>
        {repo && onRefresh && (
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        )}
        {repo && (
          <button type="button" onClick={() => void forget()}>
            Forget
          </button>
        )}
      </div>
    </fieldset>
  );
}
