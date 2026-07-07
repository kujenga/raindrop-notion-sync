# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should start
with the [README](README.md); deeper rationale lives in
[docs/DESIGN.md](docs/DESIGN.md).

## What this is

A [Notion Worker](https://developers.notion.com/workers/get-started/overview)
that syncs Raindrop.io bookmarks into a managed Notion database. It runs on
Notion's Workers platform (Notion hosts and schedules it). TypeScript.
Dependency resolution goes through **npm** — one committed `package-lock.json`,
the same lockfile the **npm/node** remote build uses — while **Bun** is the
local task runner (`bun run …`, `bun scripts/*.ts`).

## Commands

- `npm install` — install dependencies (this also provides the `ntn` CLI). npm
  owns the lockfile; add/remove deps with `npm install <pkg>`, not `bun add`.
  `bun install` still works (it migrates from `package-lock.json`), but only
  npm updates the committed lockfile.
- `bun run typecheck` — `tsc --noEmit`. **Run this before finishing any change**;
  there is no separate test suite.
- `bun run preview` — local dry-run of the sync; prints computed changes, writes
  nothing. Safe way to sanity-check behavior.
- `bun run dev` — run the sync locally and write to Notion (needs the DB to
  exist, i.e. after a first deploy).
- `bun run deploy` — regenerate options, then deploy the worker.
- `bun scripts/test-content.ts [raindropId]` — manual end-to-end check of the
  article-content pipeline against one bookmark (needs `RAINDROP_TOKEN` +
  `GEMINI_API_KEY` in `.env`).

Local commands auto-load `.env`. Deploys and triggers hit real Notion/Raindrop
accounts — prefer `preview` while iterating, and don't deploy or trigger without
the maintainer's say-so.

## Layout

```
src/index.ts             Worker entry: DB schema + the two sync capabilities
src/raindrop.ts          Typed Raindrop.io REST client
src/content.ts           Permanent-copy → clean-article pipeline (Gemini)
src/raindrop-options.ts  GENERATED Tags/Collection options (see gotchas)
scripts/refresh-options.ts  Regenerates raindrop-options.ts from Raindrop
docs/DESIGN.md           Architecture + design-decision rationale
```

The worker registers two `sync` capabilities in `src/index.ts`: `fullSync`
(whole-library mirror, `replace` mode, default daily — the only sync that
deletes) and `incrementalSync` (cursor-based delta pass, default hourly — always
upserts metadata + annotations, and also cleans article bodies when
`SYNC_CONTENT=1`). Schedules are read from `FULL_SYNC_SCHEDULE` /
`INCREMENTAL_SYNC_SCHEDULE` at module load (via `scheduleFromEnv`), so they take
effect on deploy. Note: flipping `SYNC_CONTENT` on restarts the incremental walk
from EPOCH (article backfill) — see the `contentOn` state flag. See
[docs/DESIGN.md](docs/DESIGN.md) for how the syncs interact and the freshness
contract.

## Gotchas — read before editing

- **`src/raindrop-options.ts` is generated, not hand-written.** It's committed
  **empty** upstream and filled in locally by `bun run refresh-options` (run
  automatically by `bun run deploy`). Never edit it by hand, and never commit a
  filled-in copy — it contains one account's tag/collection names. Contributors
  run `git update-index --skip-worktree src/raindrop-options.ts` so their local
  copy stays out of `git status`. If you see it "modified," that's expected; do
  not stage it. Rationale:
  [docs/DESIGN.md](docs/DESIGN.md#why-raindrop-optionsts-is-tracked-but-empty--skip-worktree).
- **Managed Notion DBs declare select/multi_select options only at deploy time.**
  Notion won't auto-create an option when a sync writes an unknown value — that's
  the whole reason the options file exists. Keep this in mind before changing how
  `Tags`/`Collection` are populated.
- **The remote build runs on npm/node, not Bun.** Don't introduce build-time
  reliance on Bun-only APIs; `ntn` runs `npm install` → `npm run build` in the
  cloud from git-tracked files.
- **`package-lock.json` is the single source of truth for dependencies**, and
  npm is the only resolver — so the versions CI (`npm ci`) and the remote build
  (`npm install`) resolve are exactly the ones committed, with no second
  resolver to drift against. There is deliberately no `bun.lock` (it's
  gitignored). Don't edit the lockfile by hand; let `npm install <pkg>` update
  it and commit the result.
- **Secrets** live in `.env` (gitignored) and are pushed to the worker by the
  deploy. Never commit real tokens or a filled `.env`.

## Conventions

- TypeScript is `strict` with `noUncheckedIndexedAccess`. Keep it type-clean;
  `bun run typecheck` must pass.
- Comments explain **why**, not what: non-obvious decisions, workarounds,
  performance choices, platform constraints. Skip comments that restate the code.
- Match the surrounding style, naming, and comment density of the file you're
  editing.
- Keep changes focused; make small, coherent commits with clear messages.
