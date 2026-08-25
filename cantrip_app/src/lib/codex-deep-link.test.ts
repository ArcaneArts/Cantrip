import { afterEach, describe, expect, it, vi } from "vitest";

import { codexThreadUrl, openCodexThread } from "./codex-deep-link";

const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl }));

afterEach(() => {
  vi.unstubAllGlobals();
  opener.openUrl.mockReset();
});

describe("Codex thread deep links", () => {
  it("opens a validated native thread link from the desktop app", async () => {
    vi.stubGlobal("isTauri", true);
    opener.openUrl.mockResolvedValue(undefined);

    await openCodexThread("01900000-0000-7000-8000-000000000001");

    expect(opener.openUrl).toHaveBeenCalledWith(
      "codex://threads/01900000-0000-7000-8000-000000000001",
    );
  });

  it("rejects malformed identifiers before constructing a native URL", () => {
    expect(() => codexThreadUrl("../settings")).toThrow(
      "invalid thread identifier",
    );
  });
});
