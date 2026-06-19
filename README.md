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

```bash
ntn workers env set RAINDROP_TOKEN=<your-raindrop-token>

# Optional — which collection to sync (default: 0 = all bookmarks)
#   0 = all, -1 = unsorted, <id> = a specific collection
ntn workers env set RAINDROP_COLLECTION_ID=0
```

For local testing you also need a Notion API token
(`ntn workers env set NOTION_API_TOKEN=ntn_...`). See `.env.example`.

### 4. Run locally and deploy

```bash
bun run dev          # ntn workers dev   — test the sync locally
bun run deploy       # ntn workers deploy
```

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

| Command             | Description                     |
| ------------------- | ------------------------------- |
| `bun run typecheck` | Type-check with `tsc --noEmit`. |
| `bun run dev`       | Run the worker locally.         |
| `bun run deploy`    | Deploy the worker to Notion.    |
| `bun run login`     | Authenticate the Notion CLI.    |

## License

[MIT](./LICENSE)
