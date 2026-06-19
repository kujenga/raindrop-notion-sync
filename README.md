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
Raindrop collection and returns upserts; the Notion Workers runtime handles
creating, updating, and deleting pages so the database mirrors Raindrop. The
sync runs in `replace` mode, so bookmarks removed in Raindrop are removed from
Notion too.

### Database schema

| Notion property | Type           | Raindrop source            |
| --------------- | -------------- | -------------------------- |
| Title           | `title`        | `title`                    |
| Raindrop ID     | `rich_text` 🔑 | `_id` (primary key)        |
| Link            | `url`          | `link`                     |
| Excerpt         | `rich_text`    | `excerpt`                  |
| Tags            | `multi_select` | `tags`                     |
| Type            | `select`       | `type`                     |
| Domain          | `rich_text`    | `domain`                   |
| Important       | `checkbox`     | `important`                |
| Created         | `date`         | `created`                  |
| Last Updated    | `date`         | `lastUpdate`               |

The page body contains the Raindrop **note** and **highlights** (when present),
and the page icon is set from the bookmark cover image.

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
bun run deploy       # deploy the worker (creates the managed database)
bun run trigger      # run the deployed sync now, bypassing the 30m schedule
```

`bun run dev` runs the sync locally and writes to Notion (needs the database to
exist, so run it after the first deploy). All local commands load `.env`.

## Configuration

| Variable                 | Required | Default | Description                               |
| ------------------------ | -------- | ------- | ----------------------------------------- |
| `RAINDROP_TOKEN`         | yes      | —       | Raindrop API token (test or OAuth token). |
| `RAINDROP_COLLECTION_ID` | no       | `0`     | Collection to sync (`0` = all bookmarks). |

The sync schedule (default every 30 minutes) is set in `src/index.ts`.

## Project layout

```
src/
  index.ts      Worker, database schema, and sync registration
  raindrop.ts   Typed Raindrop.io API client
```

## Scripts

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `bun run typecheck` | Type-check with `tsc --noEmit`.                      |
| `bun run preview`   | Local dry-run of the sync (no writes to Notion).     |
| `bun run dev`       | Run the sync locally and write to Notion.            |
| `bun run trigger`   | Trigger the deployed sync to run now.                |
| `bun run deploy`    | Deploy the worker to Notion.                         |
| `bun run login`     | Authenticate the Notion CLI.                         |

## License

[MIT](./LICENSE)
