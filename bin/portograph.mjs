#!/usr/bin/env node
// Executable shim. It carries the .mjs extension because the package is
// "type": "module" and Node 18.18 (the declared floor) refuses to load an
// extensionless entry point in that context (ERR_UNKNOWN_FILE_EXTENSION).
import { main } from './cli.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
