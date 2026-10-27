# Stats cards

The profile README shows two cards, `stats` and `languages`, each in a light and
a dark version:

```text
generated/stats.svg          generated/stats-dark.svg
generated/languages.svg      generated/languages-dark.svg
```

They are committed, self-hosted SVGs served by `raw.githubusercontent.com`, and
the README picks the right one with the `#gh-light-mode-only` /
`#gh-dark-mode-only` fragments. No third-party card service is involved.

## How it works

`scripts/generate-stats.mjs` collects the data and hands it to
`scripts/lib/cards.mjs`, which renders plain SVG text and rects. There is no
`foreignObject`, so the cards render the same in a browser, in GitHub, and in a
local rasteriser.

Data sources:

| Figure | Source |
| :-- | :-- |
| Stars, forks, repositories | GraphQL `viewer.repositories` + `repositoriesContributedTo` |
| Language shares | GraphQL language edge sizes, summed across those repositories |
| All-time contributions | GraphQL `contributionsCollection`, one alias per year |
| Lines changed | REST `/repos/{repo}/stats/contributors`, additions + deletions |
| Views · 14 days | REST `/repos/{repo}/traffic/views` |

Repositories are deduplicated, so a repo that is both owned and contributed to
is counted once. Contributed repositories count because the card describes the
work, not only the repos the account owns. The 403/404 answers from traffic and
contributor-stats endpoints mean "no push access" and are skipped.

## Running it

```bash
# Real data. ACCESS_TOKEN must belong to the profile owner: the default
# GITHUB_TOKEN would see the Actions bot as the viewer and cannot read traffic.
ACCESS_TOKEN=ghp_... npm run generate

# Render from fixture data, no network and no token
npm run generate -- --fixture scripts/fixtures/sample.json

# Write somewhere else (useful in tests)
npm run generate -- --fixture scripts/fixtures/sample.json --out /tmp/cards
```

Environment variables:

- `ACCESS_TOKEN` — required for live data (`GITHUB_TOKEN` is accepted as a
  fallback, but not recommended for the reason above). Needs read access to the
  repositories, including traffic and contributor stats.
- `EXCLUDED` — comma-separated `owner/name` repositories to leave out.
- `EXCLUDED_LANGS` — comma-separated language names to leave out.

Optional flags: `--fixture <file>`, `--out <dir>`, `--help`.

## Tests

```bash
npm test
```

`node --test` covers number formatting, XML escaping, repository aggregation,
the top-languages folding, both renderers and both palettes, GraphQL error
handling, contribution-year summation, the concurrency helper, and the CLI run
from the fixture. The suite has no dependencies and runs in under a second.

## Automation

`.github/workflows/main.yml` runs the tests, regenerates the cards on every push
and once a day, and commits only `generated/` when something changed. The
`ACCESS_TOKEN` secret is the PAT described above. `EXCLUDED` and `EXCLUDED_LANGS`
are optional repository secrets.

## Design

The palette lives in `PALETTES` in `scripts/lib/cards.mjs` and matches the
portfolio's `src/styles/global.css`: violet-tinted paper, cyan accent, and ink
tiers that clear AA on both backgrounds. Every card is 360 × 210, so the two
cards sit side by side on desktop and wrap on a phone. The SVG carries a
`<title>` and `<desc>` in addition to the README's `alt` text.

`scripts/fixtures/sample.json` is for previews and tests only. The committed
cards are refreshed by the workflow with live data; do not treat the fixture as
the source of truth.
