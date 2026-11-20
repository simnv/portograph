/**
 * Before and after pictures of the sheets that two corpus TSVs judge most worse and most better (retro 2026-11, ticket 04). A change of a
 * default goes to the owner with these pairs, not with counts alone: the counts can hide a defect that one picture shows.
 *
 * Usage: npm run gate:pairs -- <base.tsv> <head.tsv> [--top 6] [--out <dir>] [--base-bin <bin>] [--head-bin <bin>] [--width 1600]
 *
 * The selection is `gate-pairs-lib.mjs`: the judgement of `gate:compare`, ranked by error, bends, removed, gates, crossings, then canvas
 * area. Each selected sheet is rendered twice with `portograph render`: `<name>.before.svg` with the base bin and `<name>.after.svg` with the
 * head bin, each from the sheet file of the bin's own checkout, then converted to PNG by `scripts/png.mjs`. `index.html` shows the pairs side
 * by side, one caption per pair from the TSV cells.
 *
 * A bin is `bin/portograph.mjs` of a checkout with a built `dist/` (`npm run build`). `--base-bin` and `--head-bin` default to the env
 * `PORTOGRAPH_PAIRS_BASE_BIN` and `PORTOGRAPH_PAIRS_HEAD_BIN`. With one bin, only that side renders: run again with the other bin and the same
 * `--out` to add the other side (the second run checks that it reads the same two TSVs). `index.html` is written after every run and names a
 * picture that is not there yet.
 * `--out` defaults to `$XDG_CACHE_HOME/portograph/gate-pairs/<base>--<head>` (`~/.cache` without XDG_CACHE_HOME).
 *
 * The rows are the file paths the TSV names, relative to the checkout: corpus rows (`goldens/**`) and any other sheet path, such as a sweep
 * input under `test/fixtures/sweep/`. The text output of `npm run sweep` is no TSV and is not read.
 * It runs under the host-wide test lock (`scripts/with-lock.mjs`), as the other heavy gate scripts do.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { CorpusTsvError, ROOT, withGateLock } from './gate-lib.mjs';
import { caption, pictureName, selectPairs } from './gate-pairs-lib.mjs';

const USAGE = 'usage: npm run gate:pairs -- <base.tsv> <head.tsv> [--top 6] [--out <dir>] [--base-bin <bin>] [--head-bin <bin>] [--width 1600]';
/** The longest one render may take before it is stopped and shown as failed: a guard against a hang, not a measure. */
const RENDER_LIMIT_MS = 10 * 60_000;

function argumentsOf(argv) {
  const options = { top: 6, width: 1600, out: undefined, baseBin: process.env.PORTOGRAPH_PAIRS_BASE_BIN || undefined, headBin: process.env.PORTOGRAPH_PAIRS_HEAD_BIN || undefined };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = () => { const next = argv[++index]; if (next === undefined) throw new CorpusTsvError(USAGE); return next; };
    if (name === '--top') options.top = Number(value());
    else if (name === '--width') options.width = Number(value());
    else if (name === '--out') options.out = resolve(value());
    else if (name === '--base-bin') options.baseBin = resolve(value());
    else if (name === '--head-bin') options.headBin = resolve(value());
    else if (name.startsWith('--')) throw new CorpusTsvError(`unknown option ${name}; ${USAGE}`);
    else positional.push(resolve(name));
  }
  if (positional.length !== 2 || !Number.isInteger(options.top) || options.top < 1 || !Number.isInteger(options.width) || options.width < 1) throw new CorpusTsvError(USAGE);
  if (options.baseBin === undefined && options.headBin === undefined) throw new CorpusTsvError(`no bin: give --base-bin, --head-bin or both (or PORTOGRAPH_PAIRS_BASE_BIN, PORTOGRAPH_PAIRS_HEAD_BIN); ${USAGE}`);
  const [base, head] = positional;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  options.out ??= join(cache, 'portograph', 'gate-pairs', `${basename(base, '.tsv')}--${basename(head, '.tsv')}`);
  return { base, head, ...options };
}

/** The checkout of a bin (`<checkout>/bin/portograph.mjs`), refused when its `dist/` is not built (R6: no picture from a stale or absent build). */
function checkoutOf(bin, side) {
  const checkout = dirname(dirname(bin));
  if (!existsSync(bin)) throw new CorpusTsvError(`the ${side} bin ${bin} does not exist`);
  if (!existsSync(join(checkout, 'dist', 'portograph.js'))) throw new CorpusTsvError(`the ${side} checkout ${checkout} has no dist/; run npm run build there`);
  return checkout;
}

/**
 * Render one sheet with one bin and convert it to PNG. Returns undefined, or a note: why there is no picture, or what the render said when it
 * wrote the picture and exited non-zero (exit 1: an enforced gate failed, and the SVG shows it).
 */
function picture(bin, checkout, file, svg, width) {
  const sheet = join(checkout, file);
  // A picture of an earlier run never stands for this one.
  for (const old of [svg, svg.replace(/\.svg$/, '.png')]) rmSync(old, { force: true });
  if (!existsSync(sheet)) return `the sheet is not in ${checkout}`;
  const render = spawnSync(process.execPath, [bin, 'render', sheet, '--output', svg], { cwd: checkout, encoding: 'utf8', timeout: RENDER_LIMIT_MS });
  const said = (render.stderr ?? '').trim().split('\n').at(-1) ?? '';
  if (render.status !== 0 && !existsSync(svg)) return `render failed (${render.error?.message ?? `exit ${render.status}`}): ${said}`;
  const png = spawnSync(process.execPath, [join(ROOT, 'scripts', 'png.mjs'), svg, svg.replace(/\.svg$/, '.png'), '--width', String(width)], { cwd: ROOT, encoding: 'utf8' });
  if (png.status !== 0) return `png failed: ${(png.stderr ?? '').trim().split('\n').at(-1) ?? ''}`;
  return render.status === 0 ? undefined : `render exit ${render.status}: ${said}`;
}

const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** One side of a pair in the page: the PNG linked to its SVG with the note of its render, or the reason there is no picture. */
function cell(out, name, side, notes) {
  const png = `${name}.${side}.png`, svg = `${name}.${side}.svg`;
  const note = notes[`${name}.${side}`];
  const body = existsSync(join(out, png))
    ? `<a href="${escape(svg)}"><img src="${escape(png)}" alt="${escape(`${name} ${side}`)}"></a>${note === undefined ? '' : `<p class="none">${escape(note)}</p>`}`
    : `<p class="none">${escape(note ?? 'no picture yet: run gate:pairs with the bin of this side')}</p>`;
  return `<figure><figcaption>${side}</figcaption>${body}</figure>`;
}

function page(options, selection, notes) {
  const section = (title, pairs, count) => [
    `<h2>${escape(title)}: the top ${pairs.length} of ${count}</h2>`,
    ...pairs.map((pair) => {
      const name = pictureName(pair.file);
      return `<section><h3>${escape(pair.file)} <span class="flags">${escape(pair.flags.join(', '))}</span></h3><p class="caption">${escape(caption(pair))}</p><div class="pair">${cell(options.out, name, 'before', notes)}${cell(options.out, name, 'after', notes)}</div></section>`;
    }),
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>gate:pairs ${escape(basename(options.base))} to ${escape(basename(options.head))}</title>
<style>
body { font-family: Verdana, sans-serif; margin: 1.5em; color: #222; }
h3 { margin-bottom: 0.2em; font-size: 1em; } .flags { color: #a33; font-weight: normal; } .caption { margin-top: 0; color: #555; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1em; align-items: start; }
figure { margin: 0; border: 1px solid #ddd; padding: 0.5em; } figcaption { font-weight: bold; margin-bottom: 0.3em; }
img { max-width: 100%; height: auto; } .none { color: #a33; }
</style></head><body>
<h1>Before and after</h1>
<p>Base <code>${escape(options.base)}</code>, head <code>${escape(options.head)}</code>. The judgement of <code>gate:compare</code>: ${selection.counts.worse} sheets worse, ${selection.counts.better} better; ${selection.left.length} left out (in one file only, or failing in both).</p>
${section('Worse', selection.worse, selection.counts.worse)}
${section('Better', selection.better, selection.counts.better)}
</body></html>
`;
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const selection = selectPairs(options.base, options.head, options.top);
  mkdirSync(options.out, { recursive: true });
  // One output directory holds the pictures of one pair of TSVs: a second run (the other bin) must read the same two files.
  const record = join(options.out, 'pairs.json');
  const wanted = { base: options.base, head: options.head, top: options.top };
  if (existsSync(record)) {
    const had = JSON.parse(readFileSync(record, 'utf8'));
    if (had.base !== wanted.base || had.head !== wanted.head || had.top !== wanted.top) throw new CorpusTsvError(`${options.out} holds the pictures of ${had.base} to ${had.head} (top ${had.top}); give another --out`);
  }
  writeFileSync(record, `${JSON.stringify(wanted, null, 2)}\n`);
  const sides = [['before', options.baseBin], ['after', options.headBin]].filter(([, bin]) => bin !== undefined).map(([side, bin]) => [side, bin, checkoutOf(bin, side)]);
  const notesFile = join(options.out, 'notes.json');
  const notes = existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, 'utf8')) : {};
  const pairs = [...selection.worse, ...selection.better];
  for (const [index, pair] of pairs.entries()) {
    const name = pictureName(pair.file);
    for (const [side, bin, checkout] of sides) {
      process.stderr.write(`gate:pairs: ${index + 1}/${pairs.length} ${side} ${pair.file}\n`);
      const note = picture(bin, checkout, pair.file, join(options.out, `${name}.${side}.svg`), options.width);
      if (note === undefined) delete notes[`${name}.${side}`];
      else { notes[`${name}.${side}`] = note; process.stderr.write(`gate:pairs: ${pair.file} ${side}: ${note}\n`); }
    }
  }
  writeFileSync(notesFile, `${JSON.stringify(notes, null, 2)}\n`);
  const index = join(options.out, 'index.html');
  writeFileSync(index, page(options, selection, notes));
  process.stdout.write(`gate:pairs: ${selection.worse.length} worse and ${selection.better.length} better pairs (of ${selection.counts.worse} and ${selection.counts.better}); rendered ${sides.map(([side]) => side).join(' and ')}\n${index}\n`);
}

try {
  await withGateLock(main);
} catch (error) {
  if (!(error instanceof CorpusTsvError)) throw error;
  process.stderr.write(`gate:pairs: ${error.message}\n`);
  process.exitCode = 2;
}
