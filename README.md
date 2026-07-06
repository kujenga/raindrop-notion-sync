# raindrop-notion-sync

A [Notion Worker](https://developers.notion.com/workers/get-started/overview)
that syncs your [Raindrop.io](https://raindrop.io) bookmarks into a Notion
database — one Notion page per bookmark, refreshed on a schedule.

Core metadata (link, tags, type, dates, etc.) maps to database properties, and
the notes and highlights you saved in Raindrop are rendered into each page's
body. Optionally, it can also pull in the **full cleaned article text** for every
bookmark (see [Full article content](#full-article-content-optional)).

The code runs on Notion's own Workers platform — Notion hosts and schedules it
for you, so there's no server to run.

## Requirements

Before you start, you'll need:

- **[Bun](https://bun.sh)** and **Node.js 22+** — to build and deploy.
- A **Notion account** with access to
  [Notion Workers](https://developers.notion.com/workers/get-started/overview)
  (this is where the sync runs). The `ntn` CLI it uses is installed for you by
  `bun install` — nothing to install globally.
- A **Raindrop.io account** and an API **test token** (free; created below).

Optional — only if you want the full-article-content feature:

- **Raindrop Pro**, which enables the "permanent copy" archive the article text
  is extracted from.
- A **[Google Gemini API key](https://aistudio.google.com/apikey)**, used to
  clean the archived HTML into readable Markdown. Gemini usage may incur cost.

## Quickstart

This is the full path from clone to a running, deployed sync.

```bash
git clone https://github.com/kujenga/raindrop-notion-sync.git
cd raindrop-notion-sync
bun install
```

**1. Get a Raindrop token.** Create an app at
[Raindrop integrations settings](https://app.raindrop.io/settings/integrations)
and copy the **Test token** (sufficient for a personal, single-user sync).

**2. Authenticate the Notion CLI.**

```bash
bun run login        # ntn login
```

**3. Configure secrets.** Local commands read from a `.env` file (gitignored):

```bash
cp .env.example .env
# then edit .env and set RAINDROP_TOKEN (and optionally RAINDROP_COLLECTION_ID)
```

`bun run deploy` reads this `.env` and pushes the secrets to the deployed worker
for you — you don't need to set them remotely by hand.

**4. Silence the generated-options file.** The deploy step regenerates
`src/raindrop-options.ts` from your account (this is how `Tags`/`Collection` get
their native chip options). Tell git to ignore your local copy of it, so your
account's tag names never show up as `git status` churn or get committed:

```bash
git update-index --skip-worktree src/raindrop-options.ts
```

This is local git state, so **re-run it after every fresh clone.** See
[Native chips and the deploy-time snapshot](docs/DESIGN.md#native-chips-and-the-deploy-time-snapshot)
for why this file works the way it does.

**5. Deploy.**

```bash
bun run deploy
```

This regenerates the options file, creates the worker on first run, pushes your
`.env` secrets to it, and deploys. On success, Notion creates a database named
**Raindrop Bookmarks**, owned by the worker's bot. Find it via Notion search or
the deploy output, then **move it** into any teamspace or page from the Notion
UI — the worker syncs by database id, so moving or renaming it is safe.

**6. Run it now (optional).** The sync runs on a schedule (daily for metadata),
but you can trigger a run immediately:

```bash
bun run trigger
```

Within a minute or so you should see pages appear in the **Raindrop Bookmarks**
database, one per bookmark. To preview changes without writing anything first,
use `bun run preview`.

## Configuration

| Variable                 | Required | Default | Description                                        |
| ------------------------ | -------- | ------- | -------------------------------------------------- |
| `RAINDROP_TOKEN`         | yes      | —       | Raindrop API token (test or OAuth token).          |
| `RAINDROP_COLLECTION_ID` | no       | `0`     | Collection to sync: `0` = all, `-1` = unsorted, `<id>` = a specific collection. |
| `SYNC_CONTENT`           | no       | `0`     | `1` to also sync the full cleaned article body.    |
| `GEMINI_API_KEY`         | if `SYNC_CONTENT=1` | — | Google Gemini key, used to clean article content.  |

Set these in `.env` for local runs; `bun run deploy` pushes them to the deployed
worker. To change a secret on the deployed worker without a full redeploy:

```bash
ntn workers env set RAINDROP_TOKEN=<your-raindrop-token>
```

`Tags`/`Collection` chip options are **not** env vars — they're generated into
`src/raindrop-options.ts` at deploy time (see
[design notes](docs/DESIGN.md#native-chips-and-the-deploy-time-snapshot)).

The sync **schedules** are set in `src/index.ts`: `raindropSync` (metadata) runs
daily, `contentSync` (article bodies) hourly. Because `raindropSync` re-mirrors
the whole library each run, a frequent schedule is the main cost driver — keep it
infrequent for large libraries.

## What gets synced

Each bookmark becomes one Notion page. Core metadata maps to database properties:

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

The page body holds the Raindrop **note** and **highlights** (when present), and
the page icon is set from the bookmark's cover image. The sync runs in `replace`
mode, so bookmarks removed in Raindrop are removed from Notion too.

### Full article content (optional)

With `SYNC_CONTENT=1` and a `GEMINI_API_KEY` set (see
[Requirements](#requirements)), a second sync also writes the **full article**
into each page body: it fetches the bookmark's Raindrop **permanent copy** (Pro
archive), converts it to Markdown, and uses Gemini to render a clean article —
dropping nav, ads, and boilerplate — under an AI-written summary. It runs
incrementally so it doesn't re-clean unchanged bookmarks. See the
[design notes](docs/DESIGN.md#the-article-content-pipeline) for how the pipeline
and its trade-offs work.

## Scripts

| Command                   | Description                                       |
| ------------------------- | ------------------------------------------------- |
| `bun run preview`         | Local dry-run of the sync (no writes to Notion).  |
| `bun run dev`             | Run the sync locally and write to Notion.         |
| `bun run trigger`         | Trigger the deployed sync to run now.             |
| `bun run deploy`          | Refresh options, then deploy the worker to Notion. |
| `bun run refresh-options` | Refresh `Tags`/`Collection` options from Raindrop. |
| `bun run login`           | Authenticate the Notion CLI.                      |
| `bun run typecheck`       | Type-check with `tsc --noEmit`.                   |

`bun run dev` needs the database to exist, so run it only after the first deploy.
All local commands load `.env`.

## Troubleshooting

- **`ntn: command not found`** — run `bun install` first; `ntn` is a project
  dependency, and the `bun run …` scripts resolve it for you. Invoke it directly
  as `bunx ntn …` if needed.
- **Deploy fails to push secrets / "run `ntn login` first"** — make sure you've
  run `bun run login` and that `RAINDROP_TOKEN` is set in `.env`.
- **`src/raindrop-options.ts` keeps showing up dirty in `git status`** — you
  haven't set `skip-worktree` on it (step 4 above). Re-run
  `git update-index --skip-worktree src/raindrop-options.ts`.
- **`Tags` or `Collection` is missing a chip** for something you added in
  Raindrop recently — options are snapshotted at deploy time. Re-run
  `bun run deploy` to refresh them. The `Tags (raw)` column always has the full
  list in the meantime.
- **Article bodies aren't appearing** with `SYNC_CONTENT=1` — the article comes
  from the Raindrop **permanent copy**, which requires **Raindrop Pro** and can
  take a while to build after a bookmark is saved; the sync retries these.
- **Can't find the database** — Notion creates it named **Raindrop Bookmarks**,
  owned by the worker's bot. Search for it, or check the deploy output.

## Project layout

```
src/
  index.ts               Worker, database schema, and sync registration
  raindrop.ts            Typed Raindrop.io API client
  content.ts             Permanent-copy → clean-article pipeline (Gemini)
  raindrop-options.ts    Generated Tags/Collection options (empty upstream)
scripts/
  refresh-options.ts     Regenerates raindrop-options.ts from Raindrop
docs/
  DESIGN.md              Architecture and design-decision notes
```

## Design notes

For how the sync works internally and why a few non-obvious choices were made
(the deploy-time options snapshot, the incremental article pipeline, where the
database lives), see [docs/DESIGN.md](docs/DESIGN.md).

## Contributing

Issues and pull requests are welcome. This is a small personal-scale project; if
you're filing a bug, include the command you ran and the relevant worker output.

## License

[MIT](./LICENSE)
