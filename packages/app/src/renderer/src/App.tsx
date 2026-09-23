import { useEffect, useState } from "react";
import { SCREENS, type ScreenId, type ScreenInfo } from "../../shared/screens";
import { SCREEN_COMPONENTS } from "./screens";

const GROUPS: readonly ScreenInfo["group"][] = ["Canvas", "Course repository", "Tools"];

export function App() {
  const [current, setCurrent] = useState<ScreenId>("courses");
  const [status, setStatus] = useState("Ready");

  useEffect(() => window.edutools.onNavigate(setCurrent), []);

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
                    aria-current={s.id === current ? "page" : undefined}
                    onClick={() => setCurrent(s.id)}
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
        <div className="screen-body">
          <Screen setStatus={setStatus} navigate={setCurrent} />
        </div>
      </main>
      <footer className="statusbar">{status}</footer>
    </div>
  );
}
