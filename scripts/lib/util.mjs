/**
 * Small helpers shared by the stats collector and the SVG renderer. Kept
 * dependency-free on purpose: the cards are built in CI with nothing but Node.
 */

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 688315 -> "688,315". Anything non-finite renders as 0 instead of "NaN". */
export function formatNumber(value) {
  const number = Number(value);
  return INTEGER.format(Number.isFinite(number) ? number : 0);
}

/** One decimal place is enough to tell 42.0% from 36.3% at 11px. */
export function formatPercent(value) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  return `${safe.toFixed(1)}%`;
}

/** Text from the API ends up inside SVG elements, so escape every one of them. */
export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

/** Truncate to a code-point-safe length, with a single ellipsis. */
export function truncate(value, max) {
  const characters = [...String(value)];
  if (characters.length <= max) return characters.join("");
  return `${characters.slice(0, max - 1).join("")}…`;
}

/** "a, b, ,c" -> Set { "a", "b", "c" } */
export function parseList(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}
