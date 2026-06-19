/**
 * Turn a Raindrop permanent-copy HTML snapshot into clean article Markdown.
 *
 * The snapshot is a full page (nav, ads, related links, and all), so we first
 * convert it to rough Markdown to cut token count, then ask Gemini to re-render
 * just the main article as clean Markdown. The model call is the expensive step,
 * so callers should only run this for bookmarks whose content is new or changed.
 */
import { NodeHtmlMarkdown } from "node-html-markdown";

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Cap the rough Markdown sent to the model (~12k tokens) to bound cost/latency. */
const MAX_INPUT_CHARS = 40_000;
/** Cap the stored article so Notion pages stay a reasonable size. */
const MAX_ARTICLE_CHARS = 12_000;

const SYSTEM_PROMPT = `You are given a raw Markdown dump of a web page (converted from an archived HTML snapshot that still contains navigation, ads, and other page chrome). Re-render ONLY the main article as clean Markdown.
- Keep the article's headings, paragraphs, lists, blockquotes, tables, and inline links.
- Remove navigation, menus, ads, cookie and subscription prompts, social buttons, "related articles", author bios, comments, and other boilerplate.
- Do not summarize, translate, or add commentary. Preserve the author's wording.
- Output only the cleaned Markdown. Do not wrap the whole document in a code fence.`;

/** Convert archived HTML to rough Markdown and truncate it for the model. */
export function htmlToRoughMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html).slice(0, MAX_INPUT_CHARS);
}

/**
 * Ask Gemini to extract the clean article Markdown from a rough page dump.
 * Returns null when the model yields nothing usable. Throws on API errors so
 * the caller can decide whether to skip the body or retry later.
 */
export async function cleanArticleMarkdown(
  rough: string,
  apiKey: string,
  meta: { title: string; url: string },
): Promise<string | null> {
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          parts: [
            {
              text: `Title: ${meta.title}\nURL: ${meta.url}\n\nRaw page Markdown:\n${rough}`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) return null;

  if (text.length <= MAX_ARTICLE_CHARS) return text;
  return `${text.slice(0, MAX_ARTICLE_CHARS).trimEnd()}\n\n_(article truncated)_`;
}
