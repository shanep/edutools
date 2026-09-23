import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  EDIT_KINDS,
  type EditKind,
  type ObjectChanges,
  type ObjectDetail,
  type ObjectSummary,
  type RenderedBody,
} from "../../../shared/ipc";
import { DELETE_TAKES_GRADES, isoToLocalInput, KIND_FIELDS, localInputToIso } from "../../../shared/objects";
import { NoCourse } from "./NoCourse";
import { Row } from "./Row";
import { messageOf, type ScreenProps } from "./types";

type Outcome = { readonly kind: "ok" | "error" | "info"; readonly text: string } | null;

type DateField = "unlockAt" | "dueAt" | "lockAt";

const DATE_FIELDS: readonly { key: DateField; label: string }[] = [
  { key: "unlockAt", label: "Available from" },
  { key: "dueAt", label: "Due" },
  { key: "lockAt", label: "Until" },
];

interface Form {
  title: string;
  bodySource: "html" | "markdown";
  html: string;
  markdownFile: string;
  points: string;
  unlockAt: string;
  dueAt: string;
  lockAt: string;
}

const EMPTY_FORM: Form = {
  title: "",
  bodySource: "html",
  html: "",
  markdownFile: "",
  points: "",
  unlockAt: "",
  dueAt: "",
  lockAt: "",
};

function formOf(detail: ObjectDetail): Form {
  return {
    title: detail.title,
    bodySource: "html",
    html: detail.body ?? "",
    markdownFile: "",
    points: detail.points === null ? "" : String(detail.points),
    unlockAt: isoToLocalInput(detail.unlockAt),
    dueAt: isoToLocalInput(detail.dueAt),
    lockAt: isoToLocalInput(detail.lockAt),
  };
}

/**
 * Only what differs from what Canvas has, so a save never clears a field the
 * designer did not touch. Throws a message the form can show.
 */
function changesOf(kind: EditKind, form: Form, original: Form | null): ObjectChanges {
  const fields = KIND_FIELDS[kind];
  const base = original ?? EMPTY_FORM;
  const changes: { -readonly [K in keyof ObjectChanges]: ObjectChanges[K] } = {};
  if (form.title.trim() !== base.title.trim()) {
    changes.title = form.title.trim();
  }
  if (fields.body) {
    if (form.bodySource === "markdown") {
      if (form.markdownFile) {
        changes.body = { kind: "markdown", file: form.markdownFile };
      }
    } else if (form.html !== base.html) {
      changes.body = { kind: "html", html: form.html };
    }
  }
  if (fields.points && form.points.trim() !== base.points.trim()) {
    const points = Number(form.points.trim());
    if (form.points.trim() === "" || !Number.isFinite(points) || points < 0) {
      throw new Error("Points must be a number, zero or more.");
    }
    changes.points = points;
  }
  if (fields.dates) {
    for (const { key, label } of DATE_FIELDS) {
      if (form[key] !== base[key]) {
        const iso = localInputToIso(form[key]);
        if (iso === null) {
          throw new Error(`The ${label} date is not a date and time.`);
        }
        changes[key] = iso;
      }
    }
  }
  return changes;
}

export function EditObject({ course, navigate, setStatus }: ScreenProps) {
  const [kind, setKind] = useState<EditKind>("page");
  const [list, setList] = useState<ObjectSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [preview, setPreview] = useState<RenderedBody | null>(null);
  const [changeVisible, setChangeVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const courseId = course?.id ?? null;
  const fields = KIND_FIELDS[kind];

  const loadList = useCallback(async () => {
    if (!courseId) {
      return;
    }
    setListError(null);
    setList(null);
    try {
      setList(await window.edutools.listObjects(courseId, kind));
    } catch (err) {
      setListError(messageOf(err));
    }
  }, [courseId, kind]);

  useEffect(() => {
    setSelected(null);
    setCreating(false);
    setDetail(null);
    void loadList();
  }, [loadList]);

  const show = (d: ObjectDetail) => {
    setDetail(d);
    setSelected(d.id);
    setForm(formOf(d));
    setPreview(null);
    setChangeVisible(false);
  };

  const open = async (id: string) => {
    if (!courseId) {
      return;
    }
    setSelected(id);
    setCreating(false);
    setOutcome(null);
    try {
      show(await window.edutools.getObjectDetail({ courseId, kind, id }));
    } catch (err) {
      setDetail(null);
      setOutcome({ kind: "error", text: messageOf(err) });
    }
  };

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const startNew = () => {
    setSelected(null);
    setDetail(null);
    setCreating(true);
    setForm(EMPTY_FORM);
    setPreview(null);
    setOutcome(null);
  };

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Run one Canvas action with the buttons disabled. */
  const act = async (working: string, action: () => Promise<string>) => {
    setBusy(true);
    setOutcome({ kind: "info", text: working });
    try {
      const text = await action();
      setOutcome({ kind: "ok", text });
      setStatus(text);
    } catch (err) {
      setOutcome({ kind: "error", text: messageOf(err) });
      setStatus("Edit object: the last action failed");
    } finally {
      setBusy(false);
    }
  };

  const chooseMarkdown = async () => {
    try {
      const file = await window.edutools.chooseMarkdownFile(course.id);
      if (!file) {
        return;
      }
      set("markdownFile", file);
      const rendered = await window.edutools.renderMarkdownBody(course.id, file);
      setPreview(rendered);
      if (!form.title.trim() && rendered.title) {
        set("title", rendered.title);
      }
      setOutcome(null);
    } catch (err) {
      setPreview(null);
      setOutcome({ kind: "error", text: messageOf(err) });
    }
  };

  let changes: ObjectChanges = {};
  let changesError: string | null = null;
  try {
    changes = changesOf(kind, form, detail ? formOf(detail) : null);
  } catch (err) {
    changesError = messageOf(err);
  }
  const changed = Object.keys(changes).length > 0;
  const guarded = detail?.published === true && !changeVisible;
  const label = fields.label.toLowerCase();

  const save = () =>
    act(creating ? `Creating the ${label}...` : "Saving...", async () => {
      const saved = await window.edutools.saveObject({
        courseId: course.id,
        kind,
        id: creating ? null : (detail?.id ?? null),
        changes,
        changeVisible,
      });
      const wasNew = creating;
      setCreating(false);
      show(saved);
      await loadList();
      return wasNew ? `Created "${saved.title}", unpublished.` : `Saved "${saved.title}".`;
    });

  const publish = (published: boolean) => {
    if (!detail) {
      return;
    }
    const question = published
      ? `Publish "${detail.title}"?\n\nStudents will be able to see it.`
      : `Unpublish "${detail.title}"?\n\nStudents will no longer see it.`;
    if (!window.confirm(question)) {
      return;
    }
    void act(published ? "Publishing..." : "Unpublishing...", async () => {
      const saved = await window.edutools.setObjectPublished({ courseId: course.id, kind, id: detail.id }, published);
      show(saved);
      await loadList();
      return `${published ? "Published" : "Unpublished"} "${saved.title}".`;
    });
  };

  const remove = () => {
    if (!detail) {
      return;
    }
    const grades = DELETE_TAKES_GRADES.has(kind)
      ? `\n\nDeleting ${kind === "discussion" ? "a graded discussion" : `a ${kind}`} also deletes every submission and grade on it. This cannot be undone.`
      : "\n\nThis cannot be undone.";
    const repoNote = detail.managedBy ? `\n\nThe course repository still has ${detail.managedBy}; the next push creates it again.` : "";
    if (!window.confirm(`Delete the ${label} "${detail.title}" from ${course.code || course.name}?${grades}${repoNote}`)) {
      return;
    }
    void act("Deleting...", async () => {
      const title = await window.edutools.deleteObject({ courseId: course.id, kind, id: detail.id });
      setDetail(null);
      setSelected(null);
      await loadList();
      return `Deleted "${title}".`;
    });
  };

  const openInCanvas = () => {
    if (detail?.htmlUrl) {
      window.edutools.openExternal(detail.htmlUrl).catch((err: unknown) => setStatus(messageOf(err)));
    }
  };

  const editing = creating || detail !== null;

  return (
    <div className="stack">
      <div className="toolbar">
        <label htmlFor="edit-kind">Kind:</label>
        <select id="edit-kind" value={kind} disabled={busy} onChange={(e) => setKind(EDIT_KINDS.find((k) => k === e.target.value) ?? "page")}>
          {EDIT_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_FIELDS[k].label}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void loadList()}>
          Refresh
        </button>
        <button type="button" className="new-object" disabled={busy} onClick={startNew}>
          New {fields.label}
        </button>
      </div>

      {listError && (
        <p className="message error" role="alert">
          {listError}
        </p>
      )}

      <div className="table-frame short">
        <table className="grid selectable object-list">
          <thead>
            <tr>
              <th>Title</th>
              <th>{kind === "page" ? "URL slug" : "ID"}</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            {list?.map((o) => (
              <Row key={o.id} selected={o.id === selected} onSelect={() => o.id !== selected && void open(o.id)} onActivate={() => void open(o.id)}>
                <td>{o.title}</td>
                <td className="mono">{o.id}</td>
                <td>{o.published ? "Yes" : "No"}</td>
              </Row>
            ))}
            {list?.length === 0 && (
              <tr>
                <td colSpan={3} className="empty">
                  This course has no {label}s yet.
                </td>
              </tr>
            )}
            {list === null && !listError && (
              <tr>
                <td colSpan={3} className="empty">
                  Loading...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <fieldset className="group edit-form">
          <legend>
            {creating ? `New ${label}` : `${fields.label}: ${detail?.title ?? ""}`}
            {detail && <span className="muted"> ({detail.published ? "published, visible to students" : "unpublished"})</span>}
          </legend>

          {detail?.managedBy && (
            <p className="message warn">
              The course repository manages this {label} as <code>{detail.managedBy}</code>. The next push overwrites
              changes made here; edit the repository instead where you can.
            </p>
          )}

          <div className="form-grid">
            <label htmlFor="edit-title">Title:</label>
            <input id="edit-title" value={form.title} onChange={(e) => set("title", e.target.value)} />

            {fields.body && (
              <>
                <span>Body from:</span>
                <div className="check-row">
                  <label className="check">
                    <input
                      type="radio"
                      name="body-source"
                      checked={form.bodySource === "html"}
                      onChange={() => set("bodySource", "html")}
                    />
                    HTML typed here
                  </label>
                  <label className="check">
                    <input
                      type="radio"
                      name="body-source"
                      checked={form.bodySource === "markdown"}
                      onChange={() => set("bodySource", "markdown")}
                    />
                    A markdown file
                  </label>
                </div>
                {form.bodySource === "html" ? (
                  <>
                    <label htmlFor="edit-html">HTML:</label>
                    <textarea
                      id="edit-html"
                      className="mono"
                      rows={8}
                      value={form.html}
                      onChange={(e) => set("html", e.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <span>Markdown file:</span>
                    <div>
                      <div className="form-row folder-row">
                        <input type="text" readOnly className="mono" value={form.markdownFile} aria-label="Markdown file" />
                        <button type="button" onClick={() => void chooseMarkdown()}>
                          Choose...
                        </button>
                      </div>
                      {preview && (
                        <p className="muted">
                          Rendered as a push would render it: {preview.html.length.toLocaleString()} characters of HTML
                          {preview.title ? `, titled "${preview.title}"` : ""}.
                        </p>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {fields.points && (
              <>
                <label htmlFor="edit-points">Points:</label>
                <input
                  id="edit-points"
                  type="number"
                  min={0}
                  step="any"
                  className="narrow-input"
                  value={form.points}
                  onChange={(e) => set("points", e.target.value)}
                />
              </>
            )}

            {fields.dates &&
              DATE_FIELDS.map(({ key, label: dateLabel }) => (
                <FragmentRow key={key} id={`edit-${key}`} label={`${dateLabel}:`}>
                  <input
                    id={`edit-${key}`}
                    type="datetime-local"
                    value={form[key]}
                    onChange={(e) => set(key, e.target.value)}
                  />
                  {form[key] && (
                    <button type="button" className="link-button" onClick={() => set(key, "")}>
                      Clear
                    </button>
                  )}
                </FragmentRow>
              ))}
          </div>
          {fields.dates && <p className="muted">Dates are in this computer's time zone.</p>}

          {detail?.published && (
            <label className="check visible-guard">
              <input type="checkbox" checked={changeVisible} onChange={(e) => setChangeVisible(e.target.checked)} />
              This is visible to students; change it anyway
            </label>
          )}

          {changesError && <p className="message error">{changesError}</p>}

          <div className="buttons">
            <button
              type="button"
              className="save-object"
              disabled={busy || !changed || guarded || changesError !== null}
              onClick={() => void save()}
            >
              {creating ? "Create (Unpublished)" : "Save Changes"}
            </button>
            {detail && !detail.published && (
              <button type="button" disabled={busy} onClick={() => publish(true)}>
                Publish...
              </button>
            )}
            {detail?.published && (
              <button type="button" disabled={busy} onClick={() => publish(false)}>
                Unpublish...
              </button>
            )}
            {detail && (
              <button type="button" disabled={busy || !detail.htmlUrl} onClick={openInCanvas}>
                Open in Canvas
              </button>
            )}
            <span className="spacer" />
            {detail && (
              <button type="button" disabled={busy} onClick={remove}>
                Delete...
              </button>
            )}
          </div>
          {creating && <p className="muted">A new {label} is created unpublished. Publish it when it is ready.</p>}
          {outcome && (
            <p className={`message ${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
              {outcome.text}
            </p>
          )}
        </fieldset>
      )}
      {!editing && outcome && (
        <p className={`message ${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
          {outcome.text}
        </p>
      )}
    </div>
  );
}

/** A label and its control as two cells of the form grid. */
function FragmentRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="date-cell">{children}</div>
    </>
  );
}
