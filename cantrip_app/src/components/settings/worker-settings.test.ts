import { describe, expect, it } from "vitest";

import { formatWorkerLastSeen, workerPairingCommands } from "./worker-settings";

describe("worker settings helpers", () => {
  it("formats recent and stale presence concisely", () => {
    const now = Date.parse("2026-08-11T20:00:00.000Z");
    expect(formatWorkerLastSeen("2026-08-11T19:59:50.000Z", now)).toBe(
      "just now",
    );
    expect(formatWorkerLastSeen("2026-08-11T19:53:00.000Z", now)).toBe(
      "7m ago",
    );
    expect(formatWorkerLastSeen("2026-08-11T17:00:00.000Z", now)).toBe(
      "3h ago",
    );
  });

  it("builds standalone pairing commands for both supported shells", () => {
    const commands = workerPairingCommands(
      "https://relay.cantrip.art",
      `ctwl_${"a".repeat(32)}`,
    );
    expect(commands.posix).toContain(
      "CANTRIP_SERVER_URL='https://relay.cantrip.art'",
    );
    expect(commands.posix).toContain("./bin/cantrip-worker");
    expect(commands.powershell).toContain(
      '$env:CANTRIP_SERVER_URL="https://relay.cantrip.art"',
    );
    expect(commands.powershell).toContain(".\\bin\\cantrip-worker.exe");
  });
});
