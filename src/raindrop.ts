/**
 * Minimal typed client for the Raindrop.io REST API.
 * @see https://developer.raindrop.io/
 */

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
}

interface RaindropsResponse {
  result: boolean;
  items: Raindrop[];
  count: number;
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
): Promise<Raindrop[]> {
  const url = new URL(`${API_BASE}/raindrops/${collectionId}`);
  url.searchParams.set("perpage", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "-lastUpdate");

  const res = await fetch(url, {
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

  const data = (await res.json()) as RaindropsResponse;
  return data.items ?? [];
}
