import { afterEach, describe, expect, it, vi } from "vitest";

import { readServerConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server configuration safety", () => {
  it("defaults to anonymous loopback development", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "127.0.0.1");
    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "local");
    vi.stubEnv("CANTRIP_AUTH_MODE", "none");

    expect(readServerConfig()).toMatchObject({
      agentModel: "gemma4:26b",
      agentModelProvider: "ollama",
      authMode: "none",
      bootstrapMode: "pnpm-dev",
      deploymentMode: "local",
      host: "127.0.0.1",
      ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    });
  });

  it("refuses to expose the no-auth foundation beyond loopback", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");

    expect(() => readServerConfig()).toThrow(/must bind to a loopback host/);
  });

  it("refuses unimplemented hosted and account modes", () => {
    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "hosted");
    expect(() => readServerConfig()).toThrow(/Hosted deployment/);

    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "local");
    vi.stubEnv("CANTRIP_AUTH_MODE", "accounts");
    expect(() => readServerConfig()).toThrow(/not implemented/);
  });

  it("accepts complete TURN configuration and rejects partial or direct URLs", () => {
    vi.stubEnv(
      "CANTRIP_TURN_URLS",
      "turn:relay.cantrip.art:3478?transport=udp,turns:relay.cantrip.art:5349",
    );
    vi.stubEnv("CANTRIP_TURN_SHARED_SECRET", "server-only-secret");
    vi.stubEnv("CANTRIP_TURN_TTL_SECONDS", "900");
    expect(readServerConfig().remoteSurfaceWebRtc).toEqual({
      urls: [
        "turn:relay.cantrip.art:3478?transport=udp",
        "turns:relay.cantrip.art:5349",
      ],
      sharedSecret: "server-only-secret",
      ttlSeconds: 900,
      negotiationTimeoutMs: 8_000,
    });

    vi.stubEnv("CANTRIP_TURN_URLS", "https://relay.cantrip.art");
    expect(() => readServerConfig()).toThrow(/turn: or turns:/i);

    vi.stubEnv("CANTRIP_TURN_URLS", "");
    expect(() => readServerConfig()).toThrow(/configured together/i);
  });
});
