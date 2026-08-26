import { describe, expect, it } from "vitest";

import {
  managedWebRuntimeCapabilitiesSchema,
  managedWebRuntimeActionRequestSchema,
  managedWebRuntimeReleaseManifestSchema,
  managedWebRuntimeStatusSchema,
  unavailableManagedWebRuntimeCapabilities,
} from "./index.js";

const artifact = {
  schemaVersion: 1 as const,
  component: "searxng" as const,
  version: "2026.8.1",
  platform: "darwin" as const,
  architecture: "arm64" as const,
  archiveFormat: "tar.gz" as const,
  downloadUrl: "https://releases.cantrip.art/web/searxng.tar.gz",
  sha256: "a".repeat(64),
  signature: `${"A".repeat(86)}==`,
  signingKeyId: "cantrip-release-2026",
  compressedBytes: 1_024,
  extractedBytes: 4_096,
  licenseManifest: "licenses/manifest.json",
  sourceManifest: "source/manifest.json",
};

describe("managed web runtime contracts", () => {
  it("accepts one signed artifact per component and target", () => {
    expect(
      managedWebRuntimeReleaseManifestSchema.parse({
        schemaVersion: 1,
        channel: "stable",
        publishedAt: "2026-08-26T12:00:00.000Z",
        artifacts: [artifact],
      }).artifacts,
    ).toHaveLength(1);
  });

  it("rejects insecure downloads and duplicate targets", () => {
    expect(() =>
      managedWebRuntimeReleaseManifestSchema.parse({
        schemaVersion: 1,
        channel: "stable",
        publishedAt: "2026-08-26T12:00:00.000Z",
        artifacts: [
          artifact,
          { ...artifact, downloadUrl: "http://example.test/runtime.tar.gz" },
        ],
      }),
    ).toThrow();
  });

  it("bounds progress and keeps failures structured", () => {
    expect(() =>
      managedWebRuntimeStatusSchema.parse({
        component: "searxng",
        supported: true,
        state: "installing",
        installedVersion: null,
        previousVersion: null,
        latestVersion: "2026.8.1",
        lastCheckedAt: "2026-08-26T12:00:00.000Z",
        progress: {
          phase: "download",
          completedBytes: 2,
          totalBytes: 1,
          updatedAt: "2026-08-26T12:00:00.000Z",
        },
        failure: null,
      }),
    ).toThrow(/progress cannot exceed/u);
  });

  it("requires statuses to match their advertised capability", () => {
    expect(() =>
      managedWebRuntimeCapabilitiesSchema.parse({
        ...unavailableManagedWebRuntimeCapabilities,
        search: {
          ...unavailableManagedWebRuntimeCapabilities.search,
          component: "playwright",
        },
      }),
    ).toThrow(/Search runtime status/u);
  });

  it("limits profile cleanup to the managed browser runtime", () => {
    expect(
      managedWebRuntimeActionRequestSchema.parse({
        component: "playwright",
        action: "clear-profiles",
      }),
    ).toEqual({ component: "playwright", action: "clear-profiles" });
    expect(() =>
      managedWebRuntimeActionRequestSchema.parse({
        component: "searxng",
        action: "clear-profiles",
      }),
    ).toThrow(/browser runtime/u);
  });
});
