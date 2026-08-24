import type { RunConfigurationFlutterDevice } from "@cantrip/protocol/run-configuration-operations";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunConfigurationFlutterDevicePickerList } from "./run-configuration-flutter-device-picker";

const devices: RunConfigurationFlutterDevice[] = [
  {
    id: "chrome",
    name: "Chrome",
    supported: true,
    emulator: false,
    targetPlatform: "web-javascript",
  },
  {
    id: "emulator-5554",
    name: "Pixel 9",
    supported: false,
    emulator: true,
    targetPlatform: "android-arm64",
  },
];

describe("Run configuration Flutter device picker", () => {
  it("renders searchable device identity, platform, support, and selection context", () => {
    const html = renderToStaticMarkup(
      <RunConfigurationFlutterDevicePickerList
        currentDeviceId="chrome"
        devices={devices}
        fetched
        fetching={false}
        onChoose={vi.fn()}
      />,
    );

    expect(html).toContain("Search devices, IDs, and platforms");
    expect(html).toContain("Chrome");
    expect(html).toContain("web-javascript");
    expect(html).toContain("emulator-5554");
    expect(html).toContain("android-arm64");
    expect(html).toContain("Unsupported");
    expect(html).toContain("text-emerald-600");
  });

  it("requires an explicit refresh before showing worker devices", () => {
    const idle = renderToStaticMarkup(
      <RunConfigurationFlutterDevicePickerList
        currentDeviceId=""
        devices={[]}
        fetched={false}
        fetching={false}
        onChoose={vi.fn()}
      />,
    );
    expect(idle).toContain("Refresh devices to inspect");

    const loading = renderToStaticMarkup(
      <RunConfigurationFlutterDevicePickerList
        currentDeviceId=""
        devices={[]}
        fetched
        fetching
        onChoose={vi.fn()}
      />,
    );
    expect(loading).toContain("Inspecting Flutter devices");
  });
});
