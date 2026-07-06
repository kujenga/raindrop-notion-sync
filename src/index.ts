import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import {
  fetchPermanentCopyHtml,
  getRaindrop,
  getRaindrops,
  PER_PAGE,
  type Raindrop,
} from "./raindrop.js";
import {
  extractArticle,
  htmlToRoughMarkdown,
  type ExtractedArticle,
} from "./content.js";
import {
  COLLECTION_NAMES,
  COLLECTION_OPTIONS,
  TAG_OPTIONS,
} from "./raindrop-options.js";
import type { Schedule } from "@notionhq/workers/types";

const worker = new Worker();
export default worker;

/** Known Raindrop item types, used as fixed select options. */
const RAINDROP_TYPES = [
  "link",
  "article",
  "image",
  "video",
  "document",
  "audio",
] as const;

// TAG_OPTIONS / COLLECTION_OPTIONS / COLLECTION_NAMES come from the generated
// ./raindrop-options module. A managed database can only declare its
// select/multi_select options at deploy time, so `bun run refresh-options`
// (run by `bun run deploy`) regenerates that module from the user's Raindrop
// account; it's compiled into the deployed bundle and read here at module load.
// The trade-off is a deploy-time snapshot: a tag/collection created since the
// last deploy has no option yet — the "Tags (raw)" column is the safety net,
// and re-deploying refreshes the lists.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
/**
 * When enabled, the `contentSync` capability fetches each bookmark's Raindrop
 * permanent copy and stores a cleaned full-article body on the Notion page.
 * Requires a GEMINI_API_KEY. While on, the metadata sync stops writing the
 * page body so it doesn't clobber the richer one contentSync produces.
 */
const CONTENT_ENABLED =
  /^(1|true|yes|on)$/i.test(process.env.SYNC_CONTENT ?? "") &&
  Boolean(GEMINI_API_KEY);

/**
 * Resolve a sync's schedule from an env var, defaulting to `fallback`. Accepts
 * the same forms as the Notion Workers SDK (`Schedule`): "continuous", "manual",
 * or an interval like "30m", "6h", "1d". An unrecognized value warns and falls
 * back rather than throwing, so a typo can't brick the deployed worker (the SDK
 * would otherwise reject it at registration). Changing the schedule takes effect
 * on the next `bun run deploy`, since it's read when the worker module loads.
 */
function scheduleFromEnv(name: string, fallback: Schedule): Schedule {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "continuous" || raw === "manual" || /^\d+[mhd]$/.test(raw)) {
    return raw as Schedule;
  }
  console.warn(
    `Ignoring invalid ${name}="${raw}"; expected "continuous", "manual", or ` +
      `an interval like "30m"/"1h"/"1d". Falling back to "${fallback}".`,
  );
  return fallback;
}

// Metadata (`replace` mode) re-mirrors the whole library each run, so it's the
// main cost driver — default it to daily and let large libraries slow it
// further. The content sync is incremental (cheap), so it defaults to hourly.
// Both are overridable per deploy; see the README's Configuration section.
const METADATA_SCHEDULE = scheduleFromEnv("METADATA_SCHEDULE", "1d");
const CONTENT_SCHEDULE = scheduleFromEnv("CONTENT_SCHEDULE", "1h");

/**
 * Notion database that mirrors Raindrop bookmarks. Notion creates and
 * migrates this database on deploy; rows are matched on "Raindrop ID".
 */
const bookmarks = worker.database("bookmarks", {
  type: "managed",
  initialTitle: "Raindrop Bookmarks",
  primaryKeyProperty: "Raindrop ID",
  schema: {
    databaseIcon: Builder.emojiIcon("🔖"),
    properties: {
      Title: Schema.title(),
      "Raindrop ID": Schema.richText(),
      Link: Schema.url(),
      Excerpt: Schema.richText(),
      // Native multi_select. Options come from the deploy-time tag snapshot
      // (TAG_OPTIONS); a managed schema can't auto-create options at sync time.
      Tags: Schema.multiSelect(TAG_OPTIONS),
      // Safety net: every tag, verbatim and comma-joined, regardless of whether
      // it has a Tags option yet. Guarantees no tag is ever lost between the
      // deploys that refresh the option list.
      "Tags (raw)": Schema.richText(),
      // Native single-select for the bookmark's source collection.
      Collection: Schema.select(COLLECTION_OPTIONS),
      Type: Schema.select(RAINDROP_TYPES.map((name) => ({ name }))),
      Domain: Schema.richText(),
      Important: Schema.checkbox(),
      Created: Schema.date(),
      "Last Updated": Schema.date(),
    },
  },
});

// Raindrop allows 120 requests/minute per token. The metadata and content
// syncs use SEPARATE pacers (never a shared one): a replace-mode metadata sync
// bursts many requests per cycle, and a shared pacer's scheduled-time state
// persists — one sync's burst would stall the other's `wait()` for minutes.
// The two budgets sum to <= 120/min so the account limit is still respected.
const raindropPacer = worker.pacer("raindrop", {
  allowedRequests: 40,
  intervalMs: 60_000,
});

/** Pace the content sync's Raindrop calls (list + permanent-copy fetches). */
const contentApiPacer = worker.pacer("content-api", {
  allowedRequests: 80,
  intervalMs: 60_000,
});

/** Pace Gemini calls used to clean article content. */
const geminiPacer = worker.pacer("gemini", {
  allowedRequests: 60,
  intervalMs: 60_000,
});

interface SyncState {
  page: number;
}

/**
 * Mirror Raindrop metadata into Notion and handle deletions (`replace` mode).
 * When content syncing is on, this leaves the page body alone — `contentSync`
 * owns it — and omitting `pageContentMarkdown` preserves the existing content.
 */
worker.sync("raindropSync", {
  database: bookmarks,
  mode: "replace",
  // Daily by default (METADATA_SCHEDULE): replace mode re-mirrors the whole
  // library each cycle (~78 pages = ~78 billable runs for ~3,900 bookmarks), so
  // a frequent schedule is expensive. Metadata (tags/collection/type) rarely
  // needs sub-day freshness; this also handles deletes via mark-and-sweep.
  // Article bodies stay fresher via contentSync's own (incremental, cheap)
  // schedule.
  schedule: METADATA_SCHEDULE,
  execute: async (state: SyncState | undefined) => {
    const token = requireToken();
    const collectionId = Number(process.env.RAINDROP_COLLECTION_ID ?? "0");
    const page = state?.page ?? 0;

    await raindropPacer.wait();
    const items = await getRaindrops(token, collectionId, page);

    const changes = items.map((item) =>
      buildUpsert(item, CONTENT_ENABLED ? "" : buildAnnotations(item)),
    );

    // A short page means we've reached the end of the collection.
    const hasMore = items.length === PER_PAGE;

    return {
      changes,
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    };
  },
});

function requireToken(): string {
  const token = process.env.RAINDROP_TOKEN;
  if (!token) {
    throw new Error(
      "RAINDROP_TOKEN is not configured. Set it with `ntn workers env set RAINDROP_TOKEN=...`",
    );
  }
  return token;
}

/** Map a bookmark to the Notion property values (shared by both syncs). */
function buildProperties(item: Raindrop) {
  const tags = item.tags ?? [];
  // Only tags that have a corresponding option survive as multi_select chips;
  // the rest are carried by the "Tags (raw)" column until the next deploy
  // refreshes the option list. (Also drop tags containing commas, which the
  // multi_select wire format uses as its option separator.)
  const knownTags = TAG_OPTIONS.length === 0 ? [] : tags.filter((t) => !t.includes(","));
  return {
    Title: Builder.title(item.title || item.link || "(untitled)"),
    "Raindrop ID": Builder.richText(String(item._id)),
    Link: Builder.url(item.link),
    Excerpt: Builder.richText(item.excerpt ?? ""),
    Tags: Builder.multiSelect(...knownTags),
    "Tags (raw)": Builder.richText(tags.join(", ")),
    Collection: Builder.select(collectionName(item.collectionId)),
    Type: Builder.select(item.type || "link"),
    Domain: Builder.richText(item.domain ?? ""),
    Important: Builder.checkbox(Boolean(item.important)),
    Created: Builder.dateTime(item.created),
    "Last Updated": Builder.dateTime(item.lastUpdate),
  };
}

/** Assemble an upsert change. An empty `body` omits page content (preserved). */
function buildUpsert(item: Raindrop, body: string) {
  return {
    type: "upsert" as const,
    key: String(item._id),
    upstreamUpdatedAt: item.lastUpdate,
    ...(isHttpUrl(item.cover) ? { icon: Builder.imageIcon(item.cover) } : {}),
    ...(body ? { pageContentMarkdown: body } : {}),
    properties: buildProperties(item),
  };
}

/** The user's own annotations: note + highlights. */
function buildAnnotations(item: Raindrop): string {
  const sections: string[] = [];

  if (item.note?.trim()) {
    sections.push(`## Note\n\n${item.note.trim()}`);
  }

  const highlights = item.highlights ?? [];
  if (highlights.length > 0) {
    const lines = highlights
      .filter((h) => h.text?.trim())
      .map((h) => {
        const quote = `> ${h.text.trim().replace(/\n/g, "\n> ")}`;
        return h.note?.trim() ? `${quote}\n\n${h.note.trim()}` : quote;
      });
    if (lines.length > 0) {
      sections.push(`## Highlights\n\n${lines.join("\n\n")}`);
    }
  }

  return sections.join("\n\n");
}

/**
 * Full page body when an article has been extracted: a clearly-labelled AI
 * summary, then the user's own notes/highlights, then a divider and the full
 * cleaned article — so the top is a self-contained digest and the original
 * text follows below.
 */
function buildFullBody(item: Raindrop, extracted: ExtractedArticle): string {
  const parts: string[] = [];
  if (extracted.summary) {
    parts.push(`> 🤖 **AI summary:** ${extracted.summary}`);
  }
  const annotations = buildAnnotations(item);
  if (annotations) {
    parts.push(annotations);
  }
  parts.push("---");
  parts.push(`## Article\n\n${extracted.article}`);
  return parts.join("\n\n");
}

/** How many bookmarks to consider per execute call (bounds per-call time). */
const CONTENT_PER_PAGE = 8;
/** Max concurrent Gemini cleanups in flight at once. */
const MODEL_CONCURRENCY = 8;
/** Cap the retry backlog so the persisted state stays small. */
const MAX_PENDING = 500;
/**
 * Skip permanent copies larger than this (gzipped bytes). Multi-MB archives —
 * usually repos/heavy pages, not articles — would block the event loop during
 * synchronous gunzip/parse and time out the execute.
 */
const MAX_CACHE_BYTES = 4_000_000;
const EPOCH = "1970-01-01T00:00:00.000Z";

interface ContentState {
  /** Raindrop page index within the current run. */
  page?: number;
  /** `lastUpdate` watermark; items at/below this aren't re-scanned. */
  cursor?: string;
  /** Max `lastUpdate` seen this run; becomes the next run's cursor. */
  maxSeen?: string;
  /** Ids whose permanent copy wasn't ready yet, retried on later runs. */
  pending?: number[];
  /**
   * id → the permanent copy's `cache.created` time (ms) we last cleaned. Lets a
   * bookmark that's merely been re-touched (a new tag, moved collection) skip
   * the Gemini call entirely — its article is unchanged, so the existing body
   * is left in place. Persists across runs and redeploys with the sync state.
   */
  done?: Record<string, number>;
}

/**
 * Sync cleaned full-article bodies into Notion (`incremental` mode so the
 * cursor and `done` map persist across runs/redeploys). Walks bookmarks
 * newest-first, stops at the cursor, skips articles already cleaned at their
 * current version, cleans the rest with bounded concurrency, and defers items
 * whose permanent copy isn't built yet to a `pending` list retried next run.
 *
 * NOTE: the per-call bounds are tuned for correctness and the test collection;
 * revisit them before a full-library backfill once real timing is known.
 */
worker.sync("contentSync", {
  database: bookmarks,
  mode: "incremental",
  schedule: CONTENT_SCHEDULE, // hourly by default; see CONTENT_SCHEDULE
  execute: async (state: ContentState | undefined) => {
    if (!CONTENT_ENABLED) return { changes: [], hasMore: false };
    const token = requireToken();
    const apiKey = GEMINI_API_KEY as string;
    const collectionId = Number(process.env.RAINDROP_COLLECTION_ID ?? "0");

    const page = state?.page ?? 0;
    const cursor = state?.cursor ?? EPOCH;
    let maxSeen = state?.maxSeen ?? cursor;
    const pending = new Set(state?.pending ?? []);
    const done: Record<string, number> = { ...(state?.done ?? {}) };

    // Gather this call's candidates: a bounded batch of retries (first page of a
    // run) plus the next page of the delta.
    const candidates: Raindrop[] = [];
    if (page === 0 && pending.size > 0) {
      for (const id of [...pending].slice(0, CONTENT_PER_PAGE)) {
        pending.delete(id);
        await contentApiPacer.wait();
        const item = await getRaindrop(token, id);
        if (item) candidates.push(item);
      }
    }
    await contentApiPacer.wait();
    const items = await getRaindrops(token, collectionId, page, CONTENT_PER_PAGE);
    let reachedEnd = items.length < CONTENT_PER_PAGE;
    for (const item of items) {
      if (item.lastUpdate <= cursor) {
        reachedEnd = true;
        break;
      }
      if (item.lastUpdate > maxSeen) maxSeen = item.lastUpdate;
      candidates.push(item);
    }

    // Classify without spending any model calls.
    const changes: ReturnType<typeof buildUpsert>[] = [];
    const toClean: Raindrop[] = [];
    for (const item of candidates) {
      const version = articleVersion(item);
      if (version !== null && done[String(item._id)] === version) {
        continue; // article already synced at this version — leave the body alone
      }
      if (version === null) {
        // No ready permanent copy: write annotations now, and retry the article
        // only if a copy could still be built (skip terminal-failure states so
        // they don't churn in the retry backlog forever).
        if (isArchivePending(item)) pending.add(item._id);
        changes.push(buildUpsert(item, buildAnnotations(item)));
        continue;
      }
      if ((item.cache?.size ?? 0) > MAX_CACHE_BYTES) {
        // Huge archives (tens of MB) block the event loop during gunzip/parse
        // long enough to blow the execution timeout. Skip the article body and
        // mark it done so it isn't retried.
        done[String(item._id)] = version;
        changes.push(buildUpsert(item, buildAnnotations(item)));
        continue;
      }
      toClean.push(item);
    }

    // Clean the article batch with bounded concurrency; defer any overflow.
    for (const item of toClean.slice(CONTENT_PER_PAGE)) {
      pending.add(item._id);
      changes.push(buildUpsert(item, buildAnnotations(item)));
    }
    const results = await mapWithConcurrency(
      toClean.slice(0, CONTENT_PER_PAGE),
      MODEL_CONCURRENCY,
      async (item) => {
        try {
          return { item, extracted: await fetchAndCleanArticle(item, token, apiKey) };
        } catch (err) {
          console.error(`contentSync: article failed for ${item._id}:`, err);
          return { item, extracted: null };
        }
      },
    );
    for (const { item, extracted } of results) {
      if (extracted) {
        changes.push(buildUpsert(item, buildFullBody(item, extracted)));
        done[String(item._id)] = articleVersion(item) as number;
      } else {
        if (pending.size < MAX_PENDING) pending.add(item._id);
        changes.push(buildUpsert(item, buildAnnotations(item)));
      }
    }

    const hasMore = !reachedEnd;
    const nextState: ContentState = hasMore
      ? { page: page + 1, cursor, maxSeen, pending: [...pending], done }
      : { cursor: maxSeen, pending: [...pending], done };
    return { changes, hasMore, nextState };
  },
});

/** A web bookmark that Raindrop can keep a permanent copy of. */
function isArchivable(item: Raindrop): boolean {
  return isHttpUrl(item.link);
}

/**
 * Whether a bookmark's permanent copy is still worth waiting for. Terminal
 * Raindrop statuses ("failed", "invalid-origin", "invalid-timeout", …) never
 * become ready, so they must not be retried; an absent or "retry" status means
 * Raindrop is still working on the copy.
 */
function isArchivePending(item: Raindrop): boolean {
  if (!isArchivable(item) || item.cache?.status === "ready") return false;
  const status = item.cache?.status;
  return status === undefined || status === "retry";
}

/**
 * The version key for a bookmark's archived article: the permanent copy's
 * creation time in ms, or null when there's no ready copy to clean.
 */
function articleVersion(item: Raindrop): number | null {
  if (!isArchivable(item) || item.cache?.status !== "ready" || !item.cache.created) {
    return null;
  }
  const ms = Date.parse(item.cache.created);
  return Number.isNaN(ms) ? null : ms;
}

/** Fetch the permanent copy and clean it into a summary + article. */
async function fetchAndCleanArticle(
  item: Raindrop,
  token: string,
  apiKey: string,
): Promise<ExtractedArticle | null> {
  await contentApiPacer.wait();
  const html = await fetchPermanentCopyHtml(token, item._id);
  if (!html) return null;
  const rough = htmlToRoughMarkdown(html);
  await geminiPacer.wait();
  return extractArticle(rough, apiKey, { title: item.title, url: item.link });
}

/** Map over items with at most `limit` promises in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(workers);
  return results;
}

/**
 * Resolve a Raindrop collection id to its display name. Unknown ids (e.g. a
 * collection created since the last deploy, which has no option yet) fall back
 * to "Unsorted" so the Collection select always receives a valid option.
 */
function collectionName(collectionId: number): string {
  return COLLECTION_NAMES[String(collectionId)] ?? "Unsorted";
}

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}
