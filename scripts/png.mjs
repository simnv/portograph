/**
 * Convert a render (SVG) to a PNG, so an agent can read it.
 *
 * Usage: npm run png -- <in.svg> [out.png] [--width N]
 *
 * The output defaults to the input path with `.png`; the width defaults to 1600 px.
 * System fonts load, so the render's `Arial, Helvetica, sans-serif` resolves to a real face.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { Resvg } from '@resvg/resvg-js';

const DEFAULT_WIDTH = 1600;
const USAGE = 'Usage: npm run png -- <in.svg> [out.png] [--width N]';

const positional = [];
let width = DEFAULT_WIDTH;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--width') {
    width = Number(args[++i]);
  } else {
    positional.push(args[i]);
  }
}
if (positional.length < 1 || positional.length > 2 || !Number.isInteger(width) || width <= 0) {
  console.error(USAGE);
  process.exit(2);
}
const [input, given] = positional;
const output = given ?? input.replace(/\.svg$/i, '') + '.png';

const resvg = new Resvg(readFileSync(input), {
  background: 'white',
  fitTo: { mode: 'width', value: width },
  font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
});
writeFileSync(output, resvg.render().asPng());
console.log(`wrote ${output}`);
