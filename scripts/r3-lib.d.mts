export function reversed(yaml: string, key: 'links' | 'nodes'): string;
export function comparable(api: { serializeLayoutModel(model: unknown): string }, model: unknown): Record<string, unknown>;
export function differences(a: unknown, b: unknown, path?: string): Generator<string>;
export const MEMBER_ORDER: RegExp;
export function firstDifference(a: unknown, b: unknown, allowed?: RegExp): string | undefined;
export function checkSheet(options: { read: () => string; lay: (text: string) => Promise<unknown>; describe: (error: unknown) => string }): Promise<{ lines: [string, string][]; bad: number }>;
