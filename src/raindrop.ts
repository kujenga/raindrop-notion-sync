/**
 * Minimal typed client for the Raindrop.io REST API.
 * @see https://developer.raindrop.io/
 */

import { gunzipSync } from "node:zlib";

const API_BASE = "https://api.raindrop.io/rest/v1";

/** Maximum items per page allowed by the Raindrop API. */
export const PER_PAGE = 50;

/** A single highlight saved on a raindrop. */
export interface RaindropHighlight {
  text: string;
  color?: string;
  note?: string;
}

/** A single raindrop (bookmark). Only the fields we consume are typed. */
export interface Raindrop {
  _id: number;
  title: string;
  excerpt: string;
  note: string;
  link: string;
  domain: string;
  type: string;
  tags: string[];
  cover: string;
  important?: boolean;
  created: string;
  lastUpdate: string;
  highlights?: RaindropHighlight[];
  /** Id of the collection this bookmark belongs to (-1 = Unsorted). */
  collectionId: number;
  /** Permanent-copy (Pro archive) status. `ready` means a snapshot exists. */
  cache?: { status: string; size?: number; created?: string };
}

/** A Raindrop collection (folder). Only the fields we consume are typed. */
export interface RaindropCollection {
  _id: number;
  title: string;
}

interface RaindropsResponse {
  result: boolean;
  items: Raindrop[];
  count: number;
}

interface CollectionsResponse {
  result: boolean;
  items: RaindropCollection[];
}

interface TagsResponse {
  result: boolean;
  items: { _id: string; count: number }[];
}

/** GET a Raindrop endpoint and return the parsed JSON, throwing on non-2xx. */
async function raindropGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Raindrop API request failed (${res.status} ${res.statusText}): ${body}`,
    );
  }

  return (await res.json()) as T;
}

/**
 * Fetch one page of raindrops from a collection.
 *
 * @param token   Raindrop API token (test token or OAuth bearer token).
 * @param collectionId  Collection id. `0` = all, `-1` = unsorted, `-99` = trash.
 * @param page    Zero-based page index.
 */
export async function getRaindrops(
  token: string,
  collectionId: number,
  page: number,
  perpage: number = PER_PAGE,
): Promise<Raindrop[]> {
  const params = new URLSearchParams({
    perpage: String(perpage),
    page: String(page),
    sort: "-lastUpdate",
  });
  const data = await raindropGet<RaindropsResponse>(
    token,
    `/raindrops/${collectionId}?${params}`,
  );
  return data.items ?? [];
}

/** Fetch a single raindrop by id, or null if it no longer exists. */
export async function getRaindrop(
  token: string,
  id: number,
): Promise<Raindrop | null> {
  try {
    const data = await raindropGet<{ item: Raindrop }>(token, `/raindrop/${id}`);
    return data.item ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch every collection in the user's account (root collections plus all
 * nested children). Used to label each bookmark with its collection name.
 */
export async function getCollections(
  token: string,
): Promise<RaindropCollection[]> {
  const [root, children] = await Promise.all([
    raindropGet<CollectionsResponse>(token, "/collections"),
    raindropGet<CollectionsResponse>(token, "/collections/childrens"),
  ]);
  const seen = new Map<number, RaindropCollection>();
  for (const c of [...(root.items ?? []), ...(children.items ?? [])]) {
    seen.set(c._id, { _id: c._id, title: c.title });
  }
  return [...seen.values()];
}

/**
 * Fetch every tag in the user's account (across all collections).
 * The `_id` of each tag entry is the tag name.
 */
export async function getAllTags(token: string): Promise<string[]> {
  const data = await raindropGet<TagsResponse>(token, "/tags/0");
  return (data.items ?? []).map((t) => t._id).filter(Boolean);
}

/**
 * Fetch the Raindrop "permanent copy" (Pro archive) of a bookmark as HTML.
 *
 * The `/raindrop/{id}/cache` endpoint 303-redirects to a storage URL serving a
 * gzip-compressed HTML snapshot of the page. Only call this when the bookmark's
 * `cache.status === "ready"` — otherwise the endpoint redirects to the live URL.
 * Returns null if the archive can't be retrieved.
 */
export async function fetchPermanentCopyHtml(
  token: string,
  id: number,
): Promise<string | null> {
  // Cross-origin redirect to storage: fetch follows it and (per the fetch
  // spec) strips the Authorization header so the presigned URL isn't rejected.
  const res = await fetch(`${API_BASE}/raindrop/${id}/cache`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return null;
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return (isGzip ? gunzipSync(buf) : buf).toString("utf8");
}
