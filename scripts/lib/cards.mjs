/**
 * Renders the two profile cards as standalone SVG.
 *
 * Pure SVG on purpose: the previous version used foreignObject + an HTML table,
 * which only browsers agreed to paint and which no rasteriser could preview.
 * Text elements render everywhere GitHub does, keep the cards theme-aware and
 * make `node scripts/generate-stats.mjs --fixture ...` verifiable locally.
 *
 * The palette is the portfolio's (src/styles/global.css): violet-tinted paper,
 * cyan accent and two ink tiers that clear AA on both backgrounds.
 */

import { escapeXml, formatNumber, formatPercent, truncate } from "./util.mjs";

const WIDTH = 360;
const HEIGHT = 210;
const PAD = 24;
const COLUMN_GAP = 164;
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

export const PALETTES = {
  light: {
    background: "#f8f3f7",
    border: "#d9cfdd",
    heading: "#14101a",
    muted: "#5a5266",
    subtle: "#655c72",
    accent: "#066b85",
    track: "#e7dde9",
    other: "#9a8ba3",
  },
  dark: {
    background: "#101c20",
    border: "#2a2638",
    heading: "#f4eff7",
    muted: "#a8a3b8",
    subtle: "#948da2",
    accent: "#9fe8ff",
    track: "#2a2638",
    other: "#5c556e",
  },
};

function paletteFor(theme) {
  const palette = PALETTES[theme];
  if (!palette) throw new Error(`Unknown theme: ${theme}`);
  return palette;
}

function shell(theme, { title, meta, description, body }) {
  const palette = paletteFor(theme);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="stats-title stats-desc">
<title id="stats-title">${escapeXml(title)}</title>
<desc id="stats-desc">${escapeXml(description)}</desc>
<style>
  .card { fill: ${palette.background}; stroke: ${palette.border}; stroke-width: 1; }
  text { font-family: ${FONT_STACK}; }
  .heading { fill: ${palette.heading}; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .meta { fill: ${palette.muted}; font-size: 11px; }
  .value { fill: ${palette.heading}; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .label { fill: ${palette.subtle}; font-size: 10px; font-weight: 500; letter-spacing: 0.07em; }
  .accent { fill: ${palette.accent}; }
  .track { fill: ${palette.track}; }
  .lang { fill: ${palette.heading}; font-size: 11px; }
  .pct { fill: ${palette.subtle}; font-size: 11px; font-variant-numeric: tabular-nums; }
  .end { text-anchor: end; }
</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12" class="card"/>
<text x="${PAD}" y="33" class="heading">${escapeXml(title)}</text>
<text x="${WIDTH - PAD}" y="33" class="meta end">${escapeXml(meta)}</text>
<rect x="${PAD}" y="45" width="22" height="3" rx="1.5" class="accent"/>
${body}
</svg>
`;
}

/**
 * The six figures fit a 2 x 3 grid, which keeps the card short enough to sit
 * beside the languages card on desktop and wrap cleanly on a phone.
 */
export function renderStatsCard(data, theme) {
  const metrics = [
    ["Stars", data.stars],
    ["Forks", data.forks],
    ["Contributions", data.contributions],
    ["Lines changed", data.linesChanged],
    ["Views · 14 days", data.views],
    ["Repositories", data.repositoryCount],
  ];

  const grid = metrics
    .map(([label, value], index) => {
      const x = PAD + (index % 2) * COLUMN_GAP;
      const y = 86 + Math.floor(index / 2) * 46;
      return `<text x="${x}" y="${y}" class="value">${formatNumber(value)}</text>
<text x="${x}" y="${y + 16}" class="label">${escapeXml(label.toUpperCase())}</text>`;
    })
    .join("\n");

  const description = [
    `${formatNumber(data.stars)} stars`,
    `${formatNumber(data.forks)} forks`,
    `${formatNumber(data.contributions)} contributions`,
    `${formatNumber(data.linesChanged)} lines changed`,
    `${formatNumber(data.views)} views in the last 14 days`,
    `${formatNumber(data.repositoryCount)} repositories`,
  ].join(", ");

  return shell(theme, {
    title: "GitHub",
    meta: `@${data.user.login}`,
    description: `GitHub statistics for ${data.user.name}: ${description}.`,
    body: grid,
  });
}

/**
 * Top languages by file size. Past `limit` the tail is folded into one Other
 * slice so the list stays at four rows of two columns.
 */
export function topLanguages(languages, limit = 7) {
  const sorted = (Array.isArray(languages) ? languages : [])
    .filter((language) => language && Number.isFinite(language.size) && language.size > 0)
    .slice()
    .sort((a, b) => b.size - a.size || String(a.name).localeCompare(String(b.name)));

  if (sorted.length <= limit + 1) {
    return {
      entries: sorted,
      total: sorted.reduce((sum, language) => sum + language.size, 0),
    };
  }

  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const other = {
    name: "Other",
    size: tail.reduce((sum, language) => sum + language.size, 0),
    color: null,
    other: true,
  };

  return {
    entries: [...head, other],
    total: [...head, other].reduce((sum, language) => sum + language.size, 0),
  };
}

export function renderLanguagesCard(data, theme) {
  const palette = paletteFor(theme);
  const { entries, total } = topLanguages(data.languages);

  let offset = 0;
  const segments = entries
    .map((language) => {
      const width = total > 0 ? (language.size / total) * (WIDTH - PAD * 2) : 0;
      const color = language.other ? palette.other : language.color || palette.muted;
      const segment = `<rect x="${(PAD + offset).toFixed(2)}" y="60" width="${width.toFixed(2)}" height="8" fill="${escapeXml(color)}"/>`;
      offset += width;
      return segment;
    })
    .join("\n");

  const list = entries
    .map((language, index) => {
      const x = PAD + (index % 2) * COLUMN_GAP;
      const y = 90 + Math.floor(index / 2) * 30;
      const percent = total > 0 ? (language.size / total) * 100 : 0;
      const color = language.other ? palette.other : language.color || palette.muted;
      return `<circle cx="${x + 4}" cy="${y - 3.5}" r="4" fill="${escapeXml(color)}"/>
<text x="${x + 14}" y="${y}" class="lang">${escapeXml(truncate(language.name, 15))}</text>
<text x="${x + 148}" y="${y}" class="pct end">${formatPercent(percent)}</text>`;
    })
    .join("\n");

  const summary = entries
    .map((language) => {
      const percent = total > 0 ? (language.size / total) * 100 : 0;
      return `${language.name} ${formatPercent(percent)}`;
    })
    .join(", ");

  return shell(theme, {
    title: "Languages",
    meta: "by file size",
    description: `Languages used by ${data.user.name}: ${summary}.`,
    body: `<defs>
  <clipPath id="language-bar"><rect x="${PAD}" y="60" width="${WIDTH - PAD * 2}" height="8" rx="4"/></clipPath>
</defs>
<rect x="${PAD}" y="60" width="${WIDTH - PAD * 2}" height="8" rx="4" class="track"/>
<g clip-path="url(#language-bar)">
${segments}
</g>
${list}`,
  });
}
