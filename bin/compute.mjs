// The CLI's compute boundary. One command's whole job runs here, in a child process the parent
// can really terminate: ELK and libavoid run in worker threads inside this process, and `score()`
// is a synchronous loop, so nothing inside could interrupt itself. The parent kills this process
// when its deadline expires, which takes the worker threads with it.
//
// This process writes no artifact and no diagnostic of its own. It returns strings to the parent,
// which owns stdout, stderr and the files.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadLibrary() {
  return import('../dist/portograph.js');
}

/** `input` blames the document, `processing` blames the tool: a deadline, an asset, an internal bug. */
const failure = (kind, message, code) => ({ ok: false, kind, message, ...(code ? { code } : {}) });

function readInput(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') };
  } catch (error) {
    return failure('input', `cannot read ${path}: ${error.message}`);
  }
}

async function run(request, emit) {
  const api = await loadLibrary();
  const { CommandDeadlineError, ElkDeadlineError, RouteDeadlineError, ParseError, ResolveError, createBudget, formatDiagnostic, layout,
    drawio, migrateWithDiagnostics, parseWithDiagnostics, render, restoreFinalLayout, score,
    serializeLayoutModel } = api;

  const budget = createBudget(Math.max(1, request.deadlineAt - Date.now()));
  const printed = new Set();
  const say = (diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (printed.has(key)) return;
    printed.add(key);
    emit({ type: 'diagnostic', text: formatDiagnostic(diagnostic) });
  };
  const progress = process.env.PORTOGRAPH_PROGRESS === '1'
    ? (event) => emit({ type: 'progress',
      text: `portograph: ${event.stage} took ${Math.round(event.durationMs)} ms, ${Number.isFinite(event.remainingMs) ? `${Math.round(event.remainingMs)} ms left` : 'no deadline'}` })
    : undefined;

  const { verb, input, force, allowGateFailures, layers, format, theme, labels, icons } = request.command;
  // One place decides what `render` writes, so the restored-layout path and the from-YAML path can
  // never drift apart on it.
  const primaryArtifact = (model) => format === 'drawio'
    ? drawio(model, { ...(layers ? { layers } : {}), ...(theme ? { theme } : {}), ...(labels ? { labels } : {}), ...(icons ? { icons } : {}) })
    : render(model, layers ? { layers } : {});
  void allowGateFailures; // the parent applies it to the exit code; the report never changes.
  const source = readInput(input);
  if (source.ok !== true) return source;
  if (verb === 'migrate') {
    const result = migrateWithDiagnostics(source.text, { force });
    for (const diagnostic of result.diagnostics) say(diagnostic);
    return result.ok ? { ok: true, result: { primary: result.yaml } }
      : failure('input', `${input} cannot be migrated`);
  }

  // `score` reads a serialized layout, never authored YAML. YAML is a superset of JSON, so handing
  // this text to the parser would "succeed" at reinterpreting a layout model as a document.
  let serializedLayout = verb === 'score';
  if (verb === 'render') {
    try {
      const candidate = JSON.parse(source.text);
      serializedLayout = candidate !== null && typeof candidate === 'object'
        && ['document', 'stage', 'freeze', 'tierBands'].some(key => Object.hasOwn(candidate, key));
    } catch { /* Authored YAML, or an input error for the schema parser to explain. */ }
  }
  if (serializedLayout) {
    let model;
    try {
      model = restoreFinalLayout(source.text);
    } catch (error) {
      return failure('input', `${input} is not a final layout: ${error.message}`);
    }
    for (const diagnostic of model.diagnostics) say(diagnostic);
    if (Object.keys(model.nodes).length > 1000 && !force) {
      return failure('input', `${input} has more than 1000 nodes; ${verb} requires --force`);
    }
    const report = score(model, { force });
    if (verb === 'render') return { ok: true, result: {
      primary: primaryArtifact(model),
      sidecars: { layout: `${serializeLayoutModel(model)}\n`, score: `${JSON.stringify(report, null, 2)}\n` },
      passed: report.snapshot.passed,
    } };
    return { ok: true, result: { primary: `${JSON.stringify(report, null, 2)}\n`, passed: report.snapshot.passed } };
  }

  const parsed = parseWithDiagnostics(source.text, { force, onDiagnostic: say });
  if (!parsed.ok) return failure('input', `${input} has ${parsed.diagnostics.filter((d) => d.severity === 'error').length} error(s)`);

  const { createNodeElkFactory, createNodeRouteFactory } = require('../dist/node.cjs');
  let elk;
  let router;
  try {
    elk = createNodeElkFactory();
    router = createNodeRouteFactory();
  } catch (error) {
    return failure('processing', `a packaged worker asset is unavailable: ${error.message}`, 'WORKER_ASSET');
  }

  let model;
  try {
    model = await layout(parsed.document, {
      diagnostics: parsed.diagnostics,
      createElkAttempt: () => {
        const attempt = elk();
        if (progress) emit({ type: 'progress', text: 'portograph: ELK worker started' });
        return attempt;
      },
      createRouteAttempt: router,
      budget,
      ...(progress ? { onProgress: progress } : {}),
    });
  } catch (error) {
    if (error instanceof ResolveError || error instanceof ParseError) {
      for (const diagnostic of error.diagnostics) say(diagnostic);
      return failure('input', `${input} cannot be laid out`);
    }
    if (error instanceof CommandDeadlineError || error instanceof RouteDeadlineError || error instanceof ElkDeadlineError) return failure('processing', error.message, 'COMMAND_DEADLINE');
    return failure('processing', `layout failed: ${error.message}`, 'PIPELINE_FAILED');
  }
  for (const diagnostic of model.diagnostics) say(diagnostic);

  const layoutJson = `${serializeLayoutModel(model)}\n`;
  if (verb === 'layout') return { ok: true, result: { primary: layoutJson } };

  const report = score(model, { force });
  return { ok: true, result: {
    primary: primaryArtifact(model),
    sidecars: { layout: layoutJson, score: `${JSON.stringify(report, null, 2)}\n` },
    passed: report.snapshot.passed,
  } };
}

process.on('message', (message) => {
  if (message.type !== 'run') return;
  const emit = (event) => { process.send?.(event); };
  const send = (value) => {
    // Flush the result before exiting, so the parent can never see the exit without the answer.
    process.send?.({ type: 'result', value }, () => { process.exit(0); });
  };
  run({ command: message.request, deadlineAt: message.deadlineAt }, emit)
    .then(send, (error) => send(failure('processing', `internal error: ${error && error.stack ? error.stack : String(error)}`, 'INTERNAL')));
});
