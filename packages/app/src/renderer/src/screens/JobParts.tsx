import { useEffect, useRef } from "react";
import type { DifferenceRow, PushSummary, VerifySummary } from "../../../shared/ipc";
import type { JobKey, JobState } from "../jobStore";
import { plural } from "./types";

/** The running job's log and progress line, shown while it runs and kept after. */
export function JobLog({ jobs, keys, courseId }: { jobs: JobState; keys: readonly JobKey[]; courseId: string }) {
  const end = useRef<HTMLLIElement>(null);
  const job = jobs.running ?? jobs.last;
  const mine = jobs.courseId === courseId && job !== null && keys.includes(job) && (jobs.running !== null || jobs.log.length > 0);
  const lines = jobs.courseId === courseId ? jobs.log.length : 0;
  useEffect(() => {
    if (lines > 0) {
      end.current?.scrollIntoView({ block: "nearest" });
    }
  }, [lines]);
  if (!mine) {
    return null;
  }
  return (
    <fieldset className="group">
      <legend>{jobs.running ? "Progress" : "Log"}</legend>
      <ul className="snapshot-log mono job-log" aria-live="polite">
        {jobs.log.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at the end, and lines repeat
          <li key={i} className={line.dim ? "muted" : undefined}>
            {line.text}
          </li>
        ))}
        <li ref={end} className="muted">
          {jobs.running ? (jobs.progress ?? "Working...") : "Done."}
        </li>
      </ul>
    </fieldset>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <p className="message error" role="alert">
      {message}
    </p>
  );
}

function PathList({ items, className }: { items: readonly string[]; className?: string }) {
  return (
    <ul className={`path-list mono ${className ?? ""}`}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function DifferenceTable({ rows, showSide = false }: { rows: readonly DifferenceRow[]; showSide?: boolean }) {
  return (
    <div className="table-frame short">
      <table className="grid">
        <thead>
          <tr>
            {showSide && <th>Side</th>}
            <th>Kind</th>
            <th>Title</th>
            <th>Id</th>
            <th>Repo key</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={`${d.side}:${d.kind}:${d.ident}:${d.key}`}>
              {showSide && <td>{d.side}</td>}
              <td>{d.kind}</td>
              <td>{d.title}</td>
              <td className="mono">{d.ident}</td>
              <td className="mono">{d.key}</td>
              <td>{d.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VerifyResultView({ result }: { result: VerifySummary }) {
  return (
    <div className="verify-result">
      {result.drafts.length > 0 && (
        <p className="muted">Drafts, not verified: {result.drafts.join(", ")}</p>
      )}
      {result.failures.length === 0 ? (
        <p className="message ok">All {plural(result.checked, "object")} verified against Canvas: each is there and intact.</p>
      ) : (
        <>
          <p className="message error">
            {plural(result.failures.length, "failure")} across {plural(result.checked, "object")} checked. Canvas answered
            every write, but this is what it actually holds.
          </p>
          <div className="table-frame short">
            <table className="grid verify-failures">
              <thead>
                <tr>
                  <th>Object</th>
                  <th>Check</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {result.failures.map((f) => (
                  <tr key={`${f.key}\u0000${f.check}\u0000${f.detail}`}>
                    <td className="mono">{f.key}</td>
                    <td>{f.check}</td>
                    <td>{f.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Everything a push (or its dry run, or a clean sync) came back with, as the CLI reports it. */
export function PushResultView({ result }: { result: PushSummary }) {
  const failed = result.problems.length > 0;
  return (
    <div className="push-result">
      {result.clean && (
        <>
          <p className="message ok">
            Clean sync: deleted {plural(result.clean.deleted.length, "object")}, forgot{" "}
            {plural(result.clean.forgotten.length, "stale manifest entry", "stale manifest entries")}.
          </p>
          {result.clean.deleted.length > 0 && <DifferenceTable rows={result.clean.deleted} />}
        </>
      )}
      <table className="grid compact push-counts">
        <thead>
          <tr>
            <th>{result.dryRun ? "Would be" : "Outcome"}</th>
            <th className="num">Count</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{result.dryRun ? "Rendered (nothing written)" : "Created"}</td>
            <td className="num">{result.dryRun ? result.skipped : result.created}</td>
          </tr>
          {!result.dryRun && (
            <>
              <tr>
                <td>Updated</td>
                <td className="num">{result.updated}</td>
              </tr>
              <tr>
                <td>Skipped</td>
                <td className="num">{result.skipped}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      <p className="muted">
        Covers {plural(result.selected.length, "file")} from the repository.
        {result.dryRun
          ? " A preview asks Canvas nothing, so it cannot yet say which objects exist or are published; the push decides that."
          : ""}
      </p>

      {failed ? (
        <div className="push-problems">
          <p className="message error">
            {plural(result.problems.length, "problem")}
            {result.dryRun ? ". Fix these in the repository before publishing." : "."}
          </p>
          <PathList items={result.problems} />
        </div>
      ) : result.dryRun ? (
        <p className="message ok">Preview finished: nothing was written to Canvas, and nothing stands in the way of publishing.</p>
      ) : (
        <p className="message ok">
          Published to Canvas.{" "}
          {result.publish
            ? "Objects it wrote are visible to students."
            : "New objects are unpublished; existing visibility is unchanged."}
        </p>
      )}

      {result.protected.length > 0 && (
        <div className="message-block warn">
          <p>
            {plural(result.protected.length, "published object")} left untouched, because students can already see them.
            "Update published content" would rewrite them:
          </p>
          <PathList items={result.protected} />
        </div>
      )}
      {result.drafts.length > 0 && <p className="muted">Drafts, not published: {result.drafts.join(", ")}</p>}
      {result.orphanedDrafts.length > 0 && (
        <div className="message-block warn">
          <p>
            These files became drafts after being published. Their Canvas objects are no longer tracked; delete them in
            Canvas by hand if they still exist:
          </p>
          <PathList items={result.orphanedDrafts} />
        </div>
      )}
      {result.unlisted.length > 0 && (
        <div className="message-block warn">
          <p>
            {plural(result.unlisted.length, "gradable item")} in no module. Students find their work through modules:
          </p>
          <PathList items={result.unlisted} />
        </div>
      )}
      {result.unresolved.length > 0 && (
        <div className="message-block error">
          <p>Links that could not be pointed at a Canvas object:</p>
          <PathList items={result.unresolved.map((u) => `${u.key}: ${u.link}`)} />
        </div>
      )}
      {result.droppedCss.length > 0 && (
        <p className="message warn">
          canvas.css uses properties Canvas will not store, which it would drop silently: {result.droppedCss.join(", ")}
        </p>
      )}
      {result.verify && (
        <fieldset className="group">
          <legend>Verify afterwards</legend>
          <VerifyResultView result={result.verify} />
        </fieldset>
      )}
    </div>
  );
}
