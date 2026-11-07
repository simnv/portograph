export function reversed(yaml: string, key: 'links' | 'nodes'): string;
export function comparable(api: { serializeLayoutModel(model: unknown): string }, model: unknown): Record<string, unknown>;
export function differences(a: unknown, b: unknown, path?: string): Generator<string>;
export function firstDifference(a: unknown, b: unknown): string | undefined;
