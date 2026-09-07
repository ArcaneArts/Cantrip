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
