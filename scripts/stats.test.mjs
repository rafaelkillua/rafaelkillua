import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  aggregateRepositories,
  collectStats,
  fetchContributionTotal,
  fetchLinesChanged,
  graphql,
  mapLimit,
} from "./lib/github.mjs";
import {
  PALETTES,
  renderLanguagesCard,
  renderStatsCard,
  topLanguages,
} from "./lib/cards.mjs";
import { escapeXml, formatNumber, formatPercent, parseList, truncate } from "./lib/util.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "scripts/fixtures/sample.json");
const sample = JSON.parse(await readFile(FIXTURE, "utf8"));

const repository = (name, { stars = 0, forks = 0, languages = [] } = {}) => ({
  nameWithOwner: name,
  stargazerCount: stars,
  forkCount: forks,
  languages: {
    edges: languages.map(([language, size, color]) => ({
      size,
      node: { name: language, color },
    })),
  },
});

test("formatNumber uses thousands separators and never prints NaN", () => {
  assert.equal(formatNumber(688315), "688,315");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(undefined), "0");
  assert.equal(formatNumber(Number.NaN), "0");
});

test("formatPercent keeps one decimal", () => {
  assert.equal(formatPercent(41.97), "42.0%");
  assert.equal(formatPercent(100), "100.0%");
  assert.equal(formatPercent(null), "0.0%");
});

test("escapeXml closes every XML metacharacter", () => {
  assert.equal(escapeXml(`A & B <tag attr="x">'`), "A &amp; B &lt;tag attr=&quot;x&quot;&gt;&apos;");
});

test("truncate counts code points and adds one ellipsis", () => {
  assert.equal(truncate("TypeScript", 10), "TypeScript");
  assert.equal(truncate("Objective-C", 8), "Objecti…");
  assert.equal(truncate("JavaScript", 15), "JavaScript");
});

test("parseList trims entries and drops empty ones", () => {
  assert.deepEqual([...parseList("rafaelkillua/old, ,rafaelkillua/older")], [
    "rafaelkillua/old",
    "rafaelkillua/older",
  ]);
  assert.equal(parseList(undefined).size, 0);
});

test("aggregateRepositories deduplicates, sums and sorts languages", () => {
  const owned = [
    repository("rafaelkillua/a", {
      stars: 10,
      forks: 1,
      languages: [
        ["TypeScript", 100, "#3178c6"],
        ["JavaScript", 50, "#f1e05a"],
      ],
    }),
    repository("rafaelkillua/b", {
      stars: 5,
      forks: 2,
      languages: [["TypeScript", 50, "#3178c6"]],
    }),
  ];
  const contributed = [
    repository("rafaelkillua/a", { stars: 999 }),
    repository("someone/c", {
      stars: 1,
      forks: 0,
      languages: [["Java", 100, "#b07219"]],
    }),
  ];

  const result = aggregateRepositories(owned, contributed);
  assert.deepEqual(result.repositories, ["rafaelkillua/a", "rafaelkillua/b", "someone/c"]);
  assert.equal(result.stars, 16);
  assert.equal(result.forks, 3);
  assert.deepEqual(
    result.languages.map((language) => [language.name, language.size]),
    [
      ["TypeScript", 150],
      ["Java", 100],
      ["JavaScript", 50],
    ],
  );
});

test("aggregateRepositories honours repository and language exclusions", () => {
  const owned = [
    repository("rafaelkillua/a", {
      stars: 10,
      forks: 1,
      languages: [
        ["TypeScript", 100, "#3178c6"],
        ["JavaScript", 50, "#f1e05a"],
      ],
    }),
    repository("rafaelkillua/b", { stars: 5, forks: 2 }),
  ];
  const result = aggregateRepositories(owned, [], {
    excludedRepositories: new Set(["rafaelkillua/b"]),
    excludedLanguages: new Set(["JavaScript"]),
  });

  assert.deepEqual(result.repositories, ["rafaelkillua/a"]);
  assert.equal(result.stars, 10);
  assert.deepEqual(result.languages.map((language) => language.name), ["TypeScript"]);
});

test("topLanguages keeps eight rows and folds the tail into Other", () => {
  const languages = Array.from({ length: 10 }, (_, index) => ({
    name: `Lang${index}`,
    size: 10 - index,
    color: "#123456",
  }));
  const { entries, total } = topLanguages(languages);

  assert.equal(entries.length, 8);
  assert.equal(entries.at(-1).name, "Other");
  assert.equal(entries.at(-1).size, 3 + 2 + 1);
  assert.equal(total, 55);
  assert.equal(entries.at(-1).other, true);
});

test("topLanguages drops non-positive sizes and keeps short lists intact", () => {
  const { entries, total } = topLanguages([
    { name: "TypeScript", size: 70, color: "#3178c6" },
    { name: "Empty", size: 0, color: null },
    { name: "JavaScript", size: 30, color: "#f1e05a" },
    { name: "Broken" },
  ]);

  assert.deepEqual(entries.map((language) => language.name), ["TypeScript", "JavaScript"]);
  assert.equal(total, 100);
  assert.equal(topLanguages([]).total, 0);
  assert.deepEqual(topLanguages([]).entries, []);
});

test("stats card is standalone, themed and fully labelled", () => {
  const svg = renderStatsCard(sample, "light");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="360" height="210"/);
  assert.match(svg, /<\/svg>\n$/);
  assert.equal((svg.match(/<svg/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /foreignObject|<table|<div/);
  assert.doesNotMatch(svg, /undefined|NaN/);
  assert.match(svg, /688,315/);
  assert.match(svg, /@rafaelkillua/);
  assert.match(svg, /#f8f3f7/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /<title id="stats-title">GitHub<\/title>/);
});

test("dark and light cards differ only by palette", () => {
  const light = renderStatsCard(sample, "light");
  const dark = renderStatsCard(sample, "dark");
  assert.notEqual(light, dark);
  assert.match(dark, new RegExp(PALETTES.dark.background));
  assert.doesNotMatch(dark, new RegExp(PALETTES.light.background));
  assert.equal(renderStatsCard(sample, "light"), light);
});

test("user-provided names are escaped, not injected", () => {
  const hostile = {
    ...sample,
    user: { login: "a&b", name: `Rafael <script>alert("x")</script> & Co` },
  };
  const svg = renderStatsCard(hostile, "light");
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /Rafael &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; Co/);
});

test("unknown themes fail loudly", () => {
  assert.throws(() => renderStatsCard(sample, "sepia"), /Unknown theme/);
  assert.throws(() => renderLanguagesCard(sample, "sepia"), /Unknown theme/);
});

test("languages card lists top languages plus Other and a full bar", () => {
  const svg = renderLanguagesCard(sample, "dark");
  assert.match(svg, /TypeScript/);
  assert.match(svg, /Other/);
  assert.match(svg, /42\.0%/);
  assert.match(svg, /2\.2%/);
  assert.match(svg, /clipPath id="language-bar"/);
  assert.doesNotMatch(svg, /undefined|NaN/);
  assert.equal((svg.match(/class="lang"/g) ?? []).length, 8);
});

test("contribution total sums every aliased year", async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: {
            year0: { contributionCalendar: { totalContributions: 10 } },
            year1: { contributionCalendar: { totalContributions: 20 } },
          },
        },
      }),
    };
  };

  assert.equal(await fetchContributionTotal("token", [2024, 2025], fetchImpl), 30);
  assert.match(body.query, /year0: contributionsCollection/);
  assert.match(body.query, /2025-01-01T00:00:00Z/);
  assert.equal(await fetchContributionTotal("token", [], fetchImpl), 0);
});

test("graphql surfaces HTTP and API errors", async () => {
  await assert.rejects(
    graphql(
      "token",
      "query { viewer { login } }",
      {},
      async () => ({ ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) }),
    ),
    /Bad credentials/,
  );
  await assert.rejects(
    graphql(
      "token",
      "query { viewer { login } }",
      {},
      async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "rate limited" }] }) }),
    ),
    /rate limited/,
  );
});

test("mapLimit preserves order and respects the limit", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2);
});

test("the CLI writes four cards from a fixture without a token", async () => {
  const output = await mkdtemp(join(tmpdir(), "profile-stats-"));
  try {
    await run(process.execPath, [
      "scripts/generate-stats.mjs",
      "--fixture",
      "scripts/fixtures/sample.json",
      "--out",
      output,
    ], { cwd: ROOT, env: { ...process.env, ACCESS_TOKEN: "" } });

    for (const name of ["stats.svg", "stats-dark.svg", "languages.svg", "languages-dark.svg"]) {
      const path = join(output, name);
      assert.ok((await stat(path)).size > 1000, `${name} should not be empty`);
      assert.match(await readFile(path, "utf8"), /^<svg /);
    }
    assert.match(await readFile(join(output, "stats-dark.svg"), "utf8"), /#101c20/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("collectStats paginates, deduplicates and folds REST figures", async () => {
  const repoA = repository("rafaelkillua/a", {
    stars: 10,
    forks: 1,
    languages: [["TypeScript", 100, "#3178c6"]],
  });
  const repoB = repository("rafaelkillua/b", {
    stars: 5,
    forks: 2,
    languages: [["JavaScript", 100, "#f1e05a"]],
  });
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (String(url).endsWith("/graphql")) {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("repositoriesContributedTo")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              viewer: {
                login: "rafaelkillua",
                name: "Rafael Sampaio Tavares",
                contributionsCollection: { contributionYears: [2024] },
                repositoriesContributedTo: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [repoA],
                },
              },
            },
          }),
        };
      }
      if (query.includes("contributionsCollection(")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              viewer: { year0: { contributionCalendar: { totalContributions: 42 } } },
            },
          }),
        };
      }
      const secondPage = variables.cursor === "cursor-1";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            viewer: {
              login: "rafaelkillua",
              name: "Rafael Sampaio Tavares",
              contributionsCollection: { contributionYears: [2024] },
              repositories: {
                pageInfo: secondPage
                  ? { hasNextPage: false, endCursor: null }
                  : { hasNextPage: true, endCursor: "cursor-1" },
                nodes: secondPage ? [repoB] : [repoA],
              },
            },
          },
        }),
      };
    }

    if (String(url).includes("/stats/contributors")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { author: { login: "rafaelkillua" }, weeks: [{ a: 10, d: 5 }] },
            { author: { login: "someone" }, weeks: [{ a: 999, d: 999 }] },
          ]),
      };
    }
    if (String(url).includes("/traffic/views")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ views: [{ count: 7 }, { count: 0 }] }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const stats = await collectStats("token", { fetchImpl });
  assert.deepEqual(stats.user, { login: "rafaelkillua", name: "Rafael Sampaio Tavares" });
  assert.equal(stats.stars, 15);
  assert.equal(stats.forks, 3);
  assert.equal(stats.repositoryCount, 2);
  assert.equal(stats.contributions, 42);
  assert.equal(stats.linesChanged, 30);
  assert.equal(stats.views, 14);
  assert.deepEqual(stats.languages.map((language) => language.name), [
    "JavaScript",
    "TypeScript",
  ]);
  assert.equal(calls.filter((url) => String(url).endsWith("/graphql")).length, 4);
});

test("collectStats refuses a bot token", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        viewer: {
          login: "github-actions[bot]",
          name: "github-actions",
          contributionsCollection: { contributionYears: [] },
          repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          repositoriesContributedTo: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    }),
  });

  await assert.rejects(collectStats("token", { fetchImpl }), /bot account/);
});

test("empty REST bodies are treated as no data", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "" });
  assert.equal(
    await fetchLinesChanged("token", ["rafaelkillua/empty"], "rafaelkillua", { fetchImpl }),
    0,
  );
  assert.equal(
    await fetchLinesChanged("token", ["rafaelkillua/empty"], "rafaelkillua", {
      fetchImpl: async () => ({ ok: true, status: 204, text: async () => "" }),
    }),
    0,
  );
});
