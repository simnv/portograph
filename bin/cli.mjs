// portograph command line. Plain JavaScript: it loads the built library from
// dist/ at run time, so `npm run build` must run before the CLI is usable.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

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

/**
 * Run the CLI on `argv` (without the node and script paths).
 * Writes to `io.out` / `io.err` and returns the process exit code.
 */
export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const { EXIT, helpText, isVerb } = await loadLibrary();
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

  io.err.write(`portograph ${verb}: not implemented\n`);
  return EXIT.notImplemented;
}
