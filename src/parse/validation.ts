import { parseDocument } from 'yaml';
import type { Diagnostic } from '../model/index.js';

/** A schema path uses JSONPath bracket notation for array indices. */
export interface SourceDiagnostic extends Diagnostic { path: string }

export class ParseError extends Error {
  constructor(public readonly diagnostics: SourceDiagnostic[]) {
    super(diagnostics.filter(d => d.severity === 'error').map(d => `${d.path}: ${d.message}`).join('\n'));
    this.name = 'ParseError';
  }
}

export class Validation {
  readonly diagnostics: SourceDiagnostic[] = [];

  report(code: string, path: string, message: string, severity: Diagnostic['severity'] = 'error', stage: Diagnostic['stage'] = 'parse'): void {
    this.diagnostics.push({ code, path, message, severity, stage });
  }

  get failed(): boolean { return this.diagnostics.some(d => d.severity === 'error'); }

  yaml(text: string): unknown {
    try {
      const ast = parseDocument(text, { stringKeys: true, merge: true, prettyErrors: false });
      for (const error of ast.errors) this.report('INVALID_YAML', '$', error.message);
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
