import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import type { SelectOption } from "@notionhq/workers/types";
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

/**
 * Tag and Collection select options are populated at deploy time from the
 * user's Raindrop account and passed in as JSON env vars by `bun run deploy`
 * (see scripts/refresh-options.ts). They are read here, at module load, so
 * Notion migrates the managed schema with real options on deploy.
 *
 * Why env vars and not a generated source file: this keeps the repository
 * generic for any user (no account-specific data committed) while still
 * giving native multi_select / select columns. The trade-off is that the
 * option lists are a deploy-time snapshot — a tag or collection created in
 * Raindrop after the last deploy has no option yet. The "Tags (raw)" column
 * below is the safety net for that gap; re-running `bun run deploy` refreshes
 * the lists.
 */
function parseOptionsEnv(json: string | undefined): SelectOption[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is SelectOption =>
        typeof o === "object" && o !== null && typeof (o as SelectOption).name === "string",
    );
  } catch {
    return [];
  }
}

function parseMapEnv(json: string | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const TAG_OPTIONS = parseOptionsEnv(process.env.RAINDROP_TAG_OPTIONS);
const COLLECTION_OPTIONS = parseOptionsEnv(process.env.RAINDROP_COLLECTION_OPTIONS);
/** Maps a Raindrop collection id (as a string) to its display name. */
const COLLECTION_NAMES = parseMapEnv(process.env.RAINDROP_COLLECTION_MAP);

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

/** Pace requests under Raindrop's 120 requests/minute limit. */
const raindropPacer = worker.pacer("raindrop", {
  allowedRequests: 120,
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
  schedule: "30m",
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

/** Per-execute work bounds for the content sync. */
const CONTENT_PER_PAGE = 8;
const MAX_MODEL_CALLS_PER_CALL = 8;
const MAX_PENDING = 200;
const EPOCH = "1970-01-01T00:00:00.000Z";

interface ContentState {
  /** Raindrop page index within the current run. */
  page?: number;
  /** `lastUpdate` watermark; items at/below this are considered already done. */
  cursor?: string;
  /** Max `lastUpdate` seen this run; becomes the next run's cursor. */
  maxSeen?: string;
  /** Ids whose permanent copy wasn't ready yet, retried on later runs. */
  pending?: number[];
}

/**
 * Sync cleaned full-article bodies into Notion (`incremental` mode so the
 * cursor persists across runs and each article is cleaned only once). Walks
 * bookmarks newest-first, stops at the cursor, and defers items whose Raindrop
 * permanent copy isn't built yet to a `pending` list retried next run.
 *
 * NOTE: the per-call/per-page bounds below are tuned for correctness and the
 * test collection; revisit them before a full-library backfill once real
 * per-execution timing is known.
 */
worker.sync("contentSync", {
  database: bookmarks,
  mode: "incremental",
  schedule: "1h",
  execute: async (state: ContentState | undefined) => {
    if (!CONTENT_ENABLED) return { changes: [], hasMore: false };
    const token = requireToken();
    const apiKey = GEMINI_API_KEY as string;
    const collectionId = Number(process.env.RAINDROP_COLLECTION_ID ?? "0");

    const page = state?.page ?? 0;
    const cursor = state?.cursor ?? EPOCH;
    let maxSeen = state?.maxSeen ?? cursor;
    let pending = [...(state?.pending ?? [])];
    const changes: ReturnType<typeof buildUpsert>[] = [];
    let modelBudget = MAX_MODEL_CALLS_PER_CALL;

    // Retry previously-deferred items at the start of each run.
    if (page === 0 && pending.length > 0) {
      const stillPending: number[] = [];
      for (const id of pending) {
        const item = await getRaindrop(token, id);
        if (!item) continue; // deleted upstream; the replace sync drops the page
        const result = await buildContentBody(item, token, apiKey, modelBudget > 0);
        if (result.usedModel) modelBudget--;
        if (result.deferred) stillPending.push(id);
        changes.push(buildUpsert(item, result.body));
      }
      pending = stillPending;
    }

    // Scan the delta (bookmarks changed since the cursor), newest first.
    await raindropPacer.wait();
    const items = await getRaindrops(token, collectionId, page, CONTENT_PER_PAGE);
    let reachedEnd = items.length < CONTENT_PER_PAGE;
    for (const item of items) {
      if (item.lastUpdate <= cursor) {
        reachedEnd = true;
        break;
      }
      if (item.lastUpdate > maxSeen) maxSeen = item.lastUpdate;
      const result = await buildContentBody(item, token, apiKey, modelBudget > 0);
      if (result.usedModel) modelBudget--;
      if (result.deferred && pending.length < MAX_PENDING) pending.push(item._id);
      changes.push(buildUpsert(item, result.body));
    }

    const hasMore = !reachedEnd;
    const nextState: ContentState = hasMore
      ? { page: page + 1, cursor, maxSeen, pending }
      : { cursor: maxSeen, pending };
    return { changes, hasMore, nextState };
  },
});

/**
 * Build a bookmark's page body, fetching and cleaning the full article when its
 * Raindrop permanent copy is ready and model budget remains. Falls back to just
 * the annotations, signalling `deferred` so the article is retried later.
 */
async function buildContentBody(
  item: Raindrop,
  token: string,
  apiKey: string,
  allowModel: boolean,
): Promise<{ body: string; deferred: boolean; usedModel: boolean }> {
  const annotations = buildAnnotations(item);
  const archivable = isHttpUrl(item.link);
  const cacheReady = item.cache?.status === "ready";

  if (!archivable || (!cacheReady && item.cache?.status === undefined)) {
    // No article to archive, or Raindrop isn't keeping a copy: annotations only.
    return { body: annotations, deferred: false, usedModel: false };
  }
  if (!cacheReady) {
    // Permanent copy still building — show annotations now, fetch later.
    return { body: annotations, deferred: true, usedModel: false };
  }
  if (!allowModel) {
    return { body: annotations, deferred: true, usedModel: false };
  }

  try {
    await raindropPacer.wait();
    const html = await fetchPermanentCopyHtml(token, item._id);
    if (!html) return { body: annotations, deferred: true, usedModel: false };

    const rough = htmlToRoughMarkdown(html);
    await geminiPacer.wait();
    const extracted = await extractArticle(rough, apiKey, {
      title: item.title,
      url: item.link,
    });
    if (!extracted) {
      // Model ran but returned nothing usable — don't burn budget retrying.
      return { body: annotations, deferred: false, usedModel: true };
    }
    return { body: buildFullBody(item, extracted), deferred: false, usedModel: true };
  } catch (err) {
    console.error(`contentSync: failed to build article for ${item._id}:`, err);
    return { body: annotations, deferred: true, usedModel: false };
  }
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
