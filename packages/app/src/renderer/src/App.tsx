import { useCallback, useEffect, useState } from "react";
import type { CourseChoice, CurrentCourse } from "../../shared/ipc";
import { SCREENS, type ScreenId, type ScreenInfo } from "../../shared/screens";
import { SCREEN_COMPONENTS } from "./screens";
import { courseLabel } from "./screens/types";

const GROUPS: readonly ScreenInfo["group"][] = ["Canvas", "Course repository", "Tools"];

export function App() {
  const [current, setCurrent] = useState<ScreenId>("courses");
  const [status, setStatus] = useState("Ready");
  const [course, setCourse] = useState<CurrentCourse | null>(null);

  // Read at launch and on every screen change: changing the default site in
  // Settings can leave the remembered course belonging to another site.
  const refreshCourse = useCallback(() => {
    window.edutools.getCurrentCourse().then(setCourse, () => setCourse(null));
  }, []);

  const navigate = useCallback(
    (screen: ScreenId) => {
      setCurrent(screen);
      refreshCourse();
    },
    [refreshCourse],
  );

  useEffect(refreshCourse, [refreshCourse]);
  useEffect(() => window.edutools.on("navigate", navigate), [navigate]);

  const openCourse = useCallback(async (choice: CourseChoice) => {
    const chosen = await window.edutools.setCurrentCourse(choice);
    setCourse(chosen);
    if (chosen) {
      setStatus(`Opened ${courseLabel(chosen)}`);
      setCurrent("overview");
    }
  }, []);

  const info = SCREENS.find((s) => s.id === current) ?? SCREENS[0];
  const Screen = SCREEN_COMPONENTS[current];

  return (
    <div className="window">
      <nav className="sidebar" aria-label="Screens">
        {GROUPS.map((group) => (
          <div key={group} className="sidebar-group">
            <div className="sidebar-heading">{group}</div>
            <ul>
              {SCREENS.filter((s) => s.group === group).map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={s.id === current ? "nav-item selected" : "nav-item"}
                    data-screen={s.id}
                    aria-current={s.id === current ? "page" : undefined}
                    onClick={() => navigate(s.id)}
                  >
                    {s.title}
                    {!s.available && <span className="soon">not yet available</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <main className="content">
        {info && (
          <header className="screen-header">
            <h1>{info.title}</h1>
            <p>{info.summary}</p>
          </header>
        )}
        <div className="screen-body" data-screen={current}>
          <Screen setStatus={setStatus} navigate={navigate} course={course} openCourse={openCourse} />
        </div>
      </main>
      <footer className="statusbar">
        <span className="status-text">{status}</span>
        <span className="status-course" title={course ? `Course ${course.id} on ${course.endpoint}` : undefined}>
          {course ? `Course: ${courseLabel(course)}` : "No course open"}
        </span>
      </footer>
    </div>
  );
}
