#!/usr/bin/env node
/**
 * Entry point for the profile cards.
 *
 *   ACCESS_TOKEN=... npm run generate
 *   node scripts/generate-stats.mjs --fixture scripts/fixtures/sample.json
 *
 * With a fixture the script never touches the network, which is how the cards
 * can be previewed (and rasterised) locally without a token.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectStats } from "./lib/github.mjs";
import { renderLanguagesCard, renderStatsCard } from "./lib/cards.mjs";
import { parseList } from "./lib/util.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES = [
  ["light", ""],
  ["dark", "-dark"],
];

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function validate(data) {
  if (!data?.user?.login) throw new Error("missing user.login");
  if (!data.user.name) throw new Error("missing user.name");
  for (const key of [
    "stars",
    "forks",
    "contributions",
    "linesChanged",
    "views",
    "repositoryCount",
  ]) {
    if (!Number.isFinite(data[key])) throw new Error(`missing numeric ${key}`);
  }
  if (!Array.isArray(data.languages)) throw new Error("missing languages array");
}

async function loadData() {
  const fixture = flag("--fixture");
  if (fixture) {
    const path = resolve(process.cwd(), fixture);
    console.error(`Reading fixture ${path}`);
    return JSON.parse(await readFile(path, "utf8"));
  }

  const token = process.env.ACCESS_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "ACCESS_TOKEN is required (a PAT for the profile owner; the default GITHUB_TOKEN cannot read traffic or act as the viewer)",
    );
  }

  return collectStats(token, {
    excludedRepositories: parseList(process.env.EXCLUDED),
    excludedLanguages: parseList(process.env.EXCLUDED_LANGS),
    log: (message) => console.error(message),
  });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/generate-stats.mjs [--fixture <file>] [--out <dir>]");
    console.log("Env: ACCESS_TOKEN (or GITHUB_TOKEN), EXCLUDED, EXCLUDED_LANGS");
    return;
  }

  const data = await loadData();
  validate(data);

  const output = flag("--out")
    ? resolve(process.cwd(), flag("--out"))
    : resolve(ROOT, "generated");

  await mkdir(output, { recursive: true });
  for (const [theme, suffix] of THEMES) {
    await writeFile(
      resolve(output, `stats${suffix}.svg`),
      renderStatsCard(data, theme),
      "utf8",
    );
    await writeFile(
      resolve(output, `languages${suffix}.svg`),
      renderLanguagesCard(data, theme),
      "utf8",
    );
  }

  console.error(
    `Wrote 4 cards to ${output}: ${data.user.login}, ${data.repositoryCount} repositories, ${data.languages.length} languages`,
  );
}

main().catch((error) => fail(error.message));
