import type { ComponentType } from "react";
import type { ScreenId } from "../../../shared/screens";
import { Audit } from "./Audit";
import { Courses } from "./Courses";
import { Dates } from "./Dates";
import { EditObject } from "./EditObject";
import { Outline } from "./Outline";
import { Overview } from "./Overview";
import { Publish } from "./Publish";
import { Settings } from "./Settings";
import { Snapshot } from "./Snapshot";
import type { ScreenProps } from "./types";
import { Verify } from "./Verify";

/**
 * One component per screen id. The Record type makes a missing entry a type
 * error, so a screen added to shared/screens.ts cannot be forgotten here.
 */
export const SCREEN_COMPONENTS: Record<ScreenId, ComponentType<ScreenProps>> = {
  courses: Courses,
  overview: Overview,
  snapshot: Snapshot,
  publish: Publish,
  verify: Verify,
  audit: Audit,
  outline: Outline,
  dates: Dates,
  edit: EditObject,
  settings: Settings,
};
