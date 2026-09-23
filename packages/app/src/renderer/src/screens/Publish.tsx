import { useEffect, useState } from "react";
import type { PushRequest } from "../../../shared/ipc";
import { clearResult, errorFor, resultFor, runJob, useJobs } from "../jobStore";
import { DifferenceTable, ErrorLine, JobLog, PushResultView } from "./JobParts";
import { NoCourse } from "./NoCourse";
import { RepoBar, useCourseRepo } from "./RepoBar";
import { courseLabel, messageOf, plural, type ScreenProps } from "./types";

const GROUP_LABELS: Readonly<Record<string, string>> = {
  pages: "Pages",
  assignments: "Assignments",
  discussions: "Discussions",
  quizzes: "Quizzes",
  files: "Files",
  modules: "Modules",
  syllabus: "Syllabus",
  rubrics: "Rubrics",
  groups: "Assignment groups",
};

/** The same options key the store keeps with a preview, to tell whether it still applies. */
function optionsKey(request: PushRequest): string {
  return JSON.stringify([request.publish, request.updatePublished, [...request.only].sort(), [...request.paths].sort()]);
}

function splitPaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

export function Publish({ course, navigate, setStatus }: ScreenProps) {
  const repoState = useCourseRepo(course);
  const { repo } = repoState;
  const jobs = useJobs();
  const [groups, setGroups] = useState<readonly string[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [publish, setPublish] = useState(false);
  const [updatePublished, setUpdatePublished] = useState(false);
  const [verify, setVerify] = useState(true);
  const [pathText, setPathText] = useState("");
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    window.edutools.pushGroups().then((all) => {
      setGroups(all);
      setChosen(new Set(all));
    }, () => setGroups([]));
  }, []);

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const ready = repo !== null && repo.problem === null;
  const busy = jobs.running !== null;
  // Every group ticked is a whole-course push; --only is only sent to narrow it.
  const only = chosen.size === groups.length ? [] : groups.filter((g) => chosen.has(g));
  const request: PushRequest = {
    courseId: course.id,
    publish,
    updatePublished,
    only,
    paths: splitPaths(pathText),
    verify,
  };
  const key = optionsKey(request);
  const preview = resultFor(jobs, "preview", course.id);
  const previewCurrent = preview !== null && preview.options === key;
  const canPublish = ready && !busy && previewCurrent && preview.value.problems.length === 0 && chosen.size > 0;
  const push = resultFor(jobs, "push", course.id);
  const plan = resultFor(jobs, "cleanPlan", course.id);
  const clean = resultFor(jobs, "clean", course.id);

  const tickPublish = (on: boolean) => {
    if (
      on &&
      !window.confirm(
        "Make visible to students?\n\nWith this ticked, everything this push creates or changes is published: students can see it as soon as the push writes it. Leave it unticked to publish later, one item at a time.",
      )
    ) {
      return;
    }
    setPublish(on);
  };

  const tickUpdatePublished = (on: boolean) => {
    if (
      on &&
      !window.confirm(
        "Rewrite content students can already see?\n\nStudents may be part-way through reading or working on what this rewrites, and it changes under them. Without this, the push leaves every published page, assignment, quiz and module alone and lists them.",
      )
    ) {
      return;
    }
    setUpdatePublished(on);
  };

  const toggleGroup = (group: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(group);
      else next.delete(group);
      return next;
    });

  const runPreview = async () => {
    setNote(null);
    setStatus("Previewing: rendering the repository, writing nothing...");
    clearResult("push");
    const ok = await runJob("preview", course.id, key, () => window.edutools.previewPush(request));
    setStatus(ok ? "Preview finished" : "The preview could not run");
  };

  const runPush = async () => {
    const lines = [
      `Publish to ${courseLabel(course)} in Canvas now?`,
      "",
      publish ? "Everything it writes becomes visible to students." : "New objects stay unpublished; existing visibility is unchanged.",
      updatePublished
        ? "It also rewrites content students can already see."
        : "Content students can already see is left alone.",
    ];
    if (!window.confirm(lines.join("\n"))) {
      return;
    }
    setStatus("Publishing to Canvas...");
    const ok = await runJob("push", course.id, key, () => window.edutools.runPush(request));
    if (ok) {
      // The next push needs a fresh preview: what Canvas holds has just changed.
      clearResult("preview");
    }
    setStatus(ok ? "Published to Canvas" : "The push did not finish");
  };

  const previewHtml = async () => {
    try {
      const folder = await window.edutools.writePushPreview(course.id);
      if (folder) {
        setNote(`Wrote the preview pages to ${folder}.`);
      }
    } catch (err) {
      setNote(messageOf(err));
    }
  };

  const planCleanSync = async () => {
    setTyped("");
    clearResult("clean");
    setStatus("Reading the whole course to plan a clean sync...");
    const ok = await runJob("cleanPlan", course.id, "", () => window.edutools.planCleanSync(course.id));
    setStatus(ok ? "Clean sync planned; nothing has been deleted" : "The clean sync could not be planned");
  };

  const runCleanSync = async () => {
    if (!plan) return;
    const count = plan.value.targets.length;
    if (
      !window.confirm(
        `Delete ${plural(count, "object")} from ${courseLabel(course)} and then publish the whole repository?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setStatus("Clean sync: deleting, then publishing everything...");
    const ok = await runJob("clean", course.id, "", () =>
      window.edutools.runCleanSync({ courseId: course.id, confirmText: typed, publish }),
    );
    setTyped("");
    // A plan is used once, whatever happened: plan again to see the course as it is now.
    clearResult("cleanPlan");
    setStatus(ok ? "Clean sync finished" : "The clean sync stopped");
  };

  const planValue = plan?.value ?? null;
  const cleanBlocked = planValue !== null && planValue.refused.length > 0;
  const nothingToClean = planValue !== null && planValue.targets.length === 0 && planValue.stale.length === 0;

  return (
    <div className="stack">
      <RepoBar state={repoState} onRefresh={() => void repoState.refresh()} />

      {ready && (
        <>
          <fieldset className="group">
            <legend>Options</legend>
            <div className="option-list">
            <label className="check">
              <input type="checkbox" checked={publish} disabled={busy} onChange={(e) => tickPublish(e.target.checked)} />
              Publish: make what this push writes visible to students
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={updatePublished}
                disabled={busy}
                onChange={(e) => tickUpdatePublished(e.target.checked)}
              />
              Update published content: also rewrite what students can already see
            </label>
            <label className="check">
              <input type="checkbox" checked={verify} disabled={busy} onChange={(e) => setVerify(e.target.checked)} />
              Verify afterwards: read everything back from Canvas
            </label>
            </div>
            <p className="muted">
              By default a push leaves new objects unpublished and never rewrites content students can see.
            </p>
            <p>
              <strong>Parts to publish</strong>
            </p>
            <div className="kind-grid">
              {groups.map((g) => (
                <label key={g} className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(g)}
                    disabled={busy}
                    onChange={(e) => toggleGroup(g, e.target.checked)}
                  />
                  {GROUP_LABELS[g] ?? g}
                </label>
              ))}
            </div>
            <div className="form-row">
              <label htmlFor="push-paths">Only these files (optional):</label>
              <input
                id="push-paths"
                className="mono wide-input"
                value={pathText}
                disabled={busy}
                placeholder="assignments/p1.md, labs/*.md"
                onChange={(e) => setPathText(e.target.value)}
              />
            </div>
            <p className="muted">
              Naming files publishes just those corrections, with the same dates, links and styling; it skips rebuilding
              modules.
            </p>
          </fieldset>

          <div className="toolbar">
            <button
              type="button"
              className="preview-push default"
              disabled={busy || chosen.size === 0}
              onClick={() => void runPreview()}
            >
              1. Preview
            </button>
            <button type="button" className="run-push" disabled={!canPublish} onClick={() => void runPush()}>
              2. Publish to Canvas...
            </button>
            <button type="button" disabled={busy || !preview} onClick={() => void previewHtml()}>
              Preview HTML...
            </button>
            <span className="muted">
              {chosen.size === 0
                ? "Tick at least one part to publish."
                : previewCurrent
                  ? preview.value.problems.length > 0
                    ? "Fix the problems the preview found, then preview again."
                    : "Previewed with these options."
                  : "Preview first. It writes nothing and needs no Canvas connection."}
            </span>
          </div>
          {note && <p className="muted">{note}</p>}

          <JobLog jobs={jobs} keys={["preview", "push"]} courseId={course.id} />
          <ErrorLine message={errorFor(jobs, "preview", course.id)} />
          <ErrorLine message={errorFor(jobs, "push", course.id)} />

          {push && (
            <fieldset className="group push-summary">
              <legend>Publish result</legend>
              <PushResultView result={push.value} />
            </fieldset>
          )}
          {preview && (
            <fieldset className="group preview-summary">
              <legend>Preview result{previewCurrent ? "" : " (options changed since; preview again)"}</legend>
              <PushResultView result={preview.value} />
            </fieldset>
          )}

          <fieldset className="group clean-sync">
            <legend>Clean sync (start of term only)</legend>
            <div className="warning-box">
              <p>
                <strong>Only for a freshly copied course, before students use it. Never mid-term.</strong>
              </p>
              <p>
                A clean sync deletes every page, assignment, discussion, quiz and module in Canvas that this repository
                did not put there, then publishes the whole repository, rewriting published content too. It keeps course
                files, the front page, native items your modules name, and anything under [clean] keep. It refuses
                outright if anything it would delete holds student work.
              </p>
            </div>
            <div className="buttons">
              <button type="button" className="plan-clean" disabled={busy} onClick={() => void planCleanSync()}>
                Plan Clean Sync
              </button>
            </div>
            <JobLog jobs={jobs} keys={["cleanPlan", "clean"]} courseId={course.id} />
            <ErrorLine message={errorFor(jobs, "cleanPlan", course.id)} />
            <ErrorLine message={errorFor(jobs, "clean", course.id)} />

            {planValue && (
              <div className="clean-plan">
                {planValue.targets.length > 0 && (
                  <>
                    <p>
                      <strong>Would delete {plural(planValue.targets.length, "object")}:</strong>
                    </p>
                    <DifferenceTable rows={planValue.targets} />
                  </>
                )}
                {planValue.stale.length > 0 && (
                  <>
                    <p>
                      <strong>Would forget {plural(planValue.stale.length, "stale manifest entry", "stale manifest entries")}</strong>{" "}
                      (Canvas no longer has them):
                    </p>
                    <DifferenceTable rows={planValue.stale} />
                  </>
                )}
                <p className="muted">
                  Keeps {plural(planValue.kept, "item")} by name (native module items, [clean] keep, the front page), and every
                  course file.
                </p>
                {cleanBlocked ? (
                  <div className="message-block error clean-refused" role="alert">
                    <p>
                      <strong>This clean sync cannot run.</strong> Students have already used this course, so it is not a
                      fresh copy:
                    </p>
                    <ul className="path-list">
                      {planValue.refused.map((r) => (
                        <li key={`${r.target.kind}:${r.target.ident}`}>
                          {r.target.kind} "{r.target.title || r.target.ident}" {r.reason}
                        </li>
                      ))}
                    </ul>
                    <p>
                      Delete or keep those by hand (add them to [clean] keep in canvas.toml), then plan again. There is no
                      override.
                    </p>
                  </div>
                ) : nothingToClean ? (
                  <p className="message ok">Nothing to clean: Canvas holds only what the repository put there.</p>
                ) : (
                  <>
                  <p className="muted">
                    After deleting, it publishes the whole repository{" "}
                    {publish ? "and makes it visible to students (Publish is ticked above)." : "unpublished (Publish is not ticked above)."}
                  </p>
                  <div className="form-row clean-confirm">
                    <label htmlFor="clean-confirm">
                      Type <code>{planValue.confirmText}</code> to confirm:
                    </label>
                    <input
                      id="clean-confirm"
                      value={typed}
                      disabled={busy}
                      autoComplete="off"
                      onChange={(e) => setTyped(e.target.value)}
                    />
                    <button
                      type="button"
                      className="run-clean"
                      disabled={busy || typed.trim() !== planValue.confirmText}
                      onClick={() => void runCleanSync()}
                    >
                      Delete and Publish Everything...
                    </button>
                  </div>
                  </>
                )}
              </div>
            )}
            {clean && (
              <fieldset className="group">
                <legend>Clean sync result</legend>
                <PushResultView result={clean.value} />
              </fieldset>
            )}
          </fieldset>
        </>
      )}
    </div>
  );
}
