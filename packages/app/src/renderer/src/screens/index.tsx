import type { ComponentType } from "react";
import type { ScreenId } from "../../../shared/screens";
import { Courses } from "./Courses";
import { Overview } from "./Overview";
import { placeholder } from "./Placeholder";
import { Settings } from "./Settings";
import { Snapshot } from "./Snapshot";
import type { ScreenProps } from "./types";

/**
 * One component per screen id. The Record type makes a missing entry a type
 * error, so a screen added to shared/screens.ts cannot be forgotten here.
 */
export const SCREEN_COMPONENTS: Record<ScreenId, ComponentType<ScreenProps>> = {
  courses: Courses,
  overview: Overview,
  snapshot: Snapshot,
  publish: placeholder("publish"),
  verify: placeholder("verify"),
  audit: placeholder("audit"),
  outline: placeholder("outline"),
  edit: placeholder("edit"),
  settings: Settings,
};
