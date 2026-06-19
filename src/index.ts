import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
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
      Tags: Schema.multiSelect([]),
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
        Tags: Builder.multiSelect(...(item.tags ?? [])),
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

function isHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}
