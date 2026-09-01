import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesktopAppModeMenu } from "./shell-sidebar";

describe("desktop app mode menu", () => {
  it.each([
    ["ide", "IDE"],
    ["chat", "Chat"],
  ] as const)("labels the %s titlebar mode", (appMode, label) => {
    const markup = renderToStaticMarkup(
      <DesktopAppModeMenu
        appMode={appMode}
        onSwitchChat={() => undefined}
        onSwitchIde={() => undefined}
        overlayTitlebar
      />,
    );

    expect(markup).toContain(`aria-label="${label}. Switch Cantrip mode"`);
    expect(markup).toContain(`>${label}</span>`);
  });
});
