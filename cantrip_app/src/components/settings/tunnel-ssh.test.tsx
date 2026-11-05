import { describe, expect, it } from "vitest";
import { publicKeyWithoutComment, sshClientCommand } from "./tunnel-ssh";
import type { DesktopTunnelForwardSummary } from "@/lib/desktop-tunnel";

describe("SSH client connection details", () => {
  it("accepts a normal public-key comment without hiding multiple keys or options", () => {
    expect(publicKeyWithoutComment("ssh-ed25519 AAAA my laptop")).toBe(
      "ssh-ed25519 AAAA",
    );
    expect(
      publicKeyWithoutComment("ssh-ed25519 AAAA\nssh-ed25519 BBBB"),
    ).toContain("\n");
    expect(publicKeyWithoutComment("command=bad ssh-ed25519 AAAA")).toContain(
      "command=bad",
    );
  });
  it("quotes the local pin path for each shell and always requires strict host verification", () => {
    const forward = {
      localHost: "127.0.0.1",
      localPort: 12345,
      ssh: {
        user: "ctw-work",
        hostAlias: "cantrip-os-test",
        knownHostsPath: "/tmp/O'Brien/pin",
      },
    } as DesktopTunnelForwardSummary;
    const unix = sshClientCommand(forward, false, false),
      windows = sshClientCommand(forward, true, true);
    expect(unix).toContain("'UserKnownHostsFile=/tmp/O'\\''Brien/pin'");
    expect(windows).toContain("'UserKnownHostsFile=/tmp/O''Brien/pin'");
    expect(unix).toContain("StrictHostKeyChecking=yes");
    expect(windows).toContain("StrictHostKeyChecking=yes");
    expect(unix).toContain(" -p 12345 ctw-work@127.0.0.1");
    expect(windows).toContain(" -P 12345 ctw-work@127.0.0.1");
  });
});
