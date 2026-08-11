"use strict";

const MAX_EXTERNAL_PATHS = 5_000;
const THEME_NAMES = {
  light: "Cantrip Light",
  dark: "Cantrip Dark",
  "high-contrast-light": "Cantrip High Contrast Light",
  "high-contrast-dark": "Cantrip High Contrast Dark",
  "pro-light": "Cantrip Pro Light",
  "pro-dark": "Cantrip Pro Dark",
  "pro-high-contrast-light": "Cantrip Pro High Contrast Light",
  "pro-high-contrast-dark": "Cantrip Pro High Contrast Dark",
};

function themeNameForAppearance(appearance) {
  return typeof appearance === "string"
    ? (THEME_NAMES[appearance] ?? null)
    : null;
}

function reconnectDelayMs(attempt) {
  return Math.min(15_000, 500 * 2 ** Math.max(0, attempt));
}

function parseRequest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !value ||
    value.type !== "request" ||
    typeof value.id !== "string" ||
    typeof value.method !== "string"
  ) {
    return null;
  }
  return {
    type: "request",
    id: value.id,
    method: value.method,
    params:
      value.params && typeof value.params === "object" ? value.params : {},
  };
}

function safeRelativePaths(value) {
  if (!Array.isArray(value)) return [];
  const paths = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_EXTERNAL_PATHS)) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
    const segments = normalized.split("/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//u.test(normalized) ||
      segments.includes("") ||
      segments.includes(".") ||
      segments.includes("..") ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

module.exports = {
  parseRequest,
  reconnectDelayMs,
  safeRelativePaths,
  themeNameForAppearance,
};
