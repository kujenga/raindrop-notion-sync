# Design notes

Background on how the sync works internally and why a few non-obvious choices
were made. You don't need any of this to run the project — see the
[README](../README.md) for setup. This is for people modifying the code or
curious about the trade-offs.

## Sync architecture

The worker registers two independent `sync` capabilities:

- **`raindropSync`** (metadata) — the always-on sync. It pages through a
  Raindrop collection and returns upserts; the Notion Workers runtime creates,
  updates, and deletes pages so the database mirrors Raindrop. It runs in
  `replace` mode, so a bookmark removed in Raindrop is removed from Notion too
  (mark-and-sweep). Schedule: `METADATA_SCHEDULE`, default **daily** (`1d`).
- **`contentSync`** (article bodies) — optional, enabled with `SYNC_CONTENT=1`.
  It writes the full cleaned article into each page body. Schedule:
  `CONTENT_SCHEDULE`, default **hourly** (`1h`).

`replace` mode re-mirrors the whole library every cycle, so its cost scales with
library size, not with how much changed. That's why `raindropSync` defaults to
daily rather than every few minutes: for ~3,900 bookmarks a run pages through
~78 requests, and a frequent schedule multiplies that for metadata that rarely
needs sub-day freshness. Article bodies stay fresher through `contentSync`'s own
incremental, cheap schedule. The two schedules are independent and configurable
per deploy (see the README's Configuration section) precisely because their
costs differ this much — collapsing them to one value would force either stale
articles or an expensive metadata re-mirror.

### Freshness contract

The schedules produce a deliberate asymmetry worth knowing:

- **Content sync off (default):** `contentSync` is a no-op, so *everything* —
  new bookmarks, edits, and deletions — surfaces on the metadata schedule
  (daily by default). If you want new bookmarks to appear faster, shorten
  `METADATA_SCHEDULE`, but remember every run re-mirrors the whole library.
- **Content sync on:** a new bookmark's page (metadata + article) appears on the
  content schedule (hourly) — `contentSync` upserts full properties too, not just
  the body. But **deletions** and **metadata-only edits** (a retag or moved
  collection on an already-cleaned bookmark) still wait for the daily `replace`
  pass: incremental mode has no mark-and-sweep, and an unchanged article version
  is skipped before any metadata is written.

When content syncing is on, `raindropSync` stops writing the page body (it omits
`pageContentMarkdown`) so the two capabilities don't clobber each other —
`contentSync` owns the body.

## The article content pipeline

For each bookmark, `contentSync`:

1. Fetches the Raindrop **permanent copy** (the Pro archive of the page).
2. Converts the archived HTML to Markdown.
3. Asks `gemini-3.1-flash-lite` to render a clean article — dropping nav, ads,
   and boilerplate — plus a short AI summary.

The page body is then laid out as:

```
> 🤖 AI summary: …        (model-written, clearly labelled)
## Note / ## Highlights    (your own annotations)
---
## Article                 (the full cleaned text)
```

Articles are expensive to fetch and clean, so the pipeline avoids redundant
work:

- It walks bookmarks **newest-first and keeps a cursor**, so unchanged bookmarks
  aren't re-scanned. The cursor persists across runs and redeploys.
- It records each cleaned article's **permanent-copy version**. A bookmark that's
  merely re-touched (a new tag, a moved collection) **skips the model call** —
  the existing body is left in place. An article is re-cleaned only when its
  permanent copy is rebuilt.
- It cleans a batch with **bounded concurrency** (up to 8 model calls at once).
- It **retries** bookmarks whose permanent copy isn't built yet.

**Trade-off:** because an article is cleaned only once (until its permanent copy
is rebuilt), notes or highlights added *after* its article has been synced won't
appear in the body until the article is re-cleaned — e.g. by re-archiving the
page in Raindrop.

## Native chips and the deploy-time snapshot

`Tags` and `Collection` are native Notion `multi_select` / `select` columns. A
**managed** Notion database can only declare its select options at **deploy
time** — Notion won't auto-create an option when a sync writes an unknown value.
So `bun run deploy` first runs `bun run refresh-options`, which fetches your
current tags and collections from Raindrop and writes them into
`src/raindrop-options.ts` — a generated module that `tsc` compiles into the
deployed bundle and the schema reads.

**Trade-off:** a tag or collection created in Raindrop *after* your last deploy
has no chip option yet. The **`Tags (raw)`** column is the safety net — it always
carries every tag verbatim, so nothing is lost; re-deploy to refresh the chips.

### Why `raindrop-options.ts` is tracked-but-empty + `skip-worktree`

That module holds one account's tag/collection names, so it looks like something
you'd `.gitignore` or move into env vars. Both break, because of how
`ntn workers deploy` works:

- **The deploy archive is packed from git-tracked files.** `ntn` runs the
  equivalent of `git ls-files --exclude-standard`, then reads each listed file
  from disk. A **gitignored** file is excluded from the upload, so the deployed
  schema would compile with **empty** options. The file therefore has to be
  tracked — and since `ntn` reads the *working-tree* copy, the real options it
  holds on your machine are what get bundled.
- **The remote build runs on npm/node, not bun.** `ntn` uploads the source and
  runs `npm install` → `npm run build` in the cloud, so there's no bun-based
  "generate on install" escape hatch to materialize an untracked file remotely.
- **Env vars were rejected** because that would mix machine-generated option
  blobs into the same `.env` as your hand-edited secrets.

The design that satisfies all of this: keep `src/raindrop-options.ts` **tracked
but committed empty** (so the repo stays generic and holds no account data), and
run `git update-index --skip-worktree src/raindrop-options.ts` so your locally
generated copy — real options, filled by every `bun run deploy` — is what gets
packed and uploaded, while never showing up as `git status` churn. It holds only
tag/collection names, never secrets.

`skip-worktree` is **local git state**, not shared. After a fresh `git clone` you
must set it once (the [README](../README.md) quickstart includes this step);
otherwise the first `bun run deploy` fills the tracked-empty file and leaves the
tree dirty.

## Where the database lives

There is no way to choose the database's location in code — Notion creates it,
owned by the worker's bot, on the first deploy. Find it via Notion search or the
deploy output, then **move it** into any teamspace or page from the Notion UI.
The worker syncs by database id, so moving or renaming it is safe.
