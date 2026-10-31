// portograph command line. Plain JavaScript: it loads the built library from
// dist/ at run time, so `npm run build` must run before the CLI is usable.
//
// This process parses arguments, prints diagnostics to stderr and writes artifacts. It does no
// layout work itself. `layout`, `render` and `score` run in one child process (`compute.mjs`),
// because that is the only boundary that can really stop them: ELK and libavoid run in worker
// threads *inside* that child, and `score()` is synchronous, so an in-thread timer or a
// `Promise.race` could not interrupt either. The parent owns the single absolute deadline and
// kills the child on expiry, which takes its worker threads with it.
import { fork } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { VERDANA_WARNING, verdanaInstalled } from './font-check.mjs';

// Node 22.1 and newer keep the compiled code of the library on disk between runs; older Node has no such call. The cache holds compiled code only.
nodeModule.enableCompileCache?.();
const require = nodeModule.createRequire(import.meta.url);
const { version } = require('../package.json');
const COMPUTE = fileURLToPath(new URL('./compute.mjs', import.meta.url));

async function loadLibrary() {
  try {
    return await import('../dist/portograph.js');
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('portograph: build output missing; run `npm run build` first');
    }
    throw error;
  }
}

/** All of a stream as UTF-8 text; stdin is read here, in the parent, so the child needs no handle on it. */
async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** The deadline a command really gets. The environment override exists so tests can prove the
 * termination path with real computational work instead of waiting a minute. */
function deadlineMs(fallback) {
  const raw = process.env.PORTOGRAPH_COMMAND_DEADLINE_MS;
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`portograph: PORTOGRAPH_COMMAND_DEADLINE_MS must be a positive number of milliseconds`);
  return value;
}

/**
 * Run the compute job in a child process under one absolute deadline.
 *
 * Returns `{ ok: true, result }`, or `{ ok: false, kind, message, diagnostics }` where `kind` is
 * `input` or `processing`. Progress and diagnostics reach `io.err` while the child still runs, so
 * a long command is not silent.
 */
function compute(request, io, limitMs, inputText) {
  return new Promise((resolve) => {
    const deadlineAt = Date.now() + limitMs;
    let child;
    try {
      child = fork(COMPUTE, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (error) {
      resolve({ ok: false, kind: 'processing', message: `could not start the compute process: ${error.message}`, diagnostics: [] });
      return;
    }
    // Nothing the child writes to its own streams is ever an artifact. Forward both to stderr so a
    // worker crash is visible without being able to pollute the primary artifact on stdout.
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => io.err.write(chunk));

    if (process.env.PORTOGRAPH_PROGRESS === '1') io.err.write(`portograph: compute process ${child.pid}\n`);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      if (value.ok && Date.now() >= deadlineAt) value = { ok: false, kind: 'processing', code: 'COMMAND_DEADLINE',
        message: `the command did not finish within ${limitMs} ms; no artifacts were published` };
      settled = true;
      clearTimeout(timer);
      // Whatever the outcome, this process tree stops here: SIGKILL cannot be caught or delayed,
      // and it takes the child's ELK and libavoid worker threads with it.
      if (child.exitCode !== null || child.signalCode !== null) { resolve(value); return; }
      child.once('exit', () => resolve(value));
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      finish({ ok: false, kind: 'processing', code: 'COMMAND_DEADLINE',
        message: `the command did not finish within ${limitMs} ms; no layout, score or gate result was produced` });
    }, Math.max(1, deadlineAt - Date.now()));

    child.on('message', (message) => {
      if (message.type === 'diagnostic' || message.type === 'progress') io.err.write(`${message.text}\n`);
      else if (message.type === 'result') finish(message.value);
    });
    child.on('error', (error) => finish({ ok: false, kind: 'processing', message: `compute process failed: ${error.message}` }));
    // A queued result message is delivered before this turn of the loop ends; defer so an exit
    // that follows a successful send is not mistaken for a silent death.
    child.on('exit', (code, signal) => setImmediate(() => finish({ ok: false, kind: 'processing',
      message: `compute process ended without a result (${signal ? `signal ${signal}` : `exit code ${code}`})` })));
    child.send({ type: 'run', request, inputText, deadlineAt });
  });
}

/** Stage every artifact before replacing any destination; roll back the set on an I/O failure. */
function publishArtifacts(entries) {
  for (const [path] of entries) {
    if (existsSync(path) && !lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      throw new Error(`${path} is not a file`);
    }
  }
  const temporary = mkdtempSync(join(dirname(entries[0][0]), '.portograph-'));
  const installed = [], saved = [];
  let removeTemporary = true;
  try {
    for (const [index, [, contents]] of entries.entries()) writeFileSync(join(temporary, `new-${index}`), contents);
    for (const [index, [path]] of entries.entries()) {
      const backup = join(temporary, `old-${index}`);
      // lstat also sees a dangling symlink, which existsSync deliberately does not.
      try { lstatSync(path); renameSync(path, backup); saved.push([path, backup]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      renameSync(join(temporary, `new-${index}`), path);
      installed.push(path);
    }
  } catch (error) {
    try {
      for (const path of installed.reverse()) rmSync(path, { force: true });
      for (const [path, backup] of saved.reverse()) renameSync(backup, path);
    } catch (rollbackError) {
      removeTemporary = false;
      throw new Error(`${error.message}; rollback failed: ${rollbackError.message}; retained backups in ${temporary}`);
    }
    throw error;
  } finally {
    if (removeTemporary) rmSync(temporary, { recursive: true, force: true });
  }
}

function writeArtifacts(command, result, io, library) {
  const { EXIT, sidecarPaths, formatStatus } = library;
  const status = (severity, code, message) => io.err.write(`${formatStatus(command.diagnostics, severity, code, message)}\n`);
  if (command.output === undefined) {
    io.out.write(result.primary);
    if (!result.primary.endsWith('\n')) io.out.write('\n');
  } else {
    try {
      if (result.sidecars) {
        const paths = sidecarPaths(command.output);
        publishArtifacts([[command.output, result.primary], [paths.layout, result.sidecars.layout], [paths.score, result.sidecars.score]]);
        status('info', 'WROTE', `wrote ${command.output}, ${paths.layout}, ${paths.score}`);
      } else {
        publishArtifacts([[command.output, result.primary]]);
        status('info', 'WROTE', `wrote ${command.output}`);
      }
    } catch (error) {
      status('error', 'OUTPUT_FAILED', `cannot write ${command.output}: ${error.message}`);
      return EXIT.inputError;
    }
  }
  if (result.passed === false) {
    status('error', 'GATE_FAILED', 'an enforced gate or assertion failed; see the score report');
    return command.allowGateFailures ? EXIT.ok : EXIT.gateFailure;
  }
  return EXIT.ok;
}

/**
 * Run the CLI on `argv` (without the node and script paths).
 * Writes to `io.out` / `io.err` and returns the process exit code.
 */
export async function main(argv, io = { out: process.stdout, err: process.stderr, in: process.stdin }) {
  const library = await loadLibrary();
  const { COMMAND_DEADLINE_MS, EXIT, formatStatus, helpText, isVerb, parseCommand } = library;
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === '--help' || verb === '-h') {
    io.out.write(helpText());
    return EXIT.ok;
  }
  if (verb === '--version' || verb === '-V') {
    io.out.write(`${version}\n`);
    return EXIT.ok;
  }
  if (!isVerb(verb)) {
    io.err.write(`portograph: unknown verb '${verb}'\n\n${helpText()}`);
    return EXIT.inputError;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out.write(helpText());
    return EXIT.ok;
  }

  let command;
  try {
    command = parseCommand(verb, rest);
  } catch (error) {
    // A caller that asked for JSON gets JSON for a usage error too; the option is read before parsing fails.
    const asJson = rest.includes('--diagnostics=json') || rest.some((argument, index) => argument === '--diagnostics' && rest[index + 1] === 'json');
    if (asJson) io.err.write(`${formatStatus('json', 'error', 'USAGE', error.message)}\n`);
    else io.err.write(`portograph: ${error.message}\n\nRun 'portograph --help' for the full usage.\n`);
    return EXIT.inputError;
  }

  let limitMs;
  try {
    limitMs = deadlineMs(COMMAND_DEADLINE_MS);
  } catch (error) {
    io.err.write(`${error.message}\n`);
    return EXIT.inputError;
  }

  let inputText;
  if (command.input === '-') {
    try {
      inputText = await readAll(io.in);
    } catch (error) {
      io.err.write(`${formatStatus(command.diagnostics, 'error', 'STDIN_FAILED', `cannot read stdin: ${error.message}`)}\n`);
      return EXIT.inputError;
    }
  }

  // Only the CLI looks at the machine's fonts; the library output stays a pure function of the document.
  if ((verb === 'render' || verb === 'layout') && !verdanaInstalled()) {
    io.err.write(`${formatStatus(command.diagnostics, 'warning', 'FONT_MISSING', VERDANA_WARNING, true)}\n`);
  }

  const outcome = await compute(command, io, limitMs, inputText);
  if (outcome.ok) return writeArtifacts(command, outcome.result, io, library);
  io.err.write(`${formatStatus(command.diagnostics, 'error', outcome.code ?? (outcome.kind === 'input' ? 'INVALID_INPUT' : 'FAILED'), outcome.message, Boolean(outcome.code))}\n`);
  return outcome.kind === 'input' ? EXIT.inputError : EXIT.processingFailure;
}
