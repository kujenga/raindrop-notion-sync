# raindrop-notion-sync

A [Notion Worker](https://developers.notion.com/workers/get-started/overview)
that syncs your [Raindrop.io](https://raindrop.io) bookmarks into a Notion
database — one Notion page per bookmark, refreshed on a schedule.

Notes and highlights saved in Raindrop are rendered into each page's body, and
core metadata (link, tags, type, dates, etc.) is mapped to database properties.

## How it works

```
Raindrop REST API ──fetch──▶ worker.sync("raindropSync") ──upserts──▶ Notion managed database
```

The worker registers a single `sync` capability. On each run it pages through a
Raindrop collection (collection `0` = every collection) and returns upserts; the
Notion Workers runtime handles creating, updating, and deleting pages so the
database mirrors Raindrop. The sync runs in `replace` mode, so bookmarks removed
in Raindrop are removed from Notion too.

### Database schema

| Notion property | Type           | Raindrop source                  |
| --------------- | -------------- | -------------------------------- |
| Title           | `title`        | `title`                          |
| Raindrop ID     | `rich_text` 🔑 | `_id` (primary key)              |
| Link            | `url`          | `link`                           |
| Excerpt         | `rich_text`    | `excerpt`                        |
| Tags            | `multi_select` | `tags`                           |
| Tags (raw)      | `rich_text`    | `tags` (comma-joined, see below) |
| Collection      | `select`       | `collectionId` → collection name |
| Type            | `select`       | `type`                           |
| Domain          | `rich_text`    | `domain`                         |
| Important       | `checkbox`     | `important`                      |
| Created         | `date`         | `created`                        |
| Last Updated    | `date`         | `lastUpdate`                     |

The page body contains the Raindrop **note** and **highlights** (when present),
and the page icon is set from the bookmark cover image.

### Full article content (optional)

With `SYNC_CONTENT=1` and a `GEMINI_API_KEY`, a second `incremental` sync
(`contentSync`) also writes the **full article** into each page body. For each
bookmark it fetches the Raindrop **permanent copy** (Pro archive), converts the
HTML to Markdown, and asks `gemini-3.1-flash-lite` to render a clean article —
dropping nav, ads, and boilerplate. The page body is then laid out as:

```
> 🤖 AI summary: …        (model-written, clearly labelled)
## Note / ## Highlights    (your own annotations)
---
## Article                 (the full cleaned text)
```

Because articles are expensive to fetch and clean, `contentSync` runs
incrementally and avoids redundant work:

- It walks bookmarks newest-first and keeps a **cursor**, so unchanged bookmarks
  aren't re-scanned (this persists across runs and redeploys).
- It records each cleaned article's permanent-copy version, so a bookmark that's
  merely re-touched (a new tag, a moved collection) **skips the model call** —
  the existing body is left in place. An article is re-cleaned only when its
  permanent copy is rebuilt.
- It cleans a batch with **bounded concurrency** (up to 8 model calls at once).
- It retries bookmarks whose permanent copy isn't built yet.

While content syncing is on, the metadata sync stops writing the page body so the
two don't conflict. One trade-off of cleaning an article only once: notes or
highlights added **after** its article has been synced won't appear in the body
until the article is re-cleaned (e.g. the page is re-archived).

#### Native chips and the deploy-time snapshot

`Tags` and `Collection` are native Notion `multi_select` / `select` columns. A
**managed** Notion database can only declare its select options at **deploy
time** — Notion won't auto-create options when a sync writes an unknown value.
So `bun run deploy` first runs `bun run refresh-options`, which fetches your
current tags and collections from Raindrop and writes them into
`src/raindrop-options.ts` — a generated module compiled into the deployed
bundle and read by the schema. It's committed **empty** upstream (so the repo
stays generic) and filled in by your own deploy; it holds only tag/collection
names, no secrets. To keep the local churn out of `git status`, run
`git update-index --skip-worktree src/raindrop-options.ts`.

The trade-off: a tag or collection created in Raindrop **after** your last
deploy has no option yet. The **`Tags (raw)`** column is the safety net — it
always carries every tag verbatim, so nothing is lost; re-deploy to refresh the
chips.

### Where the database lives

There is no way to choose the database's location in code — Notion creates it,
owned by the worker's bot, on first deploy. Find it via search or the deploy
output, then **move it** into any teamspace or page from the Notion UI. The
worker syncs by database id, so moving or renaming it is safe.

## Getting started

Requires [Bun](https://bun.sh) and Node.js 22+.

```bash
bun install
```

### 1. Get a Raindrop token

Create an app at
[Raindrop integrations settings](https://app.raindrop.io/settings/integrations)
and copy the **Test token** (sufficient for a personal, single-user sync).

### 2. Authenticate the Notion CLI

```bash
bun run login        # ntn login
```

### 3. Configure secrets

For **local** runs, secrets are read from a `.env` file (gitignored — see
`.env.example`):

```bash
cp .env.example .env
# then edit .env and set RAINDROP_TOKEN (and optionally RAINDROP_COLLECTION_ID)
```

For the **deployed** worker, set secrets as remote environment variables (only
works after the worker exists — i.e. after the first `bun run deploy`):

```bash
ntn workers env set RAINDROP_TOKEN=<your-raindrop-token>

# Optional — which collection to sync (default: 0 = all bookmarks)
#   0 = all, -1 = unsorted, <id> = a specific collection
ntn workers env set RAINDROP_COLLECTION_ID=0
```

### 4. Preview, run locally, and deploy

```bash
bun run preview      # local dry-run: prints the computed changes, writes nothing
bun run deploy       # refresh tag/collection options, then deploy the worker
bun run trigger      # run the deployed sync now, bypassing the 30m schedule
```

`bun run deploy` runs `bun run refresh-options` first (fetches your tags +
collections from Raindrop, writes them to `.env`, and pushes them to the
deployed worker) so the `Tags` and `Collection` columns get native options. Re-
run `bun run deploy` whenever you want those option lists refreshed.

`bun run dev` runs the sync locally and writes to Notion (needs the database to
exist, so run it after the first deploy). All local commands load `.env`.

## Configuration

| Variable                      | Required | Default | Description                                       |
| ----------------------------- | -------- | ------- | ------------------------------------------------- |
| `RAINDROP_TOKEN`              | yes      | —       | Raindrop API token (test or OAuth token).         |
| `RAINDROP_COLLECTION_ID`      | no       | `0`     | Collection to sync (`0` = all bookmarks).         |
| `SYNC_CONTENT`                | no       | `0`     | `1` to sync the full cleaned article body.        |
| `GEMINI_API_KEY`              | if above | —       | Google Gemini key, used to clean article content. |

(`Tags`/`Collection` options are not env vars — they're generated into
`src/raindrop-options.ts`; see above.)

Sync schedules are set in `src/index.ts`: `raindropSync` (metadata) runs daily,
`contentSync` (article bodies) hourly. Because `raindropSync` re-mirrors the
whole library each run, a frequent schedule is the main cost driver — keep it
infrequent for large libraries.

## Project layout

```
src/
  index.ts               Worker, database schema, and sync registration
  raindrop.ts            Typed Raindrop.io API client
  content.ts             Permanent-copy → clean-article pipeline (Gemini)
  raindrop-options.ts    Generated Tags/Collection options (empty upstream)
scripts/
  refresh-options.ts     Regenerates raindrop-options.ts from Raindrop
```

## Scripts

| Command                  | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `bun run typecheck`      | Type-check with `tsc --noEmit`.                        |
| `bun run preview`        | Local dry-run of the sync (no writes to Notion).       |
| `bun run dev`            | Run the sync locally and write to Notion.              |
| `bun run trigger`        | Trigger the deployed sync to run now.                  |
| `bun run refresh-options`| Refresh `Tags`/`Collection` options from Raindrop.     |
| `bun run deploy`         | Refresh options, then deploy the worker to Notion.     |
| `bun run login`          | Authenticate the Notion CLI.                           |

## License

[MIT](./LICENSE)
