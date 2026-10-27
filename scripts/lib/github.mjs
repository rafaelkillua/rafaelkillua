/**
 * GitHub data collection for the profile cards.
 *
 * Two GraphQL connections supply repositories, stars, forks and language sizes
 * (owned + contributed), a second query sums all-time contributions, and two
 * REST endpoints supply lines changed and the 14-day view count. No packages:
 * Node 20+ ships fetch, which keeps CI to checkout + generate + commit.
 */

const API = "https://api.github.com";
const LANGUAGES_PER_REPOSITORY = 20; // the GitHub UI shows the same top 20

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPOSITORY_FIELDS = `
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        stargazerCount
        forkCount
        languages(first: ${LANGUAGES_PER_REPOSITORY}, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }`;

const VIEWER_FIELDS = `
      login
      name
      contributionsCollection { contributionYears }`;

export const OWNED_REPOSITORIES_QUERY = `query($cursor: String) {
  viewer {
    ${VIEWER_FIELDS}
    repositories(
      first: 100
      after: $cursor
      ownerAffiliations: [OWNER]
      isFork: false
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) { ${REPOSITORY_FIELDS}
    }
  }
}`;

export const CONTRIBUTED_REPOSITORIES_QUERY = `query($cursor: String) {
  viewer {
    ${VIEWER_FIELDS}
    repositoriesContributedTo(
      first: 100
      after: $cursor
      includeUserRepositories: false
      contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) { ${REPOSITORY_FIELDS}
    }
  }
}`;

export async function graphql(token, query, variables = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${API}/graphql`, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "rafaelkillua-profile-stats",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GitHubError(
      `GitHub GraphQL returned HTTP ${response.status}: ${payload?.message ?? "no message"}`,
      response.status,
    );
  }
  if (payload?.errors?.length) {
    throw new GitHubError(
      `GitHub GraphQL: ${payload.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (!payload?.data) throw new GitHubError("GitHub GraphQL returned no data");
  return payload.data;
}

async function rest(token, path, fetchImpl = fetch, { attempts = 6 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchImpl(`${API}${path}`, {
      headers: {
        authorization: `bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rafaelkillua-profile-stats",
      },
    });

    // GitHub answers 202 while it computes contributor statistics.
    if (response.status === 202) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    // 403/404 mean "no access" for traffic and contributor stats: skip quietly.
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) {
      throw new GitHubError(`GitHub REST ${path} returned HTTP ${response.status}`, response.status);
    }
    return response.json();
  }
  return null;
}

async function fetchConnection(token, query, connectionName, fetchImpl) {
  let cursor = null;
  let viewer = null;
  const repositories = [];

  for (;;) {
    const data = await graphql(token, query, { cursor }, fetchImpl);
    viewer = data.viewer;
    const connection = viewer?.[connectionName];
    if (!connection) {
      throw new GitHubError(`GitHub GraphQL response is missing ${connectionName}`);
    }

    repositories.push(...(connection.nodes ?? []).filter(Boolean));
    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return { viewer, repositories };
}

/**
 * Deduplicate owned + contributed repositories, then sum stars, forks and
 * language bytes. Contributed repositories count because the card describes
 * the work, not only the repos the account owns.
 */
export function aggregateRepositories(owned, contributed, options = {}) {
  const excludedRepositories = options.excludedRepositories ?? new Set();
  const excludedLanguages = options.excludedLanguages ?? new Set();
  const seen = new Set();
  const languages = new Map();
  let stars = 0;
  let forks = 0;

  for (const repository of [...(owned ?? []), ...(contributed ?? [])]) {
    const name = repository?.nameWithOwner;
    if (!name || seen.has(name) || excludedRepositories.has(name)) continue;
    seen.add(name);
    stars += repository.stargazerCount ?? 0;
    forks += repository.forkCount ?? 0;

    for (const edge of repository.languages?.edges ?? []) {
      const language = edge?.node?.name;
      if (!language || excludedLanguages.has(language)) continue;

      const entry = languages.get(language) ?? {
        name: language,
        color: edge.node.color ?? null,
        size: 0,
      };
      entry.size += edge.size ?? 0;
      languages.set(language, entry);
    }
  }

  return {
    repositories: [...seen],
    stars,
    forks,
    languages: [...languages.values()].sort(
      (a, b) => b.size - a.size || a.name.localeCompare(b.name),
    ),
  };
}

export async function fetchContributionTotal(token, years, fetchImpl = fetch) {
  const safeYears = [
    ...new Set(
      (Array.isArray(years) ? years : []).filter(
        (year) => Number.isInteger(year) && year >= 2008 && year <= 2100,
      ),
    ),
  ].sort((a, b) => a - b);

  if (safeYears.length === 0) return 0;

  const fields = safeYears
    .map(
      (year, index) => `year${index}: contributionsCollection(
        from: "${year}-01-01T00:00:00Z"
        to: "${year + 1}-01-01T00:00:00Z"
      ) { contributionCalendar { totalContributions } }`,
    )
    .join("\n");

  const data = await graphql(token, `query { viewer { ${fields} } }`, {}, fetchImpl);
  return Object.values(data.viewer ?? {}).reduce(
    (sum, entry) => sum + (entry?.contributionCalendar?.totalContributions ?? 0),
    0,
  );
}

/** Run async tasks with a small concurrency limit, preserving order. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => worker()),
  );
  return results;
}

export async function fetchLinesChanged(token, repositories, login, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const author = login.toLowerCase();
  let changed = 0;
  let skipped = 0;

  await mapLimit(repositories, options.concurrency ?? 4, async (repository) => {
    try {
      const stats = await rest(
        token,
        `/repos/${repository}/stats/contributors`,
        fetchImpl,
        options,
      );
      if (!Array.isArray(stats)) {
        skipped += 1;
        return;
      }

      for (const contribution of stats) {
        if (contribution?.author?.login?.toLowerCase() !== author) continue;
        for (const week of contribution.weeks ?? []) {
          changed += (week.a ?? 0) + (week.d ?? 0);
        }
      }
    } catch (error) {
      skipped += 1;
      log(`  skipped ${repository}: ${error.message}`);
    }
  });

  if (skipped > 0) log(`  ${skipped} repositories without contributor statistics`);
  return changed;
}

export async function fetchViews(token, repositories, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  let views = 0;
  let skipped = 0;

  await mapLimit(repositories, options.concurrency ?? 4, async (repository) => {
    try {
      const traffic = await rest(token, `/repos/${repository}/traffic/views`, fetchImpl, options);
      if (!traffic) {
        skipped += 1;
        return;
      }
      for (const day of traffic.views ?? []) views += day.count ?? 0;
    } catch (error) {
      skipped += 1;
      log(`  skipped views for ${repository}: ${error.message}`);
    }
  });

  if (skipped > 0) log(`  ${skipped} repositories without view access`);
  return views;
}

/**
 * The whole collection, in the shape the card renderer expects. The token
 * decides the account: a PAT for the profile owner is required for traffic and
 * contributor stats.
 */
export async function collectStats(token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});

  log("Reading owned repositories…");
  const owned = await fetchConnection(
    token,
    OWNED_REPOSITORIES_QUERY,
    "repositories",
    fetchImpl,
  );
  log(`  ${owned.repositories.length} repositories`);

  log("Reading contributed repositories…");
  const contributed = await fetchConnection(
    token,
    CONTRIBUTED_REPOSITORIES_QUERY,
    "repositoriesContributedTo",
    fetchImpl,
  );
  log(`  ${contributed.repositories.length} repositories`);

  const viewer = owned.viewer;
  if (!viewer?.login) throw new GitHubError("GitHub API did not return a viewer login");
  if (viewer.login.endsWith("[bot]")) {
    throw new GitHubError(
      "The token resolves to a bot account; ACCESS_TOKEN must be a PAT for the profile owner",
    );
  }

  const aggregate = aggregateRepositories(owned.repositories, contributed.repositories, options);
  log(`Aggregated ${aggregate.repositories.length} repositories`);

  log("Summing contributions and repository statistics…");
  const [contributions, linesChanged, views] = await Promise.all([
    fetchContributionTotal(
      token,
      viewer.contributionsCollection?.contributionYears ?? [],
      fetchImpl,
    ),
    fetchLinesChanged(token, aggregate.repositories, viewer.login, {
      ...options,
      fetchImpl,
      log,
    }),
    fetchViews(token, aggregate.repositories, { ...options, fetchImpl, log }),
  ]);

  return {
    user: { login: viewer.login, name: viewer.name || viewer.login },
    stars: aggregate.stars,
    forks: aggregate.forks,
    contributions,
    linesChanged,
    views,
    repositoryCount: aggregate.repositories.length,
    languages: aggregate.languages,
  };
}
