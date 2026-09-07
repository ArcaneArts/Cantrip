import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ComputerUseEffectsSettings } from "./computer-use-effects-settings";

function render(
  configuration?: Parameters<
    typeof ComputerUseEffectsSettings
  >[0]["configuration"],
) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ComputerUseEffectsSettings
        configuration={configuration}
        pending={false}
        onChange={() => {}}
        workers={[]}
      />
    </QueryClientProvider>,
  );
}
describe("window effect settings", () => {
  it("defaults to Off and explains the separate screenshot and cursor layers", () => {
    const html = render();
    expect(html).toContain('value="off" selected=""');
    expect(html).toContain("Agent screenshots keep the original colors");
    expect(html).not.toContain("Inversion strength");
  });
  it("offers warp controls with saved values and no debug diagnostics", () => {
    const html = render({
      effect: "cursor-warp",
      parameters: { strength: 1.5, radius: 140, motion: 0.5, ripple: 0 },
    });
    expect(html).toContain('value="cursor-warp" selected=""');
    for (const label of [
      "Warp strength",
      "Warp radius (points)",
      "Motion response",
      "Dissipation speed",
      "Click ripple",
    ])
      expect(html).toContain(label);
    expect(html).toContain('value="1.5"');
    expect(html).toContain('value="140"');
    expect(html).not.toContain("Inversion strength");
  });
  it("exposes the debug shader parameters", () => {
    const html = render({
      effect: "debug-gradient",
      parameters: { strength: 0.5, radius: 160, showTelemetry: 0 },
    });
    expect(html).toContain("Inversion strength");
    expect(html).toContain('value="0.5"');
    expect(html).toContain('value="160"');
    expect(html).toContain("Show cursor velocity and input feedback");
    expect(html).not.toContain('type="checkbox" checked');
  });
});
