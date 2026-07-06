/**
 * Manual end-to-end check of the article-content pipeline against one bookmark:
 *   Raindrop permanent copy -> gunzip HTML -> rough Markdown -> Gemini clean.
 * Usage: bun scripts/test-content.ts [raindropId]
 */
import { fetchPermanentCopyHtml } from "../src/raindrop.ts";
import { extractArticle, htmlToRoughMarkdown } from "../src/content.ts";

const token = process.env.RAINDROP_TOKEN;
const key = process.env.GEMINI_API_KEY;
if (!token || !key) {
  console.error("RAINDROP_TOKEN and GEMINI_API_KEY must be set in .env");
  process.exit(1);
}

const id = Number(process.argv[2] ?? 0);

const itemRes = await fetch(`https://api.raindrop.io/rest/v1/raindrop/${id}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const item = (await itemRes.json()).item;
console.log("title:", item.title);
console.log("cache status:", JSON.stringify(item.cache));

const html = await fetchPermanentCopyHtml(token, id);
console.log("archived html length:", html?.length ?? null);
if (!html) process.exit(1);

const rough = htmlToRoughMarkdown(html);
console.log("rough markdown length:", rough.length);

console.time("gemini");
const extracted = await extractArticle(rough, key, {
  title: item.title,
  url: item.link,
});
console.timeEnd("gemini");
console.log("summary:", extracted?.summary);
console.log("article markdown length:", extracted?.article.length ?? null);
console.log("\n===== CLEAN ARTICLE MARKDOWN =====\n");
console.log(extracted?.article);
