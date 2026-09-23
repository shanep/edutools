import type { ScreenId } from "../../../shared/screens";

/** What a screen that works on one course shows until a course is open. */
export function NoCourse({ navigate }: { navigate: (screen: ScreenId) => void }) {
  return (
    <fieldset className="group no-course">
      <legend>No course open</legend>
      <p>This screen works on one course at a time, and no course is open yet.</p>
      <p className="muted">
        On the Courses screen, double-click a course, or select it and choose Open. edutools remembers it next time.
      </p>
      <div className="buttons">
        <button type="button" onClick={() => navigate("courses")}>
          Go to Courses
        </button>
      </div>
    </fieldset>
  );
}
