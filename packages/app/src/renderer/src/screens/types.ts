import type { ScreenId } from "../../../shared/screens";

/** What every screen receives from the window around it. */
export interface ScreenProps {
  /** Replace the text in the status bar at the bottom of the window. */
  readonly setStatus: (text: string) => void;
  readonly navigate: (screen: ScreenId) => void;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
