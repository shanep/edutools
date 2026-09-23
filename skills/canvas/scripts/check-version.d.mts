export interface VersionState {
  fetched: boolean;
  latestRelease: string | null;
  installed: { version: string | null; path: string | null; fromCheckout: boolean };
  checkout: {
    root: string;
    version: string | null;
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    uncommitted: number;
  };
}

export declare function assess(state: VersionState, compare: (a: string, b: string) => number): string[];
