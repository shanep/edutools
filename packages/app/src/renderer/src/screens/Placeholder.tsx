import { SCREENS, type ScreenId } from "../../../shared/screens";
import type { ScreenProps } from "./types";

/** A stand-in for a screen that is planned but not built yet. */
export function placeholder(id: ScreenId) {
  const info = SCREENS.find((s) => s.id === id);
  function Placeholder({ navigate }: ScreenProps) {
    return (
      <fieldset className="group">
        <legend>Not yet available</legend>
        <p>
          <strong>{info?.title ?? id}</strong> is planned for a later version of edutools and does nothing yet.
        </p>
        <p className="muted">Until then, the edutools command line tool can do this job.</p>
        <div className="buttons">
          <button type="button" onClick={() => navigate("courses")}>
            Go to Courses
          </button>
        </div>
      </fieldset>
    );
  }
  Placeholder.displayName = `Placeholder(${id})`;
  return Placeholder;
}
