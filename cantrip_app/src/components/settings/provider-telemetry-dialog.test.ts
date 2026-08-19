import { describe, expect, it } from "vitest";

import {
  PROVIDER_TELEMETRY_DIALOG_CLASS_NAME,
  PROVIDER_TELEMETRY_SCROLL_CLASS_NAME,
} from "./provider-telemetry-dialog";

describe("provider telemetry dialog layout", () => {
  it("keeps the dialog bounded and gives the telemetry body its own scroll range", () => {
    expect(PROVIDER_TELEMETRY_DIALOG_CLASS_NAME).toContain("flex-col");
    expect(PROVIDER_TELEMETRY_DIALOG_CLASS_NAME).toContain("max-h-[92vh]");
    expect(PROVIDER_TELEMETRY_DIALOG_CLASS_NAME).toContain("overflow-hidden");
    expect(PROVIDER_TELEMETRY_SCROLL_CLASS_NAME).toContain("min-h-0");
    expect(PROVIDER_TELEMETRY_SCROLL_CLASS_NAME).toContain("flex-1");
    expect(PROVIDER_TELEMETRY_SCROLL_CLASS_NAME).toContain("overflow-y-auto");
  });
});
