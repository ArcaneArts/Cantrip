import type { BrowserSummary, BrowserUpdate } from "@cantrip/protocol";

export interface BrowserPageStateUpdate {
  previousTitle: string | null;
  title: string;
  url: string;
}

export function browserUpdateForPageState(
  browser: BrowserSummary,
  state: BrowserPageStateUpdate,
): BrowserUpdate | null {
  const input: BrowserUpdate = {
    ...(state.url === browser.url ? {} : { url: state.url }),
    ...(state.title &&
    (browser.title === "Browser" || browser.title === state.previousTitle)
      ? { title: state.title }
      : {}),
  };
  return Object.keys(input).length > 0 ? input : null;
}
