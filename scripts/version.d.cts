export declare function versionFromDescribe(described: string): string;
export declare function gitVersion(cwd?: string): string;
export declare function compareVersions(a: string, b: string): number;
export declare function bumpVersion(version: string, part: "major" | "minor" | "patch"): string;
export declare function latestVersion(tags: readonly string[]): string | null;
