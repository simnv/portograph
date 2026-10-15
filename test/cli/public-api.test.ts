import { describe, expect, it } from 'vitest';
import * as internal from '../../src/internal.js';
import * as api from '../../src/index.js';

describe('public API', () => {
  it('exports parse, lay out, score and render, and nothing else', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CommandDeadlineError', 'ElkDeadlineError', 'ParseError', 'ResolveError', 'RouteDeadlineError',
      'createBrowserElkFactory', 'createBrowserRouteFactory', 'createBudget', 'drawio', 'layout', 'migrate',
      'migrateWithDiagnostics', 'parse', 'parseWithDiagnostics', 'render', 'restoreFinalLayout', 'score',
      'serializeLayoutModel',
    ]);
  });

  it('shares one copy of each function with the internal entry', () => {
    for (const [name, value] of Object.entries(api)) expect(internal[name as keyof typeof internal], name).toBe(value);
  });
});
