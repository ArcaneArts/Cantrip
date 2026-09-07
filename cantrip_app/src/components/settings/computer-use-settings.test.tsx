import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseSettings } from "./computer-use-settings";
vi.mock("@/lib/desktop-popout", () => ({ isMacosDesktopRuntime: () => true }));
describe("computer-use opt-in settings", () => {
  it("shows only a disabled notice and toggle while off", () => {
    const html = renderToStaticMarkup(
      <ComputerUseSettings
        enabled={false}
        pending={false}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Computer use is not enabled.");
    expect(html).not.toContain("checked=");
    expect(html).not.toContain("Open Accessibility");
    expect(html).not.toContain("Agents can view");
  });
  it("shows macOS permissions shortcuts only when enabled", () => {
    const html = renderToStaticMarkup(
      <ComputerUseSettings enabled pending={false} onChange={() => {}} />,
    );
    expect(html).toContain("checked=");
    expect(html).toContain("Open Accessibility settings");
    expect(html).toContain("Open Screen Recording settings");
  });
});
