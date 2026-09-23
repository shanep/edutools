import { type ReactNode, useCallback, useEffect, useState } from "react";
import type {
  AssignmentGroupList,
  AssignmentRow,
  CurrentCourse,
  ModuleRow,
  PageRow,
} from "../../../shared/ipc";
import { formatDate, formatPoints } from "../../../shared/overview";
import { NoCourse } from "./NoCourse";
import { Row } from "./Row";
import { courseLabel, messageOf, plural, type ScreenProps } from "./types";

type TabId = "assignments" | "modules" | "pages" | "groups";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "assignments", label: "Assignments" },
  { id: "modules", label: "Modules" },
  { id: "pages", label: "Pages" },
  { id: "groups", label: "Assignment groups" },
];

interface TabProps {
  readonly course: CurrentCourse;
  readonly setStatus: (text: string) => void;
}

function yesNo(value: boolean | null): string {
  if (value === null) {
    return "";
  }
  return value ? "Yes" : "No";
}

/** Fetch one tab's list when it first shows and on Refresh, reporting in the status bar. */
function useCanvasList<T>(fetch: () => Promise<T>, what: string, setStatus: (text: string) => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(`Fetching ${what} from Canvas...`);
    try {
      setData(await fetch());
      setStatus(`Fetched ${what}`);
    } catch (err) {
      setError(messageOf(err));
      setStatus(`Could not fetch ${what}`);
    } finally {
      setLoading(false);
    }
  }, [fetch, what, setStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}

function openInCanvas(url: string, setStatus: (text: string) => void) {
  window.edutools.openExternal(url).then(
    () => setStatus("Opened in your web browser"),
    (err: unknown) => setStatus(messageOf(err)),
  );
}

/** The Refresh and Open in Canvas buttons, the error line, and the table frame every tab shares. */
function TabFrame(props: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly openUrl: string | null;
  readonly setStatus: (text: string) => void;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  const { loading, error, refresh, openUrl, setStatus, note, children } = props;
  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          Refresh
        </button>
        <button type="button" disabled={!openUrl} onClick={() => openUrl && openInCanvas(openUrl, setStatus)}>
          Open in Canvas
        </button>
        <span className="spacer" />
        {note}
      </div>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="table-frame">{children}</div>
    </div>
  );
}

function StateRows({ loading, empty, columns, what }: { loading: boolean; empty: boolean; columns: number; what: string }) {
  if (loading) {
    return (
      <tr>
        <td colSpan={columns} className="empty">
          Loading...
        </td>
      </tr>
    );
  }
  if (empty) {
    return (
      <tr>
        <td colSpan={columns} className="empty">
          This course has no {what}.
        </td>
      </tr>
    );
  }
  return null;
}

function AssignmentsTab({ course, setStatus }: TabProps) {
  const fetch = useCallback(() => window.edutools.listAssignments(course.id), [course.id]);
  const { data, error, loading, refresh } = useCanvasList<AssignmentRow[]>(fetch, "assignments", setStatus);
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = data?.find((a) => a.id === selected) ?? null;
  return (
    <TabFrame
      loading={loading}
      error={error}
      refresh={() => void refresh()}
      openUrl={chosen?.htmlUrl || null}
      setStatus={setStatus}
      note={data && <span className="muted">{plural(data.length, "assignment")}. Due dates are in your local time.</span>}
    >
      <table className="grid selectable">
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Points</th>
            <th>Due</th>
            <th>Published</th>
            <th>Assignment group</th>
          </tr>
        </thead>
        <tbody>
          {!loading &&
            data?.map((a) => (
              <Row
                key={a.id}
                selected={a.id === selected}
                onSelect={() => setSelected(a.id)}
                onActivate={() => a.htmlUrl && openInCanvas(a.htmlUrl, setStatus)}
              >
                <td>{a.name}</td>
                <td className="num">{formatPoints(a.points)}</td>
                <td className="nowrap">{formatDate(a.dueAt, "No due date")}</td>
                <td>{yesNo(a.published)}</td>
                <td>{a.group}</td>
              </Row>
            ))}
          <StateRows loading={loading} empty={data?.length === 0} columns={5} what="assignments" />
        </tbody>
      </table>
    </TabFrame>
  );
}

function ModulesTab({ course, setStatus }: TabProps) {
  const fetch = useCallback(() => window.edutools.listModules(course.id), [course.id]);
  const { data, error, loading, refresh } = useCanvasList<ModuleRow[]>(fetch, "modules", setStatus);
  const [selected, setSelected] = useState<string | null>(null);
  const urls = new Map<string, string>();
  for (const m of data ?? []) {
    urls.set(`m${m.id}`, m.htmlUrl);
    for (const item of m.items) {
      urls.set(`i${item.id}`, item.htmlUrl);
    }
  }
  const openUrl = (selected && urls.get(selected)) || null;
  return (
    <TabFrame
      loading={loading}
      error={error}
      refresh={() => void refresh()}
      openUrl={openUrl}
      setStatus={setStatus}
      note={data && <span className="muted">{plural(data.length, "module")}, items in course order.</span>}
    >
      <table className="grid selectable">
        <thead>
          <tr>
            <th>Module and items</th>
            <th>Type</th>
            <th>Published</th>
          </tr>
        </thead>
        <tbody>
          {!loading &&
            data?.flatMap((m) => [
              <Row
                key={`m${m.id}`}
                className="module-row"
                selected={selected === `m${m.id}`}
                onSelect={() => setSelected(`m${m.id}`)}
                onActivate={() => openInCanvas(m.htmlUrl, setStatus)}
              >
                <td>{m.name}</td>
                <td>Module ({plural(m.items.length, "item")})</td>
                <td>{yesNo(m.published)}</td>
              </Row>,
              ...m.items.map((item) => (
                <Row
                  key={`i${item.id}`}
                  selected={selected === `i${item.id}`}
                  onSelect={() => setSelected(`i${item.id}`)}
                  onActivate={() => item.htmlUrl && openInCanvas(item.htmlUrl, setStatus)}
                >
                  <td style={{ paddingLeft: `${22 + item.indent * 16}px` }}>{item.title}</td>
                  <td>{item.type}</td>
                  <td>{yesNo(item.published)}</td>
                </Row>
              )),
            ])}
          <StateRows loading={loading} empty={data?.length === 0} columns={3} what="modules" />
        </tbody>
      </table>
    </TabFrame>
  );
}

function PagesTab({ course, setStatus }: TabProps) {
  const fetch = useCallback(() => window.edutools.listPages(course.id), [course.id]);
  const { data, error, loading, refresh } = useCanvasList<PageRow[]>(fetch, "pages", setStatus);
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = data?.find((p) => p.url === selected) ?? null;
  return (
    <TabFrame
      loading={loading}
      error={error}
      refresh={() => void refresh()}
      openUrl={chosen?.htmlUrl || null}
      setStatus={setStatus}
      note={data && <span className="muted">{plural(data.length, "page")}.</span>}
    >
      <table className="grid selectable">
        <thead>
          <tr>
            <th>Title</th>
            <th>URL slug</th>
            <th>Published</th>
            <th>Last updated</th>
          </tr>
        </thead>
        <tbody>
          {!loading &&
            data?.map((p) => (
              <Row
                key={p.url}
                selected={p.url === selected}
                onSelect={() => setSelected(p.url)}
                onActivate={() => p.htmlUrl && openInCanvas(p.htmlUrl, setStatus)}
              >
                <td>{p.title}</td>
                <td className="mono">{p.url}</td>
                <td>{yesNo(p.published)}</td>
                <td className="nowrap">{formatDate(p.updatedAt)}</td>
              </Row>
            ))}
          <StateRows loading={loading} empty={data?.length === 0} columns={4} what="pages" />
        </tbody>
      </table>
    </TabFrame>
  );
}

function GroupsTab({ course, setStatus }: TabProps) {
  const fetch = useCallback(() => window.edutools.listAssignmentGroups(course.id), [course.id]);
  const { data, error, loading, refresh } = useCanvasList<AssignmentGroupList>(fetch, "assignment groups", setStatus);
  const total = (data?.groups ?? []).reduce((sum, g) => sum + (g.weight ?? 0), 0);
  return (
    <TabFrame
      loading={loading}
      error={error}
      refresh={() => void refresh()}
      openUrl={data?.htmlUrl || null}
      setStatus={setStatus}
      note={
        data && (
          <span className="muted">
            {data.weighted
              ? `The final grade is weighted by group. Weights total ${total}%.`
              : "The final grade is not weighted by group, so Canvas ignores these weights."}
          </span>
        )
      }
    >
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Weight</th>
            <th className="num">Assignments</th>
          </tr>
        </thead>
        <tbody>
          {!loading &&
            data?.groups.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td className="num">{g.weight === null ? "" : `${g.weight}%`}</td>
                <td className="num">{g.assignmentCount}</td>
              </tr>
            ))}
          <StateRows loading={loading} empty={data?.groups.length === 0} columns={3} what="assignment groups" />
        </tbody>
      </table>
    </TabFrame>
  );
}

const TAB_COMPONENTS: Record<TabId, (props: TabProps) => ReactNode> = {
  assignments: AssignmentsTab,
  modules: ModulesTab,
  pages: PagesTab,
  groups: GroupsTab,
};

export function Overview({ course, setStatus, navigate }: ScreenProps) {
  const [tab, setTab] = useState<TabId>("assignments");
  // A tab stays mounted once shown, so switching back does not fetch it again;
  // Refresh is how to see a change made in Canvas since.
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(new Set(["assignments"]));

  if (!course) {
    return <NoCourse navigate={navigate} />;
  }

  const show = (id: TabId) => {
    setTab(id);
    setVisited((v) => new Set([...v, id]));
  };

  return (
    <div className="stack" key={course.id}>
      <p>
        <strong>{courseLabel(course)}</strong> <span className="muted">(course {course.id}). Read only.</span>
      </p>
      <div className="tabs" role="tablist" aria-label="Course contents">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={tab === t.id ? "tab selected" : "tab"}
            onClick={() => show(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.filter((t) => visited.has(t.id)).map((t) => {
        const Tab = TAB_COMPONENTS[t.id];
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={`panel-${t.id}`}
            aria-labelledby={`tab-${t.id}`}
            hidden={tab !== t.id}
            className="tab-panel"
          >
            <Tab course={course} setStatus={setStatus} />
          </div>
        );
      })}
    </div>
  );
}
