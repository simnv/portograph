import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Document, Node } from 'yaml';
import type { Diagnostic } from '../model/index.js';

/** A schema path uses JSONPath bracket notation for array indices. */
export interface SourceDiagnostic extends Diagnostic { path: string }

/** A place in the authored text, 1-based. Kept beside the diagnostics, not inside them, so layout JSON does not change. */
export interface SourceLocation { line: number; column: number }

export type LocateDiagnostic = (diagnostic: SourceDiagnostic) => SourceLocation | undefined;

export class ParseError extends Error {
  constructor(public readonly diagnostics: SourceDiagnostic[], locate?: LocateDiagnostic) {
    super(diagnostics.filter(d => d.severity === 'error').map(d => {
      const at = locate?.(d);
      return `${at ? `${at.line}:${at.column} ` : ''}${d.path}: ${d.message}`;
    }).join('\n'));
    this.name = 'ParseError';
  }
}

/** Split `$.groups.core.ports.list[0].side` into its keys and indices. */
function pathSegments(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const match of path.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)) segments.push(match[2] !== undefined ? Number(match[2]) : match[1]!);
  return segments;
}

export class Validation {
  readonly diagnostics: SourceDiagnostic[] = [];
  private ast: Document.Parsed | undefined;
  private readonly lines = new LineCounter();
  private readonly known = new WeakMap<SourceDiagnostic, SourceLocation>();

  /**
   * Where a diagnostic points in the authored text: the key or list item its path names, or the
   * deepest part of that path that exists (a missing key points at the map that should hold it).
   */
  locate = (diagnostic: SourceDiagnostic): SourceLocation | undefined => {
    const known = this.known.get(diagnostic);
    if (known !== undefined || this.ast === undefined) return known;
    let node: unknown = this.ast.contents;
    let offset: number | undefined = (node as Node | null)?.range?.[0];
    for (const segment of pathSegments(diagnostic.path)) {
      if (typeof segment === 'string' && isMap(node)) {
        const pair = node.items.find(item => isScalar(item.key) && String(item.key.value) === segment);
        if (pair === undefined) break;
        offset = (pair.key as Node).range?.[0] ?? offset;
        node = pair.value;
      } else if (typeof segment === 'number' && isSeq(node)) {
        const item = node.items[segment];
        if (item === undefined) break;
        offset = (item as Node).range?.[0] ?? offset;
        node = item;
      } else break;
    }
    if (offset === undefined) return undefined;
    const { line, col } = this.lines.linePos(offset);
    return { line, column: col };
  };

  report(code: string, path: string, message: string, severity: Diagnostic['severity'] = 'error', stage: Diagnostic['stage'] = 'parse'): void {
    this.diagnostics.push({ code, path, message, severity, stage });
  }

  get failed(): boolean { return this.diagnostics.some(d => d.severity === 'error'); }

  yaml(text: string): unknown {
    try {
      const ast = parseDocument(text, { stringKeys: true, merge: true, prettyErrors: false, lineCounter: this.lines });
      this.ast = ast;
      for (const error of ast.errors) {
        this.report('INVALID_YAML', '$', error.message);
        const start = error.pos[0];
        if (typeof start === 'number') { const { line, col } = this.lines.linePos(start); this.known.set(this.diagnostics.at(-1)!, { line, column: col }); }
      }
      for (const warning of ast.warnings) this.report('YAML_WARNING', '$', warning.message, 'warning');
      // Maps preserve the AST's declaration order, including integer-like IDs, before
      // any JavaScript object is created. Keep YAML's default alias expansion bound.
      return ast.errors.length ? undefined : ast.toJS({ mapAsMap: true });
    } catch (error) {
      this.report('INVALID_YAML', '$', error instanceof Error ? error.message : 'Invalid YAML');
      return undefined;
    }
  }

  map(value: unknown, path: string): Map<string, unknown> {
    const result = new Map<string, unknown>();
    if (!(value instanceof Map)) {
      this.report('INVALID_TYPE', path, 'Expected a map');
      return result;
    }
    const entries: Map<unknown, unknown> = value;
    for (const [key, item] of entries) {
      if (typeof key !== 'string') this.report('INVALID_TYPE', path, 'Map keys must be strings');
      else result.set(key, item);
    }
    return result;
  }

  list(value: unknown, path: string): unknown[] {
    if (Array.isArray(value)) return value;
    this.report('INVALID_TYPE', path, 'Expected a list');
    return [];
  }

  keys(map: Map<string, unknown>, allowed: readonly string[], path: string): void {
    for (const key of map.keys()) if (!allowed.includes(key)) this.report('UNKNOWN_KEY', `${path}.${key}`, `Unknown key ${key}`);
  }

  string(value: unknown, path: string): string | undefined {
    if (typeof value === 'string') return value;
    this.report('INVALID_TYPE', path, 'Expected a string');
    return undefined;
  }

  identifier(value: unknown, path: string): string | undefined {
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) return value;
    this.report('BAD_IDENTIFIER', path, 'Expected an identifier containing letters, digits, underscores or hyphens, starting with a letter or digit');
    return undefined;
  }

  number(value: unknown, path: string, integer = false, min = -Infinity): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && (!integer || Number.isSafeInteger(value))) return value;
    this.report('INVALID_TYPE', path, `Expected a finite ${integer ? 'safe integer' : 'number'}${min !== -Infinity ? ` >= ${min}` : ''}`);
    return undefined;
  }

  choice<const T extends string>(value: unknown, choices: readonly T[], path: string): T | undefined {
    for (const choice of choices) if (value === choice) return choice;
    this.report('INVALID_TYPE', path, `Expected one of ${choices.join(', ')}`);
    return undefined;
  }
}

/** Define own map entries even for legal identifiers such as constructor. */
export function put<T>(map: Record<string, T>, id: string, value: T): void {
  Object.defineProperty(map, id, { value, enumerable: true, writable: true, configurable: true });
}

export function own<T>(map: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(map, id) ? map[id] : undefined;
}
