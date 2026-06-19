/**
 * Refresh the Tag/Collection select options from Raindrop.
 *
 * Native multi_select / select columns in a managed Notion database need their
 * options declared in the schema at deploy time — Notion won't auto-create
 * options at sync time on a read-only managed schema. Rather than commit a
 * generated source file (which would bake one account's data into the repo),
 * we store the option lists as JSON env vars:
 *
 *   - RAINDROP_TAG_OPTIONS         multi_select options for Tags
 *   - RAINDROP_COLLECTION_OPTIONS  select options for Collection
 *   - RAINDROP_COLLECTION_MAP      collection id -> name, for labelling rows
 *
 * This script fetches the current tags + collections, writes those vars into
 * .env (for `--local` runs), ensures the worker exists, and pushes the env to
 * the deployed worker. `bun run deploy` runs it before deploying so the schema
 * migrates with up-to-date options. Bun auto-loads .env, so RAINDROP_TOKEN is
 * already in process.env here.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAllTags, getCollections } from "../src/raindrop.ts";

const ENV_PATH = ".env";
const WORKER_NAME = "raindrop-notion-sync";

/** Notion option names can't contain commas; cap to Notion's 100-char limit. */
function sanitizeName(name: string): string {
  return name.replace(/,/g, " ").trim().slice(0, 100);
}

/** Upsert KEY=VALUE pairs into .env, preserving any other lines. */
function writeEnvVars(vars: Record<string, string>): void {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const keys = new Set(Object.keys(vars));
  const kept = existing
    .split("\n")
    .filter((line) => line.length > 0 && !keys.has(line.split("=")[0] ?? ""));
  const updated = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_PATH, [...kept, ...updated].join("\n") + "\n");
}

const token = process.env.RAINDROP_TOKEN;
if (!token) {
  console.error("RAINDROP_TOKEN is not set (expected in .env).");
  process.exit(1);
}

console.log("Fetching tags and collections from Raindrop…");
const [tags, collections] = await Promise.all([
  getAllTags(token),
  getCollections(token),
]);

// Tags become multi_select options. Drop comma-containing names (the wire
// format's option separator) and over-long names, then de-duplicate.
const tagOptions = [
  ...new Set(
    tags
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 100 && !t.includes(",")),
  ),
].map((name) => ({ name }));

// Collections become select options, plus a fixed "Unsorted" bucket (id -1).
const collectionNameById: Record<string, string> = { "-1": "Unsorted" };
for (const c of collections) {
  collectionNameById[String(c._id)] = sanitizeName(c.title);
}
const collectionOptions = [...new Set(Object.values(collectionNameById))].map(
  (name) => ({ name }),
);

writeEnvVars({
  RAINDROP_TAG_OPTIONS: JSON.stringify(tagOptions),
  RAINDROP_COLLECTION_OPTIONS: JSON.stringify(collectionOptions),
  RAINDROP_COLLECTION_MAP: JSON.stringify(collectionNameById),
});
console.log(
  `Wrote ${tagOptions.length} tag options and ${collectionOptions.length} collection options to .env.`,
);

// Ensure the worker exists, then push env so the deployed schema sees the
// options at its next deploy. Skip remote push gracefully if it isn't set up.
try {
  if (!existsSync("workers.json")) {
    console.log("No workers.json — creating the worker…");
    execSync(`bunx ntn workers create --name ${WORKER_NAME}`, { stdio: "inherit" });
  }
  console.log("Pushing env vars to the deployed worker…");
  execSync("bunx ntn workers env push --yes", { stdio: "inherit" });
} catch {
  console.warn(
    "Could not push env to a deployed worker (run `ntn login` / deploy once first). Local .env is updated.",
  );
}
