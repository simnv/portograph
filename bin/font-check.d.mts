/** Is Verdana installed on this machine? The CLI warns when it is not; see `font-check.mjs`. */
export declare function fontDirectories(platform?: string, env?: Record<string, string | undefined>, home?: string): string[];
export declare function verdanaInstalled(directories?: string[]): boolean;
export declare const VERDANA_WARNING: string;
