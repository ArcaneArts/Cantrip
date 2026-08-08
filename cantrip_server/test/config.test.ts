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
      allowInsecureRemote: false,
      authMode: "none",
      bootstrapMode: "pnpm-dev",
      deploymentMode: "local",
      host: "127.0.0.1",
      ollamaBaseUrl: "http://127.0.0.1:11434/v1",
      codeSurfaceHost: "127.0.0.1",
      codeSurfaceOrigin: "http://127.0.0.1:4311",
      codeSurfacePort: 4311,
    });
  });

  it("validates an independently addressable Code surface origin", () => {
    vi.stubEnv("CANTRIP_CODE_SURFACE_PORT", "5311");
    vi.stubEnv("CANTRIP_CODE_SURFACE_ORIGIN", "https://code.cantrip.example");
    expect(readServerConfig()).toMatchObject({
      codeSurfacePort: 5311,
      codeSurfaceOrigin: "https://code.cantrip.example",
    });

    vi.stubEnv(
      "CANTRIP_CODE_SURFACE_ORIGIN",
      "https://code.cantrip.example/not-an-origin",
    );
    expect(() => readServerConfig()).toThrow(/without a path/i);
  });

  it("refuses to expose the no-auth foundation beyond loopback", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");

    expect(() => readServerConfig()).toThrow(/remote access is disabled/);
  });

  it("requires an explicit unsafe opt-in for hosted mode", () => {
    vi.stubEnv("CANTRIP_DEPLOYMENT_MODE", "hosted");
    expect(() => readServerConfig()).toThrow(/remote access is disabled/);

    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
    vi.stubEnv("CANTRIP_ALLOW_INSECURE_REMOTE", "true");
    vi.stubEnv("CANTRIP_WORKER_TOKEN", "a-unique-remote-worker-token");
    expect(readServerConfig()).toMatchObject({
      allowInsecureRemote: true,
      deploymentMode: "hosted",
      host: "0.0.0.0",
    });
  });

  it("refuses the development worker token for remote deployments", () => {
    vi.stubEnv("CANTRIP_SERVER_HOST", "0.0.0.0");
    vi.stubEnv("CANTRIP_ALLOW_INSECURE_REMOTE", "true");
    vi.stubEnv("CANTRIP_WORKER_TOKEN", "cantrip-local-development");
    expect(() => readServerConfig()).toThrow(/unique CANTRIP_WORKER_TOKEN/);
  });

  it("refuses unimplemented account mode", () => {
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
