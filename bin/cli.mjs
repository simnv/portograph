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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
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

/** The deadline a command really gets. The environment override exists so tests can prove the
 * termination path with real computational work instead of waiting half a minute. */
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
function compute(request, io, limitMs) {
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
    child.send({ type: 'run', request, deadlineAt });
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

function writeArtifacts(command, result, io, EXIT, sidecarPaths) {
  if (command.output === undefined) {
    io.out.write(result.primary);
    if (!result.primary.endsWith('\n')) io.out.write('\n');
  } else {
    try {
      if (result.sidecars) {
        const paths = sidecarPaths(command.output);
        publishArtifacts([[command.output, result.primary], [paths.layout, result.sidecars.layout], [paths.score, result.sidecars.score]]);
        io.err.write(`portograph: wrote ${command.output}, ${paths.layout}, ${paths.score}\n`);
      } else {
        publishArtifacts([[command.output, result.primary]]);
        io.err.write(`portograph: wrote ${command.output}\n`);
      }
    } catch (error) {
      io.err.write(`portograph: cannot write ${command.output}: ${error.message}\n`);
      return EXIT.inputError;
    }
  }
  if (result.passed === false) {
    io.err.write('portograph: an enforced gate or assertion failed; see the score report\n');
    return command.allowGateFailures ? EXIT.ok : EXIT.gateFailure;
  }
  return EXIT.ok;
}

/**
 * Run the CLI on `argv` (without the node and script paths).
 * Writes to `io.out` / `io.err` and returns the process exit code.
 */
export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const library = await loadLibrary();
  const { COMMAND_DEADLINE_MS, EXIT, helpText, isVerb, parseCommand, sidecarPaths } = library;
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
    io.err.write(`portograph: ${error.message}\n\nRun 'portograph --help' for the full usage.\n`);
    return EXIT.inputError;
  }

  let limitMs;
  try {
    limitMs = deadlineMs(COMMAND_DEADLINE_MS);
  } catch (error) {
    io.err.write(`${error.message}\n`);
    return EXIT.inputError;
  }

  const outcome = await compute(command, io, limitMs);
  if (outcome.ok) return writeArtifacts(command, outcome.result, io, EXIT, sidecarPaths);
  if (outcome.code) io.err.write(`portograph: error: ${outcome.code}: ${outcome.message}\n`);
  else io.err.write(`portograph: ${outcome.message}\n`);
  return outcome.kind === 'input' ? EXIT.inputError : EXIT.processingFailure;
}
