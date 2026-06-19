import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import type { SelectOption } from "@notionhq/workers/types";
import { getRaindrops, PER_PAGE, type Raindrop } from "./raindrop.js";

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

interface SyncState {
  page: number;
}

worker.sync("raindropSync", {
  database: bookmarks,
  mode: "replace",
  schedule: "30m",
  execute: async (state: SyncState | undefined) => {
    const token = process.env.RAINDROP_TOKEN;
    if (!token) {
      throw new Error(
        "RAINDROP_TOKEN is not configured. Set it with `ntn workers env set RAINDROP_TOKEN=...`",
      );
    }
    const collectionId = Number(process.env.RAINDROP_COLLECTION_ID ?? "0");
    const page = state?.page ?? 0;

    await raindropPacer.wait();
    const items = await getRaindrops(token, collectionId, page);

    const changes = items.map((item) => {
      const markdown = buildPageMarkdown(item);
      const tags = item.tags ?? [];
      // Only tags that have a corresponding option survive as multi_select
      // chips; the rest are carried by the "Tags (raw)" column until the next
      // deploy refreshes the option list. (Also drop tags containing commas,
      // which the multi_select wire format uses as its option separator.)
      const knownTags = TAG_OPTIONS.length === 0 ? [] : tags.filter((t) => !t.includes(","));
      return {
      type: "upsert" as const,
      key: String(item._id),
      upstreamUpdatedAt: item.lastUpdate,
      ...(isHttpUrl(item.cover) ? { icon: Builder.imageIcon(item.cover) } : {}),
      ...(markdown ? { pageContentMarkdown: markdown } : {}),
      properties: {
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
      },
      };
    });

    // A short page means we've reached the end of the collection.
    const hasMore = items.length === PER_PAGE;

    return {
      changes,
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    };
  },
});

/** Render a bookmark's note and highlights into markdown for the page body. */
function buildPageMarkdown(item: Raindrop): string {
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
