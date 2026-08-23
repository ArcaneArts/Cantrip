import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EliteSettings,
  MAX_ELITE_CONFIGURATOR_WIDTH,
  MIN_ELITE_CONFIGURATOR_WIDTH,
  clampEliteConfiguratorWidth,
  eliteConfiguratorWidthFromKey,
  eliteConfiguratorWidthFromPointer,
} from "./elite-settings";

describe("Elite settings laboratory", () => {
  it("renders the replay controls and each fixture view selector", () => {
    const markup = renderToStaticMarkup(<EliteSettings />);

    expect(markup).toContain("Elite reveal laboratory");
    expect(markup).toContain("Replay</button>");
    expect(markup).toContain("Configure</button>");
    expect(markup).toContain("List</button>");
    expect(markup).toContain("Cards</button>");
    expect(markup).toContain("Text</button>");
    expect(markup).toContain("Table</button>");
    expect(markup).toContain("Widgets</button>");
    expect(markup).toContain("4–8 glitches · 16 ms · 50 ms spread");
    expect(markup).toContain('data-elite-lab=""');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain("App-wide off");
    expect(markup).toContain(
      'data-slot="elite-configurator-sidebar-shell" data-state="closed"',
    );
    expect(markup).toContain('aria-label="Full bright frame weight"');
    expect(markup).toContain('aria-label="Left half frame weight"');
    expect(markup).toContain('aria-label="Right half frame weight"');
    expect(markup).toContain('aria-label="Chromatic shift weight"');
    expect(markup).toContain('aria-label="Scanline bands weight"');
    expect(markup).toContain("Glitch Terminal Contents");
    expect(markup.match(/max="32"/g)).toHaveLength(2);
    expect(markup.match(/value="0\.01"/g)).toHaveLength(3);
    expect(markup).toContain('value="0.25"');
    expect(markup).toContain('value="0.33"');
  });

  it("marks fixture items with explicit reveal semantics", () => {
    const markup = renderToStaticMarkup(<EliteSettings />);

    expect(markup).toContain('data-elite-reveal=""');
    expect(markup).toContain('data-content-kind="box"');
    expect(markup).toContain('data-state="waiting"');
    expect(markup).toContain("Relay subsystem 01");
  });

  it("reflects the persisted app-wide state without applying it to the lab", () => {
    const markup = renderToStaticMarkup(<EliteSettings appWideEnabled />);

    expect(markup).toContain('data-elite-lab=""');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("App-wide on");
  });

  it("clamps pointer and keyboard resizing to the dock limits", () => {
    expect(clampEliteConfiguratorWidth(100)).toBe(MIN_ELITE_CONFIGURATOR_WIDTH);
    expect(clampEliteConfiguratorWidth(2_000)).toBe(
      MAX_ELITE_CONFIGURATOR_WIDTH,
    );
    expect(eliteConfiguratorWidthFromPointer(700, 1_200)).toBe(500);
    expect(eliteConfiguratorWidthFromKey(400, "ArrowLeft")).toBe(416);
    expect(eliteConfiguratorWidthFromKey(400, "ArrowRight")).toBe(384);
    expect(eliteConfiguratorWidthFromKey(400, "Home")).toBe(
      MIN_ELITE_CONFIGURATOR_WIDTH,
    );
    expect(eliteConfiguratorWidthFromKey(400, "End")).toBe(
      MAX_ELITE_CONFIGURATOR_WIDTH,
    );
    expect(eliteConfiguratorWidthFromKey(400, "Enter")).toBeNull();
  });
});
