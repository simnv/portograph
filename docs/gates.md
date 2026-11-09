# Gates: tests and measurements

Four checks tell you what a change does: the test suite, `corpus`, `sweep` and `gate:branch`. This page says how to run each one.

## Tests: `npm test`

Tests run only through `scripts/test-runner.mjs`. Use `npm test`, `npm run test:full`, or `npm test -- <vitest args>` to run named files:

```sh
npm test -- test/pipeline/turn-order.test.ts
```

Never call `vitest run` raw. `npm run lint` fails on a raw `vitest run` in `scripts/` or `package.json`, and `vite.config.ts` refuses a vitest load that does not hold the lock.

`npm test` runs three vitest projects in turn: `default` (parallel), `heavy` and `slow` (one file at a time). `heavyFiles` and `slowFiles` in `vite.config.ts` list the files of the last two. A failing project does not skip the next ones. A test has 30 s in `default`, 180 s in `heavy` and 600 s in `slow`.

The runner starts vitest in its own process group, with `--maxWorkers=$PORTOGRAPH_TEST_WORKERS` (default 1) and a wall-clock limit (`PORTOGRAPH_TEST_TIMEOUT_MS`, default 45 min). On exit, failure, Ctrl-C or timeout, it stops the whole group and checks that no member remains before it frees the lock.

## One heavy job at a time

Tests, `corpus`, `sweep`, `r3` and `gate:branch` take one lock (`/tmp/portograph-test.lock`), so only one heavy job runs on a machine. The lock is a kernel flock, held through `lockf` on macOS and BSD and through `flock` (util-linux) on Linux. A line `waiting for the test lock (pid N, job)` is normal: another job holds the lock, and yours starts when it ends. Run each command in the foreground with a command timeout of 60 min or more.

Before a heavy job starts, the runner reads free memory and the load. If free memory is below `PORTOGRAPH_MIN_FREE_PCT` (default 20) or the load is above `PORTOGRAPH_MAX_LOAD` (default 2 x CPU count), the job waits and prints `waiting for the host`. After 15 min (`PORTOGRAPH_ADMIT_WAIT_MS`) it fails.

Stuck lock: a message says that the processes of the previous job will not die. Read `/tmp/portograph-test.lock` (JSON), run `kill -9 -- -<pgid>` for its group, and run the job again. You never need to delete the lock file.

## Measure every sheet

`corpus` and `sweep` build `dist/` first and lay out the sheets the way `portograph render` does. A sheet that takes more than 120 s (`PORTOGRAPH_GATE_DEADLINE`, in seconds) becomes a `TIMEOUT after <n> s` row, and the run goes on.

| Command | What it does |
|---|---|
| `npm run corpus -- <out.tsv>` | Lays out and scores every `goldens/**/*.yaml` (`goldens/synthetic/stage-inputs.yaml` is test data and is skipped). One TSV line per sheet. |
| `npm run sweep -- <out.txt> [--only a,b]` | Lays out every `test/fixtures/sweep/*.yaml`. One line per sheet with the removed links. Prints `N removed of M`. |
| `npm run gate:compare -- <base.tsv> <head.tsv>` | Reads two corpus files. Prints the changed cells side by side and flags every sheet that is worse. |
| `npm run r3 -- <sheet.yaml>...` | The R3 check (see `CODING_STANDARDS.md`): lays each sheet out as written, with `links` reversed and with `nodes` reversed. Prints `SAME` or the first differing JSON path. |

The corpus file has a header line and these columns: `file Q X Xf W gates warn routed fb edge ob bends side removed labelBorder track hash`. Every number is the scorer's. `Q` is the score; it is printed and never judged. `gates` lists the error gates with a violation, or `-`. `bends` counts the real bends of every kept link. `removed` counts the links that stage 8 removed. `hash` is 12 hex digits of the sha256 of the layout JSON; any geometry change moves it.

A sheet that fails to lay out gets `<file>\tERROR <message>`.

`gate:compare` marks `WORSE` a cell that judges a sheet worse, in this order: `error`, `bends`, `removed`, `gates`, `crossings`, `canvas`, `labelBorder`, `track`. A sheet that only the head has is judged on its own: an `ERROR` or `TIMEOUT` row, a `gates` cell that is not `-`, or `removed` above 0 marks it `NEW-FAIL`.

## Before a merge request: `gate:branch`

From the branch worktree, one command does the whole check:

```sh
npm run gate:branch -- [--skip-tests] [--allow-canvas] [--strict]
```

It refuses a dirty tree and merges `main` into the branch (a conflict stops it). Then it runs typecheck, lint and `npm test`. It measures `main` and the branch with `corpus` and `sweep`, prints the `gate:compare` result and the sweep difference, and runs R3 on the sheets whose hash changed. It ends with exactly `GATE PASS` or `GATE FAIL: <reasons>`.

It fails on any `WORSE` row (a row that only changes the canvas passes unless `--strict`), on any link that the sweep removes and `main` keeps, on an R3 `links` difference, and on a typecheck, lint or test failure. Use `--skip-tests` for a change that touches only documents.

## Measure a branch by hand

Lay out `main` from a second worktree, so the branch stays in place:

```sh
git worktree add --detach .claude/worktrees/gate-main main
(cd .claude/worktrees/gate-main && npm run corpus -- /tmp/pg-main.tsv && npm run sweep -- /tmp/pg-main-sweep.txt)
npm run corpus -- /tmp/pg-head.tsv
npm run sweep -- /tmp/pg-head-sweep.txt
npm run gate:compare -- /tmp/pg-main.tsv /tmp/pg-head.tsv
diff /tmp/pg-main-sweep.txt /tmp/pg-head-sweep.txt
git worktree remove .claude/worktrees/gate-main
```

Merge `main` into the branch first, so the two differ by the branch alone. Keep the base worktree inside the repository checkout: it finds `node_modules` by walking up. Never symlink or commit `node_modules`.

## GitHub workflows

- `ci.yml` runs on a push to `main` and on each pull request, on Node 22 and 24: typecheck, lint, `npm test`, the build, and a render of `goldens/m1-sip-edge.yaml` that it uploads as an artifact. The runners get Verdana from `ttf-mscorefonts-installer`.
- `gate.yml` runs `npm run gate:branch` on a branch that you pick, by hand only (Actions, gate, Run workflow). It compares the branch with `origin/main` and uploads the log and the corpus and sweep files.
- `release.yml` runs on a tag `v<version>` that equals the `package.json` version. It runs the `ci.yml` checks, publishes to npm with trusted publishing (no token), and creates a GitHub release with generated notes.
